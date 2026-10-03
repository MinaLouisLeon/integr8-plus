import type { WorkOrderState } from '@integr8/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformDataSource, withTenant } from '../connection.js';
import type { WorkOrder } from '../repositories/work-orders.js';
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
 * Running a working day from the phone (migration 0013), against a real database:
 * when things happened, before and after photos, the customer's sign-off, shifts,
 * push devices, and the jobs queued for a crew to hear about changes.
 */

const DISPATCHER = '00000000-0000-4000-8000-00000000d301';
const ENGINEER = '00000000-0000-4000-8000-00000000e301';
const COLLEAGUE = '00000000-0000-4000-8000-00000000e302';

let northwind: TenantFixture;
let owner: pg.Client;
let app: pg.Client;
let customerId: string;
let siteId: string;
let jobTypeId: string;

const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(northwind.id, fn);

const newJob = () =>
  inTenant((tx) =>
    tx.workOrders.create(
      { customerId, siteId, jobTypeId, crew: [{ userId: ENGINEER, lead: true }] },
      DISPATCHER,
    ),
  );

async function moveTo(job: WorkOrder, path: WorkOrderState[]): Promise<WorkOrder> {
  let current = job;
  for (const to of path) {
    const result = await inTenant((tx) =>
      tx.workOrders.transition(current.id, current.revision, to, ENGINEER),
    );
    if (result.outcome !== 'written') {
      throw new Error(`setup: ${current.state} → ${to}: ${result.outcome}`);
    }
    current = result.workOrder;
  }
  return current;
}

async function storedFile(): Promise<string> {
  const id = crypto.randomUUID();
  await inTenant((tx) =>
    tx.files.createIntent({
      id,
      bucket: `local-${northwind.id}`,
      storageKey: `media/${id}`,
      contentType: 'image/jpeg',
      declaredBytes: 1000,
      category: 'image',
      createdBy: ENGINEER,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    }),
  );
  await inTenant((tx) =>
    tx.files.confirm(id, { byteSize: 1000, etag: '"x"', contentType: 'image/jpeg' }),
  );
  return id;
}

const photo = async (job: WorkOrder, stage: 'before' | 'after') =>
  inTenant(async (tx) =>
    tx.attachments.add(
      { workOrderId: job.id },
      { fileId: await storedFile(), title: `${stage} photo`, kind: 'photo', stage },
      ENGINEER,
    ),
  );

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  northwind = await createTenant('northwind');
  owner = await connectAsOwner();
  app = await connectAsApp();
  await getPlatformDataSource().storage.record({
    tenantId: northwind.id,
    provider: 'local',
    bucket: `local-${northwind.id}`,
  });
  await inTenant(async (tx) => {
    for (const userId of [DISPATCHER, ENGINEER, COLLEAGUE]) {
      await tx.tenantUsers.create({
        userId,
        email: `${userId.slice(-4)}@northwind.example`,
        displayName: userId.slice(-4),
        role: userId === DISPATCHER ? 'dispatcher' : 'engineer',
      });
    }
    const customer = await tx.customers.create({ name: 'Riverside Housing' }, DISPATCHER);
    customerId = customer.id;
    siteId = (
      await tx.sites.create(
        customerId,
        { name: 'Block A', address: { line1: '1 River Road' } },
        DISPATCHER,
      )
    ).id;
    jobTypeId = (
      await tx.jobTypes.create(
        {
          name: 'Boiler service',
          code: 'boiler',
          beforePhotos: 1,
          afterPhotos: 2,
          signatureRequired: true,
        },
        DISPATCHER,
      )
    ).id;
  });
});

afterAll(async () => {
  await owner.end();
  await app.end();
  await releaseTestDatabase();
});

describe('when a change happened', () => {
  it('stamps a change made offline with when the phone recorded it, within bounds', async () => {
    const job = await moveTo(await newJob(), ['dispatched']);
    // The phone recorded setting off a moment after dispatch, and synced later.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const travelled = new Date(job.stateChangedAt.getTime() + 500);
    const result = await inTenant((tx) =>
      tx.workOrders.transition(job.id, job.revision, 'travelling', ENGINEER, undefined, {
        happenedAt: travelled,
      }),
    );
    expect(result.outcome).toBe('written');
    const moved = (result as { workOrder: WorkOrder }).workOrder;
    expect(moved.stateChangedAt.getTime()).toBe(travelled.getTime());

    // A claim before the previous change, or in the future, is kept within bounds.
    const back = await inTenant((tx) =>
      tx.workOrders.transition(moved.id, moved.revision, 'on_site', ENGINEER, undefined, {
        happenedAt: new Date(job.stateChangedAt.getTime() - 60 * 60 * 1000),
      }),
    );
    const arrived = (back as { workOrder: WorkOrder }).workOrder;
    expect(arrived.stateChangedAt.getTime()).toBe(travelled.getTime());
    const future = await inTenant((tx) =>
      tx.workOrders.transition(arrived.id, arrived.revision, 'in_progress', ENGINEER, undefined, {
        happenedAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }),
    );
    expect(
      (future as { workOrder: WorkOrder }).workOrder.stateChangedAt.getTime(),
    ).toBeLessThanOrEqual(Date.now() + 1000);

    // The history says when it happened, and when the server learned of it.
    const events = await inTenant((tx) => tx.workOrders.listEvents(job.id));
    const toTravelling = events.find((event) => event.toState === 'travelling')!;
    expect(toTravelling.occurredAt.getTime()).toBe(travelled.getTime());
    expect(toTravelling.recordedAt.getTime()).toBeGreaterThan(travelled.getTime() + 900);
  });
});

describe('completing a job', () => {
  it('copies photos and sign-off from the job type, and refuses completion until both are there', async () => {
    const job = await moveTo(await newJob(), ['dispatched', 'on_site', 'in_progress']);
    expect(job).toMatchObject({
      beforePhotos: 1,
      afterPhotos: 2,
      signatureRequired: true,
      signoff: null,
    });

    const refused = await inTenant((tx) =>
      tx.workOrders.transition(job.id, job.revision, 'complete', ENGINEER),
    );
    expect(refused).toMatchObject({
      outcome: 'incomplete',
      missing: { forms: [], beforePhotos: 1, afterPhotos: 2, signoff: true },
    });
    // Below the repository too, for every client.
    for (const client of [app, owner]) {
      const write = () =>
        client.query(`update work_orders set state = 'complete', last_actor = $1 where id = $2`, [
          ENGINEER,
          job.id,
        ]);
      await expect(client === app ? asTenant(app, northwind.id, write) : write()).rejects.toThrow(
        /photos missing \(before 0 of 1, after 0 of 2\)/u,
      );
    }

    await photo(job, 'before');
    await photo(job, 'after');
    const removed = await photo(job, 'after');
    await inTenant((tx) => tx.attachments.remove(removed.id, ENGINEER));
    expect(await inTenant((tx) => tx.workOrders.photoCounts(job.id))).toEqual({
      before: 1,
      after: 1,
    });
    await photo(job, 'after');

    await expect(
      asTenant(app, northwind.id, () =>
        app.query(`update work_orders set state = 'complete', last_actor = $1 where id = $2`, [
          ENGINEER,
          job.id,
        ]),
      ),
    ).rejects.toThrow(/customer has not signed off/u);

    const signature = await storedFile();
    const signedAt = new Date(Date.now() - 5 * 60 * 1000);
    const signed = await inTenant((tx) =>
      tx.workOrders.signOff(
        job.id,
        { fileId: signature, name: 'Mrs Patel', role: 'Tenant', signedAt },
        ENGINEER,
      ),
    );
    expect(signed).toMatchObject({
      outcome: 'written',
      workOrder: { signoff: { fileId: signature, name: 'Mrs Patel', role: 'Tenant', signedAt } },
    });
    const current = (signed as { workOrder: WorkOrder }).workOrder;

    const done = await inTenant((tx) =>
      tx.workOrders.transition(current.id, current.revision, 'complete', ENGINEER),
    );
    expect(done.outcome).toBe('written');

    // Once complete, the sign-off is part of the job.
    expect(
      await inTenant((tx) =>
        tx.workOrders.signOff(
          job.id,
          { unavailableReason: 'Changed my mind', signedAt: new Date() },
          ENGINEER,
        ),
      ),
    ).toEqual({ outcome: 'closed' });
    await expect(
      owner.query(
        `update work_orders set signoff_name = 'Someone else', last_actor = $1 where id = $2`,
        [ENGINEER, job.id],
      ),
    ).rejects.toThrow(/reopen it before changing it/u);

    const events = await inTenant((tx) => tx.workOrders.listEvents(job.id));
    expect(events.find((event) => event.kind === 'signed_off')).toMatchObject({
      actorId: ENGINEER,
      details: { name: 'Mrs Patel', role: 'Tenant' },
      occurredAt: signedAt,
    });
  });

  it('accepts why nobody could sign instead, and refuses a sign-off that is neither', async () => {
    const job = await newJob();
    expect(
      await inTenant((tx) =>
        tx.workOrders.signOff(
          job.id,
          { unavailableReason: 'Tenant not home', signedAt: new Date() },
          ENGINEER,
        ),
      ),
    ).toMatchObject({
      outcome: 'written',
      workOrder: { signoff: { unavailableReason: 'Tenant not home', fileId: null } },
    });
    await expect(
      owner.query(
        `update work_orders set signoff_file_id = null, signoff_unavailable_reason = null, last_actor = $1 where id = $2`,
        [ENGINEER, job.id],
      ),
    ).rejects.toThrow(/work_orders_signoff_shape/u);
  });

  it('refuses a stage on anything but a job photo', async () => {
    const job = await newJob();
    await expect(
      inTenant(async (tx) =>
        tx.attachments.add(
          { siteId },
          { fileId: await storedFile(), title: 'Plan', kind: 'site_plan', stage: 'before' },
          ENGINEER,
        ),
      ),
    ).rejects.toThrow(/attachments_stage_is_job_photo/u);
    expect(job.id).toBeDefined();
  });
});

describe('shifts', () => {
  it('keeps one open shift each, and a resend changes nothing', async () => {
    const id = crypto.randomUUID();
    const startedAt = new Date(Date.now() - 8 * 60 * 60 * 1000);
    const location = {
      status: 'captured' as const,
      latitude: '53.800700',
      longitude: '-1.549100',
      accuracyMeters: '12.0',
      capturedAt: startedAt.toISOString(),
    };
    expect(
      await inTenant((tx) => tx.shifts.clockIn({ id, userId: ENGINEER, startedAt, location })),
    ).toMatchObject({ outcome: 'started', shift: { id, startedAt, startLocation: location } });
    expect(
      await inTenant((tx) => tx.shifts.clockIn({ id, userId: ENGINEER, startedAt, location })),
    ).toMatchObject({ outcome: 'already' });
    expect(
      await inTenant((tx) =>
        tx.shifts.clockIn({
          id: crypto.randomUUID(),
          userId: ENGINEER,
          startedAt: new Date(),
          location: null,
        }),
      ),
    ).toMatchObject({ outcome: 'open_elsewhere', open: { id } });
    expect(
      await inTenant((tx) =>
        tx.shifts.clockIn({ id, userId: COLLEAGUE, startedAt, location: null }),
      ),
    ).toEqual({ outcome: 'not_yours' });
    await expect(
      owner.query(
        `insert into shifts (id, tenant_id, user_id, started_at) values ($1, $2, $3, now())`,
        [crypto.randomUUID(), northwind.id, ENGINEER],
      ),
    ).rejects.toThrow(/shifts_one_open_per_person/u);

    expect(
      await inTenant((tx) =>
        tx.shifts.clockOut({
          id,
          userId: ENGINEER,
          endedAt: new Date(startedAt.getTime() - 1),
          location: null,
        }),
      ),
    ).toMatchObject({ outcome: 'before_start' });
    const endedAt = new Date();
    expect(
      await inTenant((tx) =>
        tx.shifts.clockOut({ id, userId: ENGINEER, endedAt, location: { status: 'denied' } }),
      ),
    ).toMatchObject({ outcome: 'ended', shift: { endedAt, endLocation: { status: 'denied' } } });
    expect(
      await inTenant((tx) =>
        tx.shifts.clockOut({ id, userId: ENGINEER, endedAt: new Date(), location: null }),
      ),
    ).toMatchObject({ outcome: 'already', shift: { endedAt } });

    // An ended shift is fixed, whoever writes.
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(`update shifts set ended_at = now() where id = $1`, [id]),
      ),
    ).rejects.toThrow(/has ended/u);
    const listed = await inTenant((tx) =>
      tx.shifts.list({
        from: new Date(Date.now() - 24 * 60 * 60 * 1000),
        to: new Date(),
        userId: ENGINEER,
      }),
    );
    expect(listed.map((shift) => shift.id)).toContain(id);
  });
});

describe('push devices', () => {
  it('moves a token to whoever signs in, and never sends on a revoked session', async () => {
    const session = async (userId: string) =>
      inTenant((tx) =>
        tx.sessions.create({
          userId,
          clientApp: 'mobile',
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }),
      );
    const token = 'ExponentPushToken[abcdefghijklmnop]';
    const first = await session(ENGINEER);
    await inTenant((tx) =>
      tx.pushDevices.register({
        userId: ENGINEER,
        sessionId: first.id,
        token,
        platform: 'android',
        deviceLabel: null,
      }),
    );
    expect(
      (await inTenant((tx) => tx.pushDevices.activeFor([ENGINEER]))).map((d) => d.token),
    ).toEqual([token]);

    const second = await session(COLLEAGUE);
    await inTenant((tx) =>
      tx.pushDevices.register({
        userId: COLLEAGUE,
        sessionId: second.id,
        token,
        platform: 'android',
        deviceLabel: 'Pixel',
      }),
    );
    expect(await inTenant((tx) => tx.pushDevices.activeFor([ENGINEER]))).toEqual([]);
    expect(await inTenant((tx) => tx.pushDevices.activeFor([COLLEAGUE]))).toHaveLength(1);

    await owner.query(
      `update sessions set revoked_at = now(), revoked_reason = 'revoked_by_admin' where id = $1`,
      [second.id],
    );
    expect(await inTenant((tx) => tx.pushDevices.activeFor([COLLEAGUE]))).toEqual([]);

    await expect(
      owner.query(
        `insert into push_devices (tenant_id, user_id, session_id, token, platform) values ($1, $2, $3, 'not a token', 'ios')`,
        [northwind.id, ENGINEER, first.id],
      ),
    ).rejects.toThrow(/push_devices_token_shape/u);
    expect(await inTenant((tx) => tx.pushDevices.disable(token, 'not_registered'))).toBe(true);
  });

  it('queues a notification job for an assignment, a reschedule and a priority change, and not for a note', async () => {
    const queued = async () =>
      Number(
        (
          await owner.query<{ n: string }>(
            `select count(*) as n from jobs where tenant_id = $1 and queue = 'push.work_order_event'`,
            [northwind.id],
          )
        ).rows[0]!.n,
      );
    const before = await queued();
    const job = await newJob();
    const assigned = await queued();
    expect(assigned).toBe(before + 1);

    const rescheduled = await inTenant((tx) =>
      tx.workOrders.update(
        job.id,
        job.revision,
        { dueBy: new Date(Date.now() + 86_400_000) },
        DISPATCHER,
      ),
    );
    expect(await queued()).toBe(assigned + 1);
    const current = (rescheduled as { workOrder: WorkOrder }).workOrder;
    await inTenant((tx) =>
      tx.workOrders.update(current.id, current.revision, { priority: 'urgent' }, DISPATCHER),
    );
    expect(await queued()).toBe(assigned + 2);

    await inTenant((tx) =>
      tx.workOrders.addComment(job.id, { body: 'Note', visibility: 'internal' }, DISPATCHER),
    );
    expect(await queued()).toBe(assigned + 2);
  });
});
