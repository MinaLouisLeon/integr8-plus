import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PushResult } from '../api-types.js';
import { applySnapshot } from '../snapshot.js';
import { customerDetail, me, uuid, workOrderDetail } from '../testing/fixtures.js';
import { openTestDatabase } from '../testing/node-driver.js';
import { measureOffset, serverNow } from './clock.js';
import { uuidv7 } from './ids.js';
import {
  applyPushResults,
  backoffSeconds,
  type ChangeContext,
  markBatchUnanswered,
  queueUpload,
  recordAnswers,
  recordComment,
  recordFormStarted,
  recordSubmit,
  recordTransition,
  selectBatch,
} from './outbox.js';

const NOW = new Date('2026-09-14T12:00:00.000Z');
const random = (length: number) => new Uint8Array(randomBytes(length));

/** A phone holding two jobs, with a clock the test moves by hand. */
async function phone() {
  const { db } = await openTestDatabase();
  const customer = customerDetail();
  const jobs = [workOrderDetail(customer), workOrderDetail(customer)] as const;
  await db.write(['work_orders'], (sql) =>
    applySnapshot(sql, { me: me(), workOrders: [...jobs], customers: [customer], forms: [] }, NOW),
  );
  const clock = { current: NOW, now: () => clock.current };
  const context: ChangeContext = { db, clock, random };
  const batch = () => db.read((sql) => selectBatch(sql, clock.current));
  const answer = (results: PushResult[]) =>
    db.write(['outbox', 'submissions', 'meta', 'work_orders'], async (sql) => {
      const { rows } = await selectBatch(sql, clock.current);
      return applyPushResults(sql, rows, results, clock.current);
    });
  return { db, clock, context, jobs, batch, answer };
}

const applied = (id: string, revision: number | null = 1): PushResult => ({
  id,
  outcome: 'applied',
  replayed: false,
  alreadyApplied: false,
  revision,
  answers: null,
});

describe('change ids', () => {
  it('are version 7 UUIDs that sort by the time they were made', () => {
    const earlier = uuidv7(NOW.getTime(), random);
    const later = uuidv7(NOW.getTime() + 1, random);
    expect(earlier).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(earlier < later).toBe(true);
    expect(earlier.slice(0, 13)).toBe(uuidv7(NOW.getTime(), random).slice(0, 13));
    expect(uuidv7(NOW.getTime(), random)).not.toBe(earlier);
  });
});

describe('backoff and clocks', () => {
  it('doubles from five seconds to half an hour, and waits longer if the server asks', () => {
    expect([1, 2, 3, 4].map((attempts) => backoffSeconds(attempts))).toEqual([5, 10, 20, 40]);
    expect(backoffSeconds(20)).toBe(30 * 60);
    expect(backoffSeconds(1, 120)).toBe(120);
  });

  it('measures the offset at the middle of the request', () => {
    const sent = new Date('2026-09-14T12:00:00.000Z');
    const received = new Date('2026-09-14T12:00:02.000Z');
    // The phone is three hours slow: the server answered at its 15:00:01.
    const offset = measureOffset('2026-09-14T15:00:01.000Z', sent, received);
    expect(offset).toBe(3 * 60 * 60 * 1000);
    expect(serverNow(received, offset).toISOString()).toBe('2026-09-14T15:00:02.000Z');
  });
});

describe('choosing what to send', () => {
  it('sends changes in the order they were made, holding back a record behind one waiting to retry', async () => {
    const { context, jobs, batch, answer, clock } = await phone();
    const [first, second] = jobs;
    const moved = await recordTransition(context, {
      workOrderId: first.workOrder.id,
      to: 'travelling',
    });
    const { mutationId: noted } = await recordComment(context, {
      workOrderId: first.workOrder.id,
      body: 'Gate was locked',
      visibility: 'internal',
    });
    const { mutationId: other } = await recordComment(context, {
      workOrderId: second.workOrder.id,
      body: 'Fine',
      visibility: 'internal',
    });
    expect((await batch()).mutations.map((mutation) => mutation.id)).toEqual([moved, noted, other]);

    await answer([
      {
        id: moved,
        outcome: 'retry',
        replayed: false,
        code: 'unavailable',
        message: 'Try later',
        retryAfterSeconds: 60,
      },
      {
        id: noted,
        outcome: 'retry',
        replayed: false,
        code: 'blocked',
        message: 'Behind an earlier change',
        retryAfterSeconds: 0,
      },
      applied(other),
    ] as PushResult[]);

    // The first job's move is waiting a minute, and its note waits behind it.
    expect((await batch()).mutations).toEqual([]);
    clock.current = new Date(NOW.getTime() + 61_000);
    expect((await batch()).mutations.map((mutation) => mutation.id)).toEqual([moved, noted]);
  });

  it('keeps a failed change and everything after it on the same job for the engineer', async () => {
    const { context, jobs, batch, answer } = await phone();
    const [first] = jobs;
    const moved = await recordTransition(context, {
      workOrderId: first.workOrder.id,
      to: 'travelling',
    });
    await recordComment(context, {
      workOrderId: first.workOrder.id,
      body: 'After',
      visibility: 'internal',
    });
    await answer([
      {
        id: moved,
        outcome: 'rejected',
        replayed: false,
        code: 'transition_not_allowed',
        message: 'No',
        details: [],
      },
    ]);
    expect((await batch()).mutations).toEqual([]);
  });

  it('counts a server error as an attempt, but not a missing connection', async () => {
    const { db, context, jobs, batch, clock } = await phone();
    await recordComment(context, {
      workOrderId: jobs[0].workOrder.id,
      body: 'Hello',
      visibility: 'internal',
    });
    const { rows } = await batch();
    await db.write(['outbox'], (sql) => markBatchUnanswered(sql, rows, clock.current, 'offline'));
    expect((await batch()).rows[0]?.attempts).toBe(0);
    await db.write(['outbox'], (sql) =>
      markBatchUnanswered(sql, rows, clock.current, 'server_error'),
    );
    expect((await batch()).rows).toEqual([]);
    clock.current = new Date(NOW.getTime() + 5_000);
    expect((await batch()).rows[0]?.attempts).toBe(1);
  });
});

describe('forms', () => {
  it('folds autosaves that have not left into one, and sends answers only once the form exists', async () => {
    const { db, context, jobs, batch, answer } = await phone();
    const { mutationId: started, submissionId } = await recordFormStarted(context, {
      formId: uuid(),
      formVersionId: uuid(),
      workOrderId: jobs[0].workOrder.id,
    });
    const saved = await recordAnswers(context, { submissionId, answers: { note: 'a' } });
    expect(await recordAnswers(context, { submissionId, answers: { note: 'ab' } })).toBe(saved);

    // Answers are merged against what the server holds, which is known only after the start.
    expect((await batch()).mutations.map((mutation) => mutation.id)).toEqual([started]);
    await answer([applied(started, 1)]);
    const [answers] = (await batch()).mutations;
    expect(answers).toMatchObject({
      id: saved,
      payload: { answers: { note: 'ab' } },
      base: { revision: 1, answers: {} },
    });
    expect(
      await db.read((sql) => sql.all(`select id from outbox where kind = 'submission.answers'`)),
    ).toHaveLength(1);
  });

  it('holds a submission until every file it names has arrived', async () => {
    const { db, context, jobs, batch, answer } = await phone();
    const { mutationId: started, submissionId } = await recordFormStarted(context, {
      formId: uuid(),
      formVersionId: uuid(),
      workOrderId: jobs[0].workOrder.id,
    });
    await answer([applied(started, 1)]);
    const mediaId = await queueUpload(context, {
      localPath: '/photo.jpg',
      contentType: 'image/jpeg',
      byteSize: 1000,
      workOrderId: jobs[0].workOrder.id,
    });
    await recordAnswers(context, { submissionId, answers: { note: 'draft' } });
    const submitted = await recordSubmit(context, {
      submissionId,
      answers: { note: 'final', photo: [{ mediaId, contentType: 'image/jpeg', byteSize: 1000 }] },
      filledOn: '2026-09-14',
    });

    // The unsent autosave was replaced by the submit, which waits for the photo.
    expect((await batch()).mutations).toEqual([]);
    await db.write(['uploads'], (sql) =>
      sql.run(`update uploads set state = 'confirmed' where media_id = ?`, [mediaId]),
    );
    expect((await batch()).mutations.map((mutation) => mutation.id)).toEqual([submitted]);
  });
});
