import { describe, expect, it } from 'vitest';
import {
  type Announcement,
  announcements,
  announcementText,
  dismissAnnouncement,
  mayCorrectAccess,
  saveAccess,
} from './access.js';
import { applySnapshot } from './snapshot.js';
import { customerDetail, me, siteBody, uuid, workOrderDetail } from './testing/fixtures.js';
import { openTestDatabase } from './testing/node-driver.js';

const NOW = new Date('2026-10-31T09:00:00.000Z');

function announcement(overrides: Partial<Announcement> = {}): Announcement {
  return {
    id: uuid(),
    severity: 'warning',
    message: { en: 'Payment is overdue.', ar: 'الدفع متأخر.' },
    dismissible: true,
    startsAt: '2026-10-30T09:00:00.000Z',
    endsAt: null,
    ...overrides,
  };
}

async function phone(workOrders: Parameters<typeof applySnapshot>[1]['workOrders'] = []) {
  const { db } = await openTestDatabase();
  const customer = customerDetail();
  await db.write(['work_orders'], (sql) =>
    applySnapshot(sql, { me: me(), workOrders, customers: [customer], forms: [] }, NOW),
  );
  return { db, customer };
}

describe('announcements on the phone', () => {
  it('keeps the last ones heard, drops those that have ended, and hides a dismissed one', async () => {
    const { db } = await phone();
    const reminder = announcement();
    const ended = announcement({ endsAt: '2026-10-31T08:00:00.000Z' });
    const pinned = announcement({ severity: 'critical', dismissible: false });
    await db.write(['meta'], (sql) =>
      saveAccess(sql, { permissions: [], features: {}, announcements: [reminder, ended, pinned] }),
    );

    // Offline, an hour later: the ended one is gone by the phone's own clock.
    expect((await db.read((sql) => announcements(sql, NOW))).map((one) => one.id)).toEqual([
      reminder.id,
      pinned.id,
    ]);

    await db.write(['meta'], (sql) => dismissAnnouncement(sql, reminder.id));
    await db.write(['meta'], (sql) => dismissAnnouncement(sql, pinned.id));
    // One that cannot be dismissed stays, whatever the phone recorded.
    expect((await db.read((sql) => announcements(sql, NOW))).map((one) => one.id)).toEqual([
      pinned.id,
    ]);
  });

  it('forgets a dismissal once the server stops sending that announcement', async () => {
    const { db } = await phone();
    const reminder = announcement();
    await db.write(['meta'], (sql) =>
      saveAccess(sql, { permissions: [], features: {}, announcements: [reminder] }),
    );
    await db.write(['meta'], (sql) => dismissAnnouncement(sql, reminder.id));
    await db.write(['meta'], (sql) =>
      saveAccess(sql, { permissions: [], features: {}, announcements: [] }),
    );
    const dismissed = await db.read((sql) =>
      sql.get<{ value: string }>(`select value from meta where key = 'announcements_dismissed'`),
    );
    expect(JSON.parse(dismissed!.value)).toEqual([]);
  });

  it('keeps the announcements when an answer without them saves permissions', async () => {
    const { db } = await phone();
    const reminder = announcement();
    await db.write(['meta'], (sql) =>
      saveAccess(sql, { permissions: [], features: {}, announcements: [reminder] }),
    );
    await db.write(['meta'], (sql) =>
      saveAccess(sql, { permissions: ['work_order.progress'], features: {} }),
    );
    expect(await db.read((sql) => announcements(sql, NOW))).toHaveLength(1);
  });

  it('is said in the phone’s language, else English, else whatever it has', () => {
    const both = announcement();
    expect(announcementText(both, 'ar')).toBe('الدفع متأخر.');
    expect(announcementText(both, 'fr')).toBe('Payment is overdue.');
    expect(announcementText(announcement({ message: { ar: 'صيانة الليلة' } }), 'en')).toBe(
      'صيانة الليلة',
    );
  });
});

describe('correcting access notes from the phone', () => {
  it('is offered on the crew of an open job at the site, and not once every job there has closed', async () => {
    const customer = customerDetail();
    const site = customer.sites[0]!;
    const open = workOrderDetail(customer, { state: 'on_site' });
    const { db } = await openTestDatabase();
    await db.write(['work_orders'], (sql) =>
      applySnapshot(sql, { me: me(), workOrders: [open], customers: [customer], forms: [] }, NOW),
    );
    await db.write(['meta'], (sql) =>
      saveAccess(sql, { permissions: ['work_order.progress'], features: {} }),
    );
    expect(await db.read((sql) => mayCorrectAccess(sql, site.id))).toBe(true);

    const closed = workOrderDetail(customer, {
      state: 'complete',
      completedAt: '2026-10-30T15:00:00.000Z',
    });
    await db.write(['work_orders'], (sql) =>
      applySnapshot(sql, { me: me(), workOrders: [closed], customers: [customer], forms: [] }, NOW),
    );
    expect(await db.read((sql) => mayCorrectAccess(sql, site.id))).toBe(false);
  });

  it('is not offered on a job somebody else is working, nor without the right to work jobs', async () => {
    const customer = customerDetail();
    const site = customer.sites[0]!;
    const theirs = workOrderDetail(customer, { state: 'dispatched' });
    theirs.crew = [
      { id: uuid(), name: 'Cara', lead: true, assignedAt: theirs.workOrder.createdAt },
    ];
    const { db } = await openTestDatabase();
    await db.write(['work_orders'], (sql) =>
      applySnapshot(sql, { me: me(), workOrders: [theirs], customers: [customer], forms: [] }, NOW),
    );
    await db.write(['meta'], (sql) =>
      saveAccess(sql, { permissions: ['work_order.progress'], features: {} }),
    );
    expect(await db.read((sql) => mayCorrectAccess(sql, site.id))).toBe(false);

    await db.write(['meta'], (sql) => saveAccess(sql, { permissions: [], features: {} }));
    expect(await db.read((sql) => mayCorrectAccess(sql, site.id))).toBe(false);
  });

  it('is offered to the office at any site', async () => {
    const customer = customerDetail({ sites: [] });
    const other = siteBody(customer.customer.id);
    const { db } = await phone();
    await db.write(['meta'], (sql) =>
      saveAccess(sql, { permissions: ['customer.manage'], features: {} }),
    );
    expect(await db.read((sql) => mayCorrectAccess(sql, other.id))).toBe(true);
  });
});
