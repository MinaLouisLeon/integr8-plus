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
  changesNeedingAttention,
  discardChange,
  markBatchUnanswered,
  markSent,
  queueUpload,
  recordAccessChange,
  recordAnswers,
  recordComment,
  recordFormStarted,
  recordSubmit,
  recordTransition,
  retryChange,
  selectBatch,
} from './outbox.js';

const NOW = new Date('2026-09-14T12:00:00.000Z');
const random = (length: number) => new Uint8Array(randomBytes(length));

/** A phone holding two dispatched jobs and one being worked, with a clock the test moves by hand. */
async function phone() {
  const { db } = await openTestDatabase();
  const customer = customerDetail();
  const jobs = [workOrderDetail(customer), workOrderDetail(customer)] as const;
  const working = workOrderDetail(customer, { state: 'in_progress' });
  await db.write(['work_orders'], (sql) =>
    applySnapshot(
      sql,
      { me: me(), workOrders: [...jobs, working], customers: [customer], forms: [] },
      NOW,
    ),
  );
  const clock = { current: NOW, now: () => clock.current };
  const context: ChangeContext = { db, clock, random };
  const batch = () => db.read((sql) => selectBatch(sql, clock.current));
  const answer = (results: PushResult[]) =>
    db.write(['outbox', 'submissions', 'meta', 'work_orders'], async (sql) => {
      const { rows } = await selectBatch(sql, clock.current);
      return applyPushResults(sql, rows, results, clock.current);
    });
  return { db, clock, context, jobs, working, customer, batch, answer };
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

describe('a form changed on two devices', () => {
  it('takes on the answers the server merged, keeping what was typed here since', async () => {
    const { db, context, jobs, batch, answer, clock } = await phone();
    const { mutationId: started, submissionId } = await recordFormStarted(context, {
      formId: uuid(),
      formVersionId: uuid(),
      workOrderId: jobs[0].workOrder.id,
    });
    await answer([applied(started, 1)]);
    const sent = await recordAnswers(context, {
      submissionId,
      answers: { note: 'Started', pressure: 18 },
    });
    // On the wire; and while it is, the engineer keeps typing.
    await db.write(['outbox'], async (sql) => {
      const { rows } = await selectBatch(sql, clock.current);
      await markSent(sql, rows, clock.current);
    });
    const later = await recordAnswers(context, {
      submissionId,
      answers: { note: 'Started', pressure: 20 },
    });
    expect(later).not.toBe(sent);

    // The server had another device's customer name, and merged the two.
    await answer([
      {
        id: sent,
        outcome: 'applied',
        replayed: false,
        alreadyApplied: false,
        revision: 2,
        answers: { note: 'Started', pressure: 18, customer_name: 'Pat' },
      },
    ]);

    const local = await db.read((sql) =>
      sql.get<{ answers: string; server_answers: string }>(
        'select answers, server_answers from submissions where id = ?',
        [submissionId],
      ),
    );
    expect(JSON.parse(local!.answers)).toEqual({
      note: 'Started',
      pressure: 20,
      customer_name: 'Pat',
    });
    expect(JSON.parse(local!.server_answers)).toEqual({
      note: 'Started',
      pressure: 18,
      customer_name: 'Pat',
    });
    // The autosave still to go carries the merge too, so it cannot undo it.
    const [next] = (await batch()).mutations;
    expect(next).toMatchObject({
      id: later,
      payload: { answers: { note: 'Started', pressure: 20, customer_name: 'Pat' } },
      base: { revision: 2, answers: { note: 'Started', pressure: 18, customer_name: 'Pat' } },
    });
  });
});

describe('a submit the server refuses', () => {
  it('is a draft again on the phone, with its answers, until the engineer drops it and the draft goes on', async () => {
    const { db, context, jobs, batch, answer } = await phone();
    const { mutationId: started, submissionId } = await recordFormStarted(context, {
      formId: uuid(),
      formVersionId: uuid(),
      workOrderId: jobs[0].workOrder.id,
    });
    await answer([applied(started, 1)]);
    const submitted = await recordSubmit(context, {
      submissionId,
      answers: { note: 'Done' },
      filledOn: '2020-01-01',
    });
    const local = () =>
      db.read((sql) =>
        sql.get<{ status: string; answers: string; submitted_at: string | null }>(
          'select status, answers, submitted_at from submissions where id = ?',
          [submissionId],
        ),
      );
    expect(await local()).toMatchObject({ status: 'submitted' });

    await answer([
      {
        id: submitted,
        outcome: 'rejected',
        replayed: false,
        code: 'today_out_of_range',
        message: 'The date the form was filled is not today.',
      },
    ] as PushResult[]);
    expect(await local()).toEqual({
      status: 'draft',
      answers: '{"note":"Done"}',
      submitted_at: null,
    });
    expect(await db.read(changesNeedingAttention)).toMatchObject([
      { id: submitted, state: 'failed', lastError: { code: 'today_out_of_range' } },
    ]);
    // Editable again: an autosave is taken, and waits behind the refused submit.
    await recordAnswers(context, { submissionId, answers: { note: 'Done', pressure: 21 } });
    expect((await batch()).mutations).toEqual([]);

    // Dropping the submit keeps the answers as the draft, which goes to the server.
    await discardChange(context, submitted);
    expect(await db.read(changesNeedingAttention)).toEqual([]);
    expect(await local()).toMatchObject({
      status: 'draft',
      answers: '{"note":"Done","pressure":21}',
    });
    const { mutations } = await batch();
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({
      kind: 'submission.answers',
      payload: { answers: { note: 'Done', pressure: 21 } },
      base: { revision: 1, answers: {} },
    });
  });

  it('keeps a correction a correction when its submit is refused', async () => {
    const { db, context, jobs, answer } = await phone();
    const { mutationId: started, submissionId } = await recordFormStarted(context, {
      formId: uuid(),
      formVersionId: uuid(),
      workOrderId: jobs[0].workOrder.id,
    });
    await answer([applied(started, 1)]);
    await db.write(['submissions'], (sql) =>
      sql.run(`update submissions set status = 'reopened' where id = ?`, [submissionId]),
    );
    const submitted = await recordSubmit(context, {
      submissionId,
      answers: { note: 'Corrected' },
      filledOn: '2026-09-14',
      reason: 'Wrong reading',
    });
    await answer([
      { id: submitted, outcome: 'rejected', replayed: false, code: 'forbidden', message: 'No.' },
    ] as PushResult[]);
    expect(
      await db.read((sql) =>
        sql.get('select status from submissions where id = ?', [submissionId]),
      ),
    ).toEqual({ status: 'reopened' });
  });
});

describe('what a completion waits for', () => {
  it('follows a change it waited for when that change is sent again under a new id', async () => {
    const { context, working, batch, answer } = await phone();
    const { mutationId: started, submissionId } = await recordFormStarted(context, {
      formId: uuid(),
      formVersionId: uuid(),
      workOrderId: working.workOrder.id,
    });
    await answer([applied(started, 1)]);
    const submitted = await recordSubmit(context, {
      submissionId,
      answers: { note: 'final' },
      filledOn: '2026-09-14',
    });
    const completed = await recordTransition(context, {
      workOrderId: working.workOrder.id,
      to: 'complete',
    });
    expect((await batch()).mutations.map((mutation) => mutation.id)).toEqual([submitted]);

    // The office changed the form; the submit is refused and the engineer
    // sends it again. Resending gives it a new id.
    await answer([
      {
        id: submitted,
        outcome: 'rejected',
        replayed: false,
        code: 'transition_not_allowed',
        message: 'No',
        details: [],
      },
    ]);
    expect((await batch()).mutations).toEqual([]);
    const again = await retryChange(context, submitted);
    expect(again).not.toBe(submitted);

    // The completion waits for the new id, not for one nothing will ever carry.
    expect((await batch()).mutations.map((mutation) => mutation.id)).toEqual([again]);
    await answer([applied(again, 2)]);
    expect((await batch()).mutations.map((mutation) => mutation.id)).toEqual([completed]);
  });

  it('goes once an autosave it waited for has been replaced by the submit', async () => {
    const { context, working, batch, answer } = await phone();
    const { mutationId: started, submissionId } = await recordFormStarted(context, {
      formId: uuid(),
      formVersionId: uuid(),
      workOrderId: working.workOrder.id,
    });
    await answer([applied(started, 1)]);
    await recordAnswers(context, { submissionId, answers: { note: 'draft' } });
    const completed = await recordTransition(context, {
      workOrderId: working.workOrder.id,
      to: 'complete',
    });
    expect((await batch()).mutations.map((mutation) => mutation.id)).not.toContain(completed);

    // The submit deletes the unsent autosave the completion was waiting for.
    const submitted = await recordSubmit(context, {
      submissionId,
      answers: { note: 'final' },
      filledOn: '2026-09-14',
    });
    const ids = (await batch()).mutations.map((mutation) => mutation.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(submitted);
    expect(ids).toContain(completed);
  });
});

describe('access notes', () => {
  it('folds unsent corrections into one change, but never into one already on the wire', async () => {
    const { db, context, customer, clock, batch } = await phone();
    const siteId = customer.sites[0]!.id;
    const first = await recordAccessChange(context, { siteId, changes: { gateCode: '1111#' } });

    // The engine hands the batch to the network and marks it sent in the same
    // write. A correction made now must become a change of its own, or the
    // answer to the first change would mark it done without it ever leaving.
    const { rows } = await batch();
    await db.write(['outbox'], (sql) => markSent(sql, rows, clock.current));
    const second = await recordAccessChange(context, { siteId, changes: { parking: 'Rear' } });
    expect(second).not.toBe(first);

    // One that has not left still folds.
    const third = await recordAccessChange(context, { siteId, changes: { hazards: 'Dog' } });
    expect(third).toBe(second);
  });
});
