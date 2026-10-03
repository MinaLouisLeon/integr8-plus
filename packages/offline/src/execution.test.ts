import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PullPage } from './api-types.js';
import { currentShift, localCompletion, timesOnJob } from './execution.js';
import { job as localJob } from './queries.js';
import { applySnapshot } from './snapshot.js';
import { attachmentsToFetch, fetchAttachment } from './sync/downloads.js';
import {
  applyPushResults,
  LocalChangeError,
  markSent,
  recordPhoto,
  recordPhotoRemoved,
  recordShiftEnd,
  recordShiftStart,
  recordSignoff,
  recordTransition,
  selectBatch,
} from './sync/outbox.js';
import { pullChanges } from './sync/pull.js';
import type { SyncApi } from './sync/transport.js';
import { customerDetail, me, uuid, workOrderDetail } from './testing/fixtures.js';
import { openTestDatabase } from './testing/node-driver.js';

const random = (length: number) => new Uint8Array(randomBytes(length));
const file = (name: string) => ({
  localPath: `captures/${name}.jpg`,
  thumbnailPath: `captures/${name}.thumb.jpg`,
  contentType: 'image/jpeg',
  byteSize: 500_000,
});

async function phone(overrides: Parameters<typeof workOrderDetail>[1] = {}) {
  const { db } = await openTestDatabase();
  const customer = customerDetail();
  const detail = workOrderDetail(customer, {
    state: 'dispatched',
    beforePhotos: 1,
    afterPhotos: 2,
    signatureRequired: true,
    ...overrides,
  });
  await db.write(['work_orders'], (sql) =>
    applySnapshot(
      sql,
      { me: me(), workOrders: [detail], customers: [customer], forms: [] },
      new Date('2026-09-15T07:00:00.000Z'),
    ),
  );
  const clock = { current: new Date('2026-09-15T08:00:00.000Z'), now: () => clock.current };
  const later = (minutes: number) => {
    clock.current = new Date(clock.current.getTime() + minutes * 60_000);
  };
  return { db, detail, context: { db, clock, random }, clock, later, jobId: detail.workOrder.id };
}

describe('the working day on the phone', () => {
  it('clocks in once, clocks out, and queues both in order', async () => {
    const { db, context, later } = await phone();
    const shiftId = await recordShiftStart(context, { location: { status: 'denied' } });
    await expect(recordShiftStart(context, { location: null })).rejects.toBeInstanceOf(
      LocalChangeError,
    );
    expect(await db.read(currentShift)).toMatchObject({ id: shiftId, endedAt: null });

    later(8 * 60);
    await recordShiftEnd(context, { shiftId, location: null });
    expect(await db.read(currentShift)).toBeUndefined();
    const batch = await db.read((sql) => selectBatch(sql, context.clock.now()));
    // One record, so the server applies the start before the end.
    expect(batch.mutations.map((mutation) => mutation.kind)).toEqual(['shift.start', 'shift.end']);
    expect(batch.mutations[0]).toMatchObject({
      entityId: shiftId,
      payload: { startedAt: '2026-09-15T08:00:00.000Z', location: { status: 'denied' } },
    });
  });

  it('counts time on the job from the phone’s own record of each change', async () => {
    const { db, context, later, jobId } = await phone();
    await recordTransition(context, { workOrderId: jobId, to: 'travelling' });
    later(25);
    await recordTransition(context, { workOrderId: jobId, to: 'on_site' });
    later(5);
    await recordTransition(context, { workOrderId: jobId, to: 'in_progress' });
    later(40);
    const detail = (await db.read((sql) => localJob(sql, jobId)))!.detail;
    const times = timesOnJob(detail, context.clock.now());
    expect(times).toMatchObject({
      travelMs: 25 * 60_000,
      onSiteMs: 5 * 60_000,
      workMs: 40 * 60_000,
    });
  });
});

describe('completing a job on the phone', () => {
  it('says what is missing, shows photos and sign-off at once, and makes completion wait for them', async () => {
    const { db, context, jobId } = await phone({ state: 'in_progress' });
    expect((await db.read((sql) => localCompletion(sql, jobId)))?.missing).toEqual({
      forms: [],
      beforePhotos: 1,
      afterPhotos: 2,
      signoff: true,
    });

    const before = await recordPhoto(context, {
      workOrderId: jobId,
      stage: 'before',
      file: file('b'),
    });
    await recordPhoto(context, { workOrderId: jobId, stage: 'after', file: file('a1') });
    const mistake = await recordPhoto(context, {
      workOrderId: jobId,
      stage: 'after',
      file: file('a2'),
    });
    // Taken back before it left: dropped, with its upload.
    expect(
      await recordPhotoRemoved(context, { workOrderId: jobId, attachmentId: mistake.attachmentId }),
    ).toEqual(['captures/a2.jpg', 'captures/a2.thumb.jpg']);
    await recordPhoto(context, { workOrderId: jobId, stage: 'after', file: file('a3') });
    const signoff = await recordSignoff(context, {
      workOrderId: jobId,
      signoff: { signature: file('sig'), name: ' Mrs Patel ', role: '' },
    });

    const completion = await db.read((sql) => localCompletion(sql, jobId));
    expect(completion).toEqual({
      photos: { before: 1, after: 2 },
      missing: { forms: [], beforePhotos: 0, afterPhotos: 0, signoff: false },
    });
    const shown = (await db.read((sql) => localJob(sql, jobId)))!.detail;
    expect(shown.execution.signoff).toMatchObject({ name: 'Mrs Patel', role: null });
    expect(shown.attachments.map((attachment) => attachment.stage)).toEqual([
      'after',
      'after',
      'before',
    ]);

    await recordTransition(context, { workOrderId: jobId, to: 'complete' });
    const outbox = await db.read((sql) =>
      sql.all<{ id: string; kind: string; waits_for: string }>(
        'select id, kind, waits_for from outbox order by seq',
      ),
    );
    const complete = outbox.find((row) => row.kind === 'work_order.transition')!;
    const waits = JSON.parse(complete.waits_for) as { mutations: string[] };
    expect(waits.mutations).toHaveLength(4);
    expect(waits.mutations).toContain(signoff);
    // Nothing goes before its file has: every photo and the signature wait for uploads.
    const batch = await db.read((sql) => selectBatch(sql, context.clock.now()));
    expect(batch.mutations).toEqual([]);

    // A photo the server already has is removed there instead.
    await db.write(['outbox', 'uploads'], async (sql) => {
      await sql.run(`update uploads set state = 'confirmed'`);
      const sending = await selectBatch(sql, context.clock.now());
      await markSent(sql, sending.rows, context.clock.now());
      await applyPushResults(
        sql,
        sending.rows,
        sending.rows.map((row) => ({
          id: row.id,
          outcome: 'applied' as const,
          replayed: false,
          alreadyApplied: false,
          revision: null,
          answers: null,
        })),
        context.clock.now(),
      );
    });
    expect(
      await recordPhotoRemoved(context, { workOrderId: jobId, attachmentId: before.attachmentId }),
    ).toEqual([]);
    const removal = await db.read((sql) =>
      sql.get<{ kind: string }>(`select kind from outbox where kind = 'work_order.photo_remove'`),
    );
    expect(removal).toBeDefined();
  });
});

describe('syncing the day', () => {
  it('keeps the phone’s unsent shift over the server’s, and fetches attachments of open jobs', async () => {
    const { db, context, jobId, detail } = await phone();
    const shiftId = await recordShiftStart(context, { location: null });
    const siteplan = uuid();
    const withPlan = {
      ...detail,
      attachments: [
        {
          id: uuid(),
          fileId: siteplan,
          title: 'Site plan',
          kind: 'site_plan' as const,
          stage: null,
          contentType: 'application/pdf',
          byteSize: 120_000,
          addedBy: { id: uuid(), name: 'Office' },
          createdAt: '2026-09-14T09:00:00.000Z',
        },
      ],
    };
    const page: PullPage = {
      reset: true,
      cursor: 'v1.10',
      page: null,
      serverTime: '2026-09-15T08:00:00.000Z',
      workOrders: [withPlan],
      removedWorkOrderIds: [],
      customers: [],
      forms: [],
      submissions: [],
      shifts: [
        {
          id: shiftId,
          userId: uuid(),
          startedAt: '2026-09-15T07:00:00.000Z',
          endedAt: '2026-09-15T07:30:00.000Z',
          startLocation: null,
          endLocation: null,
        },
      ],
    };
    const downloads: string[] = [];
    const api = {
      me: () => Promise.resolve(me()),
      pull: () => Promise.resolve(page),
      mediaLink: (fileId: string) => Promise.resolve({ url: `https://files/${fileId}` }),
    } as unknown as SyncApi;
    await pullChanges(db, api, context.clock, {
      closedJobDays: 30,
      downloadedFileBytes: 500 * 1024 * 1024,
    });
    expect(await db.read(currentShift)).toMatchObject({ id: shiftId, endedAt: null });

    const wanted = await attachmentsToFetch(db);
    expect(wanted).toEqual([
      expect.objectContaining({ fileId: siteplan, workOrderId: jobId, title: 'Site plan' }),
    ]);
    const transport = {
      put: () => Promise.resolve({ status: 200 }),
      download: (url: string, path: string) => {
        downloads.push(`${url} -> ${path}`);
        return Promise.resolve({ status: 200 });
      },
    };
    expect(await fetchAttachment(db, api, transport, wanted[0]!, context.clock.now())).toBe(true);
    expect(downloads).toEqual([`https://files/${siteplan} -> attachments/${siteplan}`]);
    expect(await attachmentsToFetch(db)).toEqual([]);
  });
});
