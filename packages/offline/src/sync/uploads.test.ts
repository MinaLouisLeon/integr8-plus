import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PushResult } from '../api-types.js';
import { applySnapshot } from '../snapshot.js';
import { customerDetail, me, uuid, workOrderDetail } from '../testing/fixtures.js';
import { openTestDatabase } from '../testing/node-driver.js';
import {
  applyPushResults,
  type ChangeContext,
  changesNeedingAttention,
  jobSyncState,
  MAX_ATTEMPTS,
  queueUpload,
  recordFormStarted,
  recordPhoto,
  recordSubmit,
  retryChange,
  selectBatch,
  UPLOAD_FAILED,
} from './outbox.js';
import type { ByteTransport, FileSource, SyncApi } from './transport.js';
import { dueUploads, retryUpload, uploadOne } from './uploads.js';

const NOW = new Date('2026-09-14T12:00:00.000Z');
const random = (length: number) => new Uint8Array(randomBytes(length));

/** A phone on one job, with a form started on the server already. */
async function phone() {
  const { db } = await openTestDatabase();
  const customer = customerDetail();
  const job = workOrderDetail(customer, { state: 'in_progress' });
  await db.write(['work_orders'], (sql) =>
    applySnapshot(sql, { me: me(), workOrders: [job], customers: [customer], forms: [] }, NOW),
  );
  const clock = { current: NOW, now: () => clock.current };
  const context: ChangeContext = { db, clock, random };
  const batch = () => db.read((sql) => selectBatch(sql, clock.current));
  const answer = (results: PushResult[]) =>
    db.write(['outbox', 'submissions', 'meta', 'work_orders'], async (sql) => {
      const { rows } = await selectBatch(sql, clock.current);
      return applyPushResults(sql, rows, results, clock.current);
    });
  const { mutationId: started, submissionId } = await recordFormStarted(context, {
    formId: uuid(),
    formVersionId: uuid(),
    workOrderId: job.workOrder.id,
  });
  await answer([
    {
      id: started,
      outcome: 'applied',
      replayed: false,
      alreadyApplied: false,
      revision: 1,
      answers: null,
    },
  ]);
  return { db, clock, context, job, submissionId, batch };
}

/** A submit naming one photo, which waits for that photo's upload. */
async function submitWithPhoto(context: ChangeContext, submissionId: string, workOrderId: string) {
  const mediaId = await queueUpload(context, {
    localPath: 'captures/photo.jpg',
    contentType: 'image/jpeg',
    byteSize: 1000,
    workOrderId,
  });
  const submitted = await recordSubmit(context, {
    submissionId,
    answers: { photo: [{ mediaId, contentType: 'image/jpeg', byteSize: 1000 }] },
    filledOn: '2026-09-14',
  });
  return { mediaId, submitted };
}

const gone: FileSource = {
  exists: () => Promise.resolve(false),
  read: () => Promise.reject(new Error('The file is gone.')),
};
const present: FileSource = {
  exists: () => Promise.resolve(true),
  read: (_path, _offset, length) => Promise.resolve(new Uint8Array(length)),
};
const untouched = {
  prepareUpload: () => Promise.reject(new Error('The server was not meant to be asked.')),
} as unknown as SyncApi;
const singleLink = {
  prepareUpload: () =>
    Promise.resolve({ upload: { kind: 'single', url: 'https://storage.test/part', headers: {} } }),
} as unknown as SyncApi;
const refusing: ByteTransport = {
  put: () => Promise.resolve({ status: 503 }),
  download: () => Promise.resolve({ status: 503 }),
};

const uploadRow = async (context: ChangeContext, mediaId: string) =>
  (await dueUploads(context.db, context.clock.now())).find((row) => row.mediaId === mediaId)!;

describe('a file that will never upload', () => {
  it('fails the changes waiting for it, so they ask for attention instead of waiting for ever', async () => {
    const { db, context, job, submissionId, clock, batch } = await phone();
    const { mediaId, submitted } = await submitWithPhoto(context, submissionId, job.workOrder.id);
    // An after photo of the job waits for a file of its own, and is not involved.
    await recordPhoto(context, {
      workOrderId: job.workOrder.id,
      stage: 'after',
      file: { localPath: 'captures/after.jpg', contentType: 'image/jpeg', byteSize: 2000 },
    });

    expect(
      await uploadOne(db, untouched, gone, refusing, clock, await uploadRow(context, mediaId)),
    ).toMatchObject({ outcome: 'failed', code: 'file_missing' });

    const [stranded] = await db.read(changesNeedingAttention);
    expect(stranded).toMatchObject({
      id: submitted,
      kind: 'submission.submit',
      state: 'failed',
      lastError: { code: UPLOAD_FAILED, details: { mediaId, code: 'file_missing' } },
    });
    expect(
      await db.read((sql) => sql.get(`select state from outbox where kind = 'work_order.photo'`)),
    ).toEqual({ state: 'pending' });
    // The job says so: the failed file and the submit it stranded, and the after photo still on its way.
    expect(await db.read((sql) => jobSyncState(sql, job.workOrder.id))).toEqual({
      safeToLeave: false,
      pendingChanges: 1,
      pendingUploads: 1,
      needsAttention: 2,
    });
    expect((await batch()).mutations).toEqual([]);

    // Trying the file again puts the submit back to waiting for it.
    await retryUpload(db, mediaId);
    expect(await db.read(changesNeedingAttention)).toEqual([]);
    expect(
      await db.read((sql) =>
        sql.get('select state, attempts, last_error from outbox where id = ?', [submitted]),
      ),
    ).toEqual({ state: 'pending', attempts: 0, last_error: null });
    expect((await dueUploads(db, clock.current)).map((row) => row.mediaId)).toContain(mediaId);
  });

  it('gives up after ten attempts, and trying the change again tries its file again', async () => {
    const { db, context, job, submissionId, clock } = await phone();
    const { mediaId, submitted } = await submitWithPhoto(context, submissionId, job.workOrder.id);
    // Nine attempts behind it already; storage refuses once more.
    await db.write(['uploads'], (sql) =>
      sql.run('update uploads set attempts = ? where media_id = ?', [MAX_ATTEMPTS - 1, mediaId]),
    );
    expect(
      await uploadOne(db, singleLink, present, refusing, clock, await uploadRow(context, mediaId)),
    ).toMatchObject({ outcome: 'retry', code: 'storage_503' });
    expect(
      await db.read((sql) => sql.get('select state from uploads where media_id = ?', [mediaId])),
    ).toEqual({ state: 'failed' });
    const [stranded] = await db.read(changesNeedingAttention);
    expect(stranded).toMatchObject({
      id: submitted,
      lastError: { code: UPLOAD_FAILED, details: { mediaId, code: 'storage_503' } },
    });

    // "Try again" on the change, from the sync screen: the file gets another go too.
    const reissued = await retryChange(context, submitted);
    expect(reissued).not.toBe(submitted);
    expect(await db.read(changesNeedingAttention)).toEqual([]);
    expect(
      await db.read((sql) =>
        sql.get('select state, attempts, last_error from uploads where media_id = ?', [mediaId]),
      ),
    ).toEqual({ state: 'queued', attempts: 0, last_error: null });
  });
});
