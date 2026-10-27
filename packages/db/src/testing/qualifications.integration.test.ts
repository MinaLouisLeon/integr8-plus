import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../connection.js';
import type {
  MemberQualification,
  MemberQualificationWrite,
  QualificationType,
  QualificationTypeWrite,
} from '../repositories/qualifications.js';
import {
  asTenant,
  connectAsApp,
  connectAsOwner,
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
} from './harness.js';

/**
 * Skills and certificates (migration 0052), against a real database.
 *
 * The rules that hold for every client are proven here: a skill never expires,
 * a removed record is final, an archived type takes no new records, the
 * expiry alerts reset when the dates change, a new job copies its type's
 * requirements, and an override is append-only and written into the job's
 * history.
 */

const MANAGER = '00000000-0000-4000-8000-00000000d301';
const AHMED = '00000000-0000-4000-8000-00000000e301';
const SARA = '00000000-0000-4000-8000-00000000e302';

let northwind: TenantFixture;
let contoso: TenantFixture;
let owner: pg.Client;
let app: pg.Client;
let customerId: string;
let siteId: string;
let jobTypeId: string;

const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(northwind.id, fn);

function typeOf(result: QualificationTypeWrite): QualificationType {
  if (result.outcome !== 'written') {
    throw new Error(`expected a written type, got ${result.outcome}`);
  }
  return result.type;
}

function recordOf(result: MemberQualificationWrite): MemberQualification {
  if (result.outcome !== 'written') {
    throw new Error(`expected a written record, got ${result.outcome}`);
  }
  return result.record;
}

const newType = (name: string, kind: 'skill' | 'certificate' = 'certificate') =>
  inTenant(async (tx) => typeOf(await tx.qualifications.createType({ name, kind }, MANAGER)));

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  northwind = await createTenant('northwind');
  contoso = await createTenant('contoso');
  owner = await connectAsOwner();
  app = await connectAsApp();

  await withTenant(northwind.id, async (tx) => {
    for (const userId of [MANAGER, AHMED, SARA]) {
      await tx.tenantUsers.create({
        userId,
        email: `${userId.slice(-4)}@${northwind.slug}.example`,
        displayName: userId.slice(-4),
        role: userId === MANAGER ? 'admin' : 'engineer',
      });
    }
    const customer = await tx.customers.create({ name: 'Riverside Housing' }, MANAGER);
    customerId = customer.id;
    siteId = (
      await tx.sites.create(
        customerId,
        { name: 'Block A', address: { line1: '1 River Road', city: 'Leeds', countryCode: 'gb' } },
        MANAGER,
      )
    ).id;
    jobTypeId = (await tx.jobTypes.create({ name: 'Electrical inspection', code: 'eicr' }, MANAGER))
      .id;
  });
  await withTenant(contoso.id, (tx) =>
    tx.tenantUsers.create({
      userId: MANAGER,
      email: `d301@${contoso.slug}.example`,
      displayName: 'd301',
      role: 'admin',
    }),
  );
});

afterAll(async () => {
  await owner.end();
  await app.end();
  await releaseTestDatabase();
});

describe('the company list', () => {
  it('refuses a second live type of the same name, whatever its case', async () => {
    await newType('Gas Safe');
    const again = await inTenant((tx) =>
      tx.qualifications.createType({ name: '  gas safe ', kind: 'certificate' }, MANAGER),
    );
    expect(again.outcome).toBe('name_taken');
  });

  it('keeps a type’s kind', async () => {
    const type = await newType('Working at height');
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(`update qualification_types set kind = 'skill' where id = $1`, [type.id]),
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('counts versions and refuses a stale write', async () => {
    const type = await newType('Asbestos awareness');
    const renamed = typeOf(
      await inTenant((tx) =>
        tx.qualifications.updateType(type.id, type.version, { name: 'Asbestos (UKATA)' }),
      ),
    );
    expect(renamed.version).toBe(type.version + 1);
    const stale = await inTenant((tx) =>
      tx.qualifications.updateType(type.id, type.version, { description: 'late' }),
    );
    expect(stale.outcome).toBe('conflict');
  });

  it('is invisible to another company', async () => {
    await newType('Fire alarms');
    const theirs = await withTenant(contoso.id, (tx) => tx.qualifications.listTypes());
    expect(theirs).toEqual([]);
  });
});

describe('what people hold', () => {
  it('records a certificate with its dates, read back as calendar days', async () => {
    const type = await newType('18th Edition');
    const record = recordOf(
      await inTenant((tx) =>
        tx.qualifications.addRecord(
          {
            userId: AHMED,
            qualificationTypeId: type.id,
            reference: ' C-1234 ',
            issuedOn: '2025-01-15',
            expiresOn: '2028-01-14',
          },
          MANAGER,
        ),
      ),
    );
    expect(record).toMatchObject({
      reference: 'C-1234',
      issuedOn: '2025-01-15',
      expiresOn: '2028-01-14',
      version: 1,
      removedAt: null,
    });
  });

  it('refuses an expiry on a skill, in the repository and in the database', async () => {
    const skill = await newType('Boiler fault finding', 'skill');
    const result = await inTenant((tx) =>
      tx.qualifications.addRecord(
        { userId: AHMED, qualificationTypeId: skill.id, expiresOn: '2027-01-01' },
        MANAGER,
      ),
    );
    expect(result.outcome).toBe('skill_expires');
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(
          `insert into member_qualifications (tenant_id, user_id, qualification_type_id, expires_on, created_by)
           values ($1, $2, $3, '2027-01-01', $4)`,
          [northwind.id, AHMED, skill.id, MANAGER],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses an expiry before the issue date', async () => {
    const type = await newType('First aid');
    const result = await inTenant((tx) =>
      tx.qualifications.addRecord(
        {
          userId: AHMED,
          qualificationTypeId: type.id,
          issuedOn: '2026-05-01',
          expiresOn: '2026-04-01',
        },
        MANAGER,
      ),
    );
    expect(result.outcome).toBe('dates_reversed');
  });

  it('takes no new records of an archived type', async () => {
    const type = await newType('Legacy scheme');
    await inTenant((tx) => tx.qualifications.updateType(type.id, type.version, { archived: true }));
    const result = await inTenant((tx) =>
      tx.qualifications.addRecord({ userId: AHMED, qualificationTypeId: type.id }, MANAGER),
    );
    expect(result.outcome).toBe('type_archived');
  });

  it('keeps a removed record, and refuses changing it', async () => {
    const type = await newType('PASMA');
    const record = recordOf(
      await inTenant((tx) =>
        tx.qualifications.addRecord(
          { userId: SARA, qualificationTypeId: type.id, expiresOn: '2027-06-30' },
          MANAGER,
        ),
      ),
    );
    const removed = await inTenant((tx) =>
      tx.qualifications.removeRecord(record.id, record.version, MANAGER),
    );
    expect(removed.outcome).toBe('written');
    const again = await inTenant((tx) =>
      tx.qualifications.updateRecord(record.id, record.version + 1, { notes: 'too late' }),
    );
    expect(again.outcome).toBe('removed');
    const listed = await inTenant((tx) =>
      tx.qualifications.listRecords({ userIds: [SARA], includeRemoved: true }),
    );
    expect(listed.find((entry) => entry.id === record.id)?.removedBy).toBe(MANAGER);
  });
});

describe('expiry alerts', () => {
  it('finds certificates due a warning or lapsed, once each, and again after new dates', async () => {
    const type = await newType('IPAF');
    const soon = recordOf(
      await inTenant((tx) =>
        tx.qualifications.addRecord(
          { userId: AHMED, qualificationTypeId: type.id, expiresOn: '2026-11-10' },
          MANAGER,
        ),
      ),
    );

    const due = await inTenant((tx) =>
      tx.qualifications.dueExpiryAlerts('2026-10-27', '2026-11-26'),
    );
    expect(due.alerts.map((alert) => [alert.record.id, alert.stage])).toContainEqual([
      soon.id,
      'warning',
    ]);

    await inTenant((tx) => tx.qualifications.markAlerted([soon.id], 'warning'));
    const after = await inTenant((tx) =>
      tx.qualifications.dueExpiryAlerts('2026-10-27', '2026-11-26'),
    );
    expect(after.alerts.some((alert) => alert.record.id === soon.id)).toBe(false);

    const lapsed = await inTenant((tx) =>
      tx.qualifications.dueExpiryAlerts('2026-11-11', '2026-12-11'),
    );
    expect(lapsed.alerts.find((alert) => alert.record.id === soon.id)?.stage).toBe('lapsed');

    const current = await inTenant((tx) => tx.qualifications.findRecord(soon.id));
    await inTenant((tx) =>
      tx.qualifications.updateRecord(soon.id, current!.version, { expiresOn: '2026-11-20' }),
    );
    const reset = await inTenant((tx) =>
      tx.qualifications.dueExpiryAlerts('2026-10-27', '2026-11-26'),
    );
    expect(reset.alerts.some((alert) => alert.record.id === soon.id)).toBe(true);
  });

  it('does not alert about a certificate already renewed', async () => {
    const type = await newType('CSCS');
    const old = recordOf(
      await inTenant((tx) =>
        tx.qualifications.addRecord(
          { userId: SARA, qualificationTypeId: type.id, expiresOn: '2026-11-01' },
          MANAGER,
        ),
      ),
    );
    await inTenant((tx) =>
      tx.qualifications.addRecord(
        {
          userId: SARA,
          qualificationTypeId: type.id,
          issuedOn: '2026-10-20',
          expiresOn: '2031-10-19',
        },
        MANAGER,
      ),
    );
    const due = await inTenant((tx) =>
      tx.qualifications.dueExpiryAlerts('2026-10-27', '2026-11-26'),
    );
    expect(due.alerts.some((alert) => alert.record.id === old.id)).toBe(false);
    expect(due.renewed).toContainEqual({ id: old.id, stage: 'warning' });
  });
});

describe('what jobs need', () => {
  it('copies the job type’s current requirements onto a new job, and lets the job change its own', async () => {
    const electrical = await newType('Inspection and testing');
    const archived = await newType('Old scheme');
    await inTenant((tx) =>
      tx.qualifications.setJobTypeRequirements(jobTypeId, [electrical.id, archived.id], MANAGER),
    );
    await inTenant((tx) =>
      tx.qualifications.updateType(archived.id, archived.version, { archived: true }),
    );

    const job = await inTenant((tx) =>
      tx.workOrders.create({ customerId, siteId, jobTypeId }, MANAGER),
    );
    const copied = await inTenant((tx) => tx.qualifications.workOrderRequirements([job.id]));
    expect(copied.get(job.id)).toEqual([
      { qualificationTypeId: electrical.id, name: 'Inspection and testing' },
    ]);

    await inTenant((tx) => tx.qualifications.setWorkOrderRequirements(job.id, [], MANAGER));
    const cleared = await inTenant((tx) => tx.qualifications.workOrderRequirements([job.id]));
    expect(cleared.get(job.id)).toBeUndefined();

    // The job type keeps its list; only that job changed.
    const typeList = await inTenant((tx) => tx.qualifications.jobTypeRequirements([jobTypeId]));
    expect(typeList.get(jobTypeId)).toHaveLength(2);
  });

  it('records an override in the job’s history, and keeps it unchangeable', async () => {
    const electrical = await newType('Periodic inspection');
    const job = await inTenant((tx) =>
      tx.workOrders.create(
        { customerId, siteId, jobTypeId, crew: [{ userId: AHMED, lead: true }] },
        MANAGER,
      ),
    );
    const visit = await inTenant(async (tx) => {
      const result = await tx.visits.create(
        {
          workOrderId: job.id,
          startsAt: new Date('2026-11-02T08:00:00Z'),
          endsAt: new Date('2026-11-02T10:00:00Z'),
          assigneeIds: [AHMED],
        },
        MANAGER,
      );
      if (result.outcome !== 'written') {
        throw new Error(result.outcome);
      }
      return result.visit;
    });

    const override = await inTenant((tx) =>
      tx.qualifications.recordOverride(
        {
          workOrderId: job.id,
          visitId: visit.id,
          reason: 'Renewal booked; supervised by Sara',
          missing: [{ qualificationTypeId: electrical.id, name: 'Periodic inspection' }],
          assigneeIds: [AHMED],
          startsAt: visit.startsAt,
          endsAt: visit.endsAt,
        },
        MANAGER,
      ),
    );
    expect(override.missing).toEqual([
      { qualificationTypeId: electrical.id, name: 'Periodic inspection' },
    ]);

    const history = await inTenant((tx) => tx.workOrders.listEvents(job.id));
    const event = history.find((entry) => entry.kind === 'qualification_override');
    expect(event).toMatchObject({ reason: 'Renewal booked; supervised by Sara', actorId: MANAGER });
    expect(event?.details).toMatchObject({ visitId: visit.id, assigneeIds: [AHMED] });

    await expect(
      asTenant(app, northwind.id, () =>
        app.query(`update work_order_qualification_overrides set reason = 'x' where id = $1`, [
          override.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(`delete from work_order_qualification_overrides where id = $1`, [override.id]),
      ),
    ).rejects.toBeTruthy();
  });
});
