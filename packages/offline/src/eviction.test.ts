import { describe, expect, it } from 'vitest';
import { evict, RETENTION } from './eviction.js';
import { applySnapshot } from './snapshot.js';
import {
  customerDetail,
  formDetail,
  insertDraft,
  insertFile,
  me,
  workOrderDetail,
} from './testing/fixtures.js';
import { openTestDatabase } from './testing/node-driver.js';

const NOW = new Date('2026-09-14T12:00:00.000Z');
const MB = 1024 * 1024;

async function phoneWith(...details: ReturnType<typeof workOrderDetail>[]) {
  const { db } = await openTestDatabase();
  const customers = [...new Map(details.map((d) => [d.customer.id, d])).values()];
  await db.write(['work_orders'], (sql) =>
    applySnapshot(
      sql,
      {
        me: me(),
        workOrders: details,
        customers: customers.map((detail) => customerOf.get(detail.customer.id)!),
        forms: [],
      },
      NOW,
    ),
  );
  return db;
}

const customerOf = new Map<string, ReturnType<typeof customerDetail>>();
function newCustomer(name: string) {
  const detail = customerDetail({ name });
  customerOf.set(detail.customer.id, detail);
  return detail;
}

const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();

describe('closed jobs', () => {
  it('keeps open jobs and jobs closed in the last 30 days, and evicts older ones', async () => {
    const riverside = newCustomer('Riverside Housing');
    const open = workOrderDetail(riverside, { dueBy: '2025-01-01T09:00:00.000Z' });
    const recent = workOrderDetail(riverside, {
      state: 'complete',
      completedAt: '2026-08-20T09:00:00.000Z',
    });
    const old = workOrderDetail(riverside, {
      state: 'cancelled',
      cancelledAt: '2026-08-10T09:00:00.000Z',
    });
    const db = await phoneWith(open, recent, old);

    const outcome = await db.write(['work_orders'], (sql) => evict(sql, NOW));

    expect(outcome.workOrders).toBe(1);
    expect(
      ids(await db.read((sql) => sql.all<{ id: string }>('select id from work_orders'))),
    ).toEqual(ids([open.workOrder, recent.workOrder]));
  });

  it('never evicts a job, however old, that unsent work points at — nor what that work needs', async () => {
    const riverside = newCustomer('Riverside Housing');
    const gas = formDetail();
    const old = workOrderDetail(riverside, {
      state: 'complete',
      completedAt: '2025-01-01T09:00:00.000Z',
      formIds: [gas.form.id],
    });
    const photoOnly = workOrderDetail(newCustomer('Harbour Flats'), {
      state: 'complete',
      completedAt: '2025-01-01T09:00:00.000Z',
    });
    const db = await phoneWith(old, photoOnly);
    await db.write(['drafts', 'files', 'forms'], async (sql) => {
      await applySnapshot(
        sql,
        { me: me(), workOrders: [old, photoOnly], customers: [], forms: [gas] },
        NOW,
      );
      await insertDraft(sql, {
        formId: gas.form.id,
        formVersionId: gas.live!.id,
        workOrderId: old.workOrder.id,
      });
      await insertFile(sql, {
        ownerKind: 'work_order',
        ownerId: photoOnly.workOrder.id,
        state: 'pending_upload',
        byteSize: 5 * MB,
      });
    });

    const outcome = await db.write(['work_orders'], (sql) => evict(sql, NOW));

    expect(outcome).toMatchObject({ workOrders: 0, customers: 0, formVersions: 0, filePaths: [] });
    expect(await db.read((sql) => sql.all('select id from form_versions'))).toEqual([
      { id: gas.live!.id },
    ]);
  });
});

describe('what kept jobs need', () => {
  it('evicts customers, sites and forms no kept job uses any more', async () => {
    const riverside = newCustomer('Riverside Housing');
    const harbour = newCustomer('Harbour Flats');
    const gas = formDetail();
    const survey = formDetail();
    const kept = workOrderDetail(riverside, { formIds: [gas.form.id] });
    const old = workOrderDetail(harbour, {
      state: 'complete',
      completedAt: '2025-01-01T09:00:00.000Z',
      formIds: [survey.form.id],
    });
    const db = await phoneWith(kept, old);
    await db.write(['forms'], (sql) =>
      applySnapshot(
        sql,
        { me: me(), workOrders: [kept, old], customers: [], forms: [gas, survey] },
        NOW,
      ),
    );

    const outcome = await db.write(['work_orders'], (sql) => evict(sql, NOW));

    expect(outcome).toMatchObject({
      workOrders: 1,
      customers: 1,
      sites: 1,
      forms: 1,
      formVersions: 1,
    });
    expect(await db.read((sql) => sql.all('select id from customers'))).toEqual([
      { id: riverside.customer.id },
    ]);
    expect(await db.read((sql) => sql.all('select id from forms'))).toEqual([{ id: gas.form.id }]);
  });
});

describe('downloaded files', () => {
  it('keeps the most recently opened files within the budget and evicts the rest, oldest first', async () => {
    const riverside = newCustomer('Riverside Housing');
    const open = workOrderDetail(riverside);
    const db = await phoneWith(open);
    const file = (id: string, byteSize: number, lastOpenedAt: string) =>
      db.write(['files'], (sql) =>
        insertFile(sql, {
          id,
          ownerKind: 'work_order',
          ownerId: open.workOrder.id,
          state: 'downloaded',
          byteSize,
          lastOpenedAt,
        }),
      );
    await file('newest', 200 * MB, '2026-09-14T09:00:00.000Z');
    await file('middle', 250 * MB, '2026-09-10T09:00:00.000Z');
    await file('older', 100 * MB, '2026-09-01T09:00:00.000Z');
    await file('oldest-but-small', 1 * MB, '2026-08-01T09:00:00.000Z');
    await db.write(['files'], (sql) =>
      insertFile(sql, {
        id: 'unsent',
        ownerKind: 'work_order',
        ownerId: open.workOrder.id,
        state: 'pending_upload',
        byteSize: 900 * MB,
      }),
    );

    const outcome = await db.write(['files'], (sql) => evict(sql, NOW, RETENTION));

    expect(outcome.filePaths.sort()).toEqual(['files/older.jpg', 'files/oldest-but-small.jpg']);
    expect(ids(await db.read((sql) => sql.all<{ id: string }>('select id from files')))).toEqual([
      'middle',
      'newest',
      'unsent',
    ]);
  });

  it('evicts downloaded files whose job has gone, but never a file waiting to upload', async () => {
    const riverside = newCustomer('Riverside Housing');
    const open = workOrderDetail(riverside);
    const db = await phoneWith(open);
    await db.write(['files'], async (sql) => {
      await insertFile(sql, {
        id: 'orphan',
        ownerKind: 'work_order',
        ownerId: 'gone',
        state: 'downloaded',
        byteSize: 1,
      });
      await insertFile(sql, {
        id: 'orphan-unsent',
        ownerKind: 'work_order',
        ownerId: 'gone',
        state: 'pending_upload',
        byteSize: 1,
      });
    });

    const outcome = await db.write(['files'], (sql) => evict(sql, NOW));

    expect(outcome.filePaths).toEqual(['files/orphan.jpg']);
    expect(await db.read((sql) => sql.all('select id from files'))).toEqual([
      { id: 'orphan-unsent' },
    ]);
  });
});
