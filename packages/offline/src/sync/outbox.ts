import { findTransition } from '@integr8/core';
import type {
  AccessValues,
  MutationKind,
  PushMutation,
  PushResult,
  SubmitLocation,
  SyncConflict,
  WorkOrderDetail,
} from '../api-types.js';
import type { LocalDatabase } from '../database.js';
import type { SqlConnection } from '../sql.js';
import type { DeviceClock } from './clock.js';
import { type RandomBytes, uuidv7 } from './ids.js';
import { type Actor, applyToJob, closedAtOf, type LocalChange } from './overlay.js';

/**
 * The outbox: every change made on the phone, durable and in order (P12).
 *
 * A change is written to the phone's own copy of the record and to the outbox
 * **in one transaction**, so the screen shows it at once and it cannot be lost
 * between the two. It then waits for the sync engine, which sends changes in the
 * order they were made and marks each with what the server did:
 *
 * - `pending`  — not yet applied; retried with backoff.
 * - `conflict` — the server holds a different version; the engineer decides.
 * - `failed`   — refused, and sending it again would not help; shown to the engineer.
 * - `done`     — applied.
 *
 * Only `done` lets later changes to the same record through. A job's "completed"
 * never overtakes its "arrived".
 */

export interface ChangeContext {
  db: LocalDatabase;
  clock: DeviceClock;
  random: RandomBytes;
}

export class LocalChangeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LocalChangeError';
  }
}

export type OutboxState = 'pending' | 'conflict' | 'failed' | 'done';

export interface Waits {
  media: string[];
  mutations: string[];
}

export interface OutboxRow {
  seq: number;
  id: string;
  kind: MutationKind;
  entityKey: string;
  entityId: string;
  workOrderId: string | null;
  payload: Record<string, unknown>;
  base: Record<string, unknown> | null;
  waitsFor: Waits;
  recordedAt: string;
  state: OutboxState;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: { code: string; message: string; details?: unknown } | null;
  conflict: SyncConflict | null;
}

interface RawRow {
  seq: number;
  id: string;
  kind: string;
  entity_key: string;
  entity_id: string;
  work_order_id: string | null;
  payload: string;
  base: string | null;
  waits_for: string;
  recorded_at: string;
  state: OutboxState;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  conflict: string | null;
}

function toRow(raw: RawRow): OutboxRow {
  const waits = JSON.parse(raw.waits_for) as Partial<Waits> | unknown[];
  return {
    seq: raw.seq,
    id: raw.id,
    kind: raw.kind as MutationKind,
    entityKey: raw.entity_key,
    entityId: raw.entity_id,
    workOrderId: raw.work_order_id,
    payload: JSON.parse(raw.payload) as Record<string, unknown>,
    base: raw.base === null ? null : (JSON.parse(raw.base) as Record<string, unknown>),
    waitsFor: Array.isArray(waits)
      ? { media: [], mutations: [] }
      : { media: waits.media ?? [], mutations: waits.mutations ?? [] },
    recordedAt: raw.recorded_at,
    state: raw.state,
    attempts: raw.attempts,
    nextAttemptAt: raw.next_attempt_at,
    lastError:
      raw.last_error === null ? null : (JSON.parse(raw.last_error) as OutboxRow['lastError']),
    conflict: raw.conflict === null ? null : (JSON.parse(raw.conflict) as SyncConflict),
  };
}

/** Kinds whose base is filled in when sent, from what the server last confirmed. */
const LAZY_BASE: ReadonlySet<MutationKind> = new Set(['submission.answers', 'submission.submit']);

const OUTBOX_TABLES = [
  'meta',
  'outbox',
  'work_orders',
  'sites',
  'submissions',
  'uploads',
  'files',
] as const;

async function actorOf(sql: SqlConnection): Promise<Actor> {
  const rows = await sql.all<{ key: string; value: string }>(
    `select key, value from meta where key in ('user_id', 'display_name')`,
  );
  const meta = new Map(rows.map((row) => [row.key, row.value]));
  return { id: meta.get('user_id') ?? '', name: meta.get('display_name') ?? '' };
}

async function insertChange(
  sql: SqlConnection,
  change: {
    id: string;
    kind: MutationKind;
    entityKey: string;
    entityId: string;
    workOrderId: string | null;
    payload: unknown;
    base: unknown;
    waitsFor?: Waits;
    at: string;
  },
): Promise<void> {
  await sql.run(
    `insert into outbox (id, kind, entity_key, entity_id, work_order_id, payload, base, waits_for,
                         recorded_at, state, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      change.id,
      change.kind,
      change.entityKey,
      change.entityId,
      change.workOrderId,
      JSON.stringify(change.payload),
      change.base === null || change.base === undefined ? null : JSON.stringify(change.base),
      JSON.stringify(change.waitsFor ?? { media: [], mutations: [] }),
      change.at,
      change.at,
    ],
  );
}

async function jobDetail(sql: SqlConnection, workOrderId: string): Promise<WorkOrderDetail> {
  const row = await sql.get<{ data: string }>('select data from work_orders where id = ?', [
    workOrderId,
  ]);
  if (row === undefined) {
    throw new LocalChangeError('work_order_not_on_phone', 'This job is not on this phone.');
  }
  return JSON.parse(row.data) as WorkOrderDetail;
}

async function writeJob(sql: SqlConnection, detail: WorkOrderDetail): Promise<void> {
  await sql.run('update work_orders set state = ?, closed_at = ?, data = ? where id = ?', [
    detail.workOrder.state,
    closedAtOf(detail),
    JSON.stringify(detail),
    detail.workOrder.id,
  ]);
}

async function applyLocally(
  sql: SqlConnection,
  workOrderId: string,
  change: LocalChange,
  at: string,
): Promise<WorkOrderDetail> {
  const next = applyToJob(await jobDetail(sql, workOrderId), change, await actorOf(sql), at);
  await writeJob(sql, next);
  return next;
}

/** Asks the next sync to fetch this job afresh. */
export async function requestRefresh(
  sql: SqlConnection,
  workOrderId: string | null,
): Promise<void> {
  if (workOrderId === null) {
    return;
  }
  const row = await sql.get<{ value: string }>(
    `select value from meta where key = 'refresh_work_orders'`,
  );
  const ids = new Set(row === undefined ? [] : (JSON.parse(row.value) as string[]));
  ids.add(workOrderId);
  await sql.run(
    `insert into meta (key, value) values ('refresh_work_orders', ?)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify([...ids])],
  );
}

// ---------------------------------------------------------------------------
// Recording changes
// ---------------------------------------------------------------------------

export async function recordTransition(
  context: ChangeContext,
  input: { workOrderId: string; to: WorkOrderDetail['workOrder']['state']; reason?: string },
): Promise<string> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const detail = await jobDetail(sql, input.workOrderId);
    const from = detail.workOrder.state;
    if (findTransition(from, input.to) === undefined) {
      throw new LocalChangeError(
        'transition_not_allowed',
        `A ${from} job cannot move to ${input.to}.`,
      );
    }
    const now = clock.now();
    const at = now.toISOString();
    const id = uuidv7(now.getTime(), random);
    const payload = {
      to: input.to,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    };
    // Completing waits for the job's forms to reach the server first, or the
    // server would refuse it for want of forms that are only on their way.
    const waitsFor: Waits = { media: [], mutations: [] };
    if (input.to === 'complete') {
      const pendingForms = await sql.all<{ id: string }>(
        `select id from outbox where work_order_id = ? and kind like 'submission.%' and state <> 'done'`,
        [input.workOrderId],
      );
      waitsFor.mutations = pendingForms.map((row) => row.id);
    }
    await applyLocally(sql, input.workOrderId, { kind: 'work_order.transition', payload }, at);
    await insertChange(sql, {
      id,
      kind: 'work_order.transition',
      entityKey: `work_order:${input.workOrderId}`,
      entityId: input.workOrderId,
      workOrderId: input.workOrderId,
      payload,
      base: { state: from, revision: detail.workOrder.revision },
      waitsFor,
      at,
    });
    return id;
  });
}

export async function recordChecklist(
  context: ChangeContext,
  input: { workOrderId: string; itemId: string; done: boolean },
): Promise<string> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const detail = await jobDetail(sql, input.workOrderId);
    if (!detail.checklist.some((item) => item.id === input.itemId)) {
      throw new LocalChangeError(
        'checklist_item_unknown',
        'This checklist item is not on the job.',
      );
    }
    const now = clock.now();
    const at = now.toISOString();
    const id = uuidv7(now.getTime(), random);
    const payload = { itemId: input.itemId, done: input.done };
    await applyLocally(sql, input.workOrderId, { kind: 'work_order.checklist', payload }, at);
    await insertChange(sql, {
      id,
      kind: 'work_order.checklist',
      entityKey: `work_order:${input.workOrderId}`,
      entityId: input.workOrderId,
      workOrderId: input.workOrderId,
      payload,
      base: null,
      at,
    });
    return id;
  });
}

export async function recordComment(
  context: ChangeContext,
  input: { workOrderId: string; body: string; visibility: 'internal' | 'customer' },
): Promise<{ mutationId: string; commentId: string }> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const now = clock.now();
    const at = now.toISOString();
    const commentId = uuidv7(now.getTime(), random);
    const mutationId = uuidv7(now.getTime(), random);
    const payload = { commentId, body: input.body.trim(), visibility: input.visibility };
    await applyLocally(sql, input.workOrderId, { kind: 'work_order.comment', payload }, at);
    await insertChange(sql, {
      id: mutationId,
      kind: 'work_order.comment',
      entityKey: `work_order:${input.workOrderId}`,
      entityId: input.workOrderId,
      workOrderId: input.workOrderId,
      payload,
      base: null,
      at,
    });
    return { mutationId, commentId };
  });
}

const ACCESS_COLUMNS = {
  gateCode: 'gate_code',
  parking: 'parking',
  askFor: 'ask_for',
  hazards: 'hazards',
  notes: 'access_notes',
} as const;

export async function recordAccessChange(
  context: ChangeContext,
  input: { siteId: string; changes: AccessValues },
): Promise<string> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const site = await sql.get<{ data: string }>('select data from sites where id = ?', [
      input.siteId,
    ]);
    if (site === undefined) {
      throw new LocalChangeError('site_not_on_phone', 'This site is not on this phone.');
    }
    const body = JSON.parse(site.data) as { access: Record<string, string | null> };
    const fields = (Object.keys(input.changes) as (keyof AccessValues)[]).filter(
      (field) => input.changes[field] !== undefined,
    );
    const now = clock.now();
    const at = now.toISOString();

    // Unsent edits to the same site's notes become one change, keeping what the
    // engineer first saw as its base.
    const earlier = await sql.get<RawRow>(
      `select * from outbox where kind = 'site.access' and entity_id = ? and state = 'pending' and attempts = 0
       order by seq desc limit 1`,
      [input.siteId],
    );
    const base: Record<string, string | null> = {};
    for (const field of fields) {
      base[field] = body.access[field] ?? null;
    }

    body.access = {
      ...body.access,
      ...Object.fromEntries(fields.map((field) => [field, input.changes[field] ?? null])),
    };
    await sql.run(
      `update sites set ${fields.map((field) => `${ACCESS_COLUMNS[field]} = ?`).join(', ')}${fields.length > 0 ? ', ' : ''}data = ? where id = ?`,
      [...fields.map((field) => input.changes[field] ?? null), JSON.stringify(body), input.siteId],
    );
    const jobs = await sql.all<{ id: string }>('select id from work_orders where site_id = ?', [
      input.siteId,
    ]);
    for (const job of jobs) {
      await applyLocally(
        sql,
        job.id,
        { kind: 'site.access', payload: { changes: input.changes } },
        at,
      );
    }

    if (earlier !== undefined) {
      const previous = toRow(earlier);
      const previousBase = (previous.base as { access: Record<string, string | null> }).access;
      const merged = {
        changes: { ...(previous.payload.changes as Record<string, unknown>), ...input.changes },
        base: { access: { ...base, ...previousBase } },
      };
      await sql.run('update outbox set payload = ?, base = ?, recorded_at = ? where seq = ?', [
        JSON.stringify({ changes: merged.changes }),
        JSON.stringify(merged.base),
        at,
        previous.seq,
      ]);
      return previous.id;
    }

    const id = uuidv7(now.getTime(), random);
    await insertChange(sql, {
      id,
      kind: 'site.access',
      entityKey: `site:${input.siteId}`,
      entityId: input.siteId,
      workOrderId: jobs[0]?.id ?? null,
      payload: { changes: input.changes },
      base: { access: base },
      at,
    });
    return id;
  });
}

export async function recordFormStarted(
  context: ChangeContext,
  input: { formId: string; formVersionId: string; workOrderId: string | null },
): Promise<{ mutationId: string; submissionId: string }> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const now = clock.now();
    const at = now.toISOString();
    const submissionId = uuidv7(now.getTime(), random);
    const mutationId = uuidv7(now.getTime(), random);
    await sql.run(
      `insert into submissions (id, form_id, form_version_id, work_order_id, status, answers, updated_at)
       values (?, ?, ?, ?, 'draft', '{}', ?)`,
      [submissionId, input.formId, input.formVersionId, input.workOrderId, at],
    );
    await insertChange(sql, {
      id: mutationId,
      kind: 'submission.start',
      entityKey: `submission:${submissionId}`,
      entityId: submissionId,
      workOrderId: input.workOrderId,
      payload: input,
      base: null,
      at,
    });
    return { mutationId, submissionId };
  });
}

async function submissionRow(sql: SqlConnection, submissionId: string) {
  const row = await sql.get<{ work_order_id: string | null; status: string }>(
    'select work_order_id, status from submissions where id = ?',
    [submissionId],
  );
  if (row === undefined) {
    throw new LocalChangeError('form_not_on_phone', 'This form is not on this phone.');
  }
  return row;
}

/** Autosave. Unsent autosaves of the same form become one change. */
export async function recordAnswers(
  context: ChangeContext,
  input: { submissionId: string; answers: Record<string, unknown> },
): Promise<string> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const submission = await submissionRow(sql, input.submissionId);
    if (submission.status === 'submitted') {
      throw new LocalChangeError('form_submitted', 'This form has been submitted.');
    }
    const now = clock.now();
    const at = now.toISOString();
    await sql.run('update submissions set answers = ?, updated_at = ? where id = ?', [
      JSON.stringify(input.answers),
      at,
      input.submissionId,
    ]);
    const unsent = await sql.get<{ seq: number; id: string }>(
      `select seq, id from outbox
       where entity_key = ? and kind = 'submission.answers' and state = 'pending' and attempts = 0
         and sent_at is null
         and seq = (select max(seq) from outbox where entity_key = ? and state <> 'done')`,
      [`submission:${input.submissionId}`, `submission:${input.submissionId}`],
    );
    if (unsent !== undefined) {
      await sql.run('update outbox set payload = ?, recorded_at = ? where seq = ?', [
        JSON.stringify({ answers: input.answers }),
        at,
        unsent.seq,
      ]);
      return unsent.id;
    }
    const id = uuidv7(now.getTime(), random);
    await insertChange(sql, {
      id,
      kind: 'submission.answers',
      entityKey: `submission:${input.submissionId}`,
      entityId: input.submissionId,
      workOrderId: submission.work_order_id,
      payload: { answers: input.answers },
      base: null,
      at,
    });
    return id;
  });
}

/** Media ids named anywhere in a set of answers. */
export function mediaIdsIn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(mediaIdsIn);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const own = typeof record.mediaId === 'string' ? [record.mediaId] : [];
    return [...own, ...Object.values(record).flatMap(mediaIdsIn)];
  }
  return [];
}

export async function recordSubmit(
  context: ChangeContext,
  input: {
    submissionId: string;
    answers: Record<string, unknown>;
    /** The day it was filled, `YYYY-MM-DD`, in the engineer's calendar. */
    filledOn: string;
    reason?: string;
    /** Where the phone was, taken as the engineer submitted (P13). */
    location?: SubmitLocation;
  },
): Promise<string> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const submission = await submissionRow(sql, input.submissionId);
    const now = clock.now();
    const at = now.toISOString();
    await sql.run(
      `update submissions set answers = ?, status = 'submitted', submitted_at = ?, updated_at = ? where id = ?`,
      [JSON.stringify(input.answers), at, at, input.submissionId],
    );
    // A submit carries the final answers; an autosave that never left is superseded.
    // One that may have left stays, so the server's base moves with it.
    await sql.run(
      `delete from outbox where entity_key = ? and kind = 'submission.answers' and state = 'pending' and attempts = 0
       and sent_at is null`,
      [`submission:${input.submissionId}`],
    );
    const id = uuidv7(now.getTime(), random);
    await insertChange(sql, {
      id,
      kind: 'submission.submit',
      entityKey: `submission:${input.submissionId}`,
      entityId: input.submissionId,
      workOrderId: submission.work_order_id,
      payload: {
        answers: input.answers,
        filledOn: input.filledOn,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.location === undefined ? {} : { location: input.location }),
      },
      base: null,
      waitsFor: { media: [...new Set(mediaIdsIn(input.answers))], mutations: [] },
      at,
    });
    return id;
  });
}

/**
 * Queues a file the engineer captured. Returns the id to put in the answer, which
 * the server will know the file by once it arrives.
 */
export async function queueUpload(
  context: ChangeContext,
  input: {
    localPath: string;
    contentType: string;
    byteSize: number;
    workOrderId: string | null;
    /** A small copy to show while it waits, made on the phone (P13). */
    thumbnailPath?: string;
  },
): Promise<string> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const now = clock.now();
    const mediaId = uuidv7(now.getTime(), random);
    await sql.run(
      `insert into uploads (media_id, local_path, thumbnail_path, content_type, byte_size, work_order_id, state, created_at)
       values (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      [
        mediaId,
        input.localPath,
        input.thumbnailPath ?? null,
        input.contentType,
        input.byteSize,
        input.workOrderId,
        now.toISOString(),
      ],
    );
    return mediaId;
  });
}

/**
 * Forms that reached the phone before sync existed (P11's drafts) are queued the
 * first time the engine runs: started on the server under the id they already
 * have, then given their answers.
 */
export async function adoptUnqueuedForms(context: ChangeContext): Promise<number> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const orphans = await sql.all<{
      id: string;
      form_id: string;
      form_version_id: string;
      work_order_id: string | null;
      answers: string;
    }>(
      `select id, form_id, form_version_id, work_order_id, answers from submissions
       where server_revision is null
         and id not in (select entity_id from outbox where kind like 'submission.%')`,
    );
    for (const orphan of orphans) {
      const now = clock.now();
      const at = now.toISOString();
      await insertChange(sql, {
        id: uuidv7(now.getTime(), random),
        kind: 'submission.start',
        entityKey: `submission:${orphan.id}`,
        entityId: orphan.id,
        workOrderId: orphan.work_order_id,
        payload: {
          formId: orphan.form_id,
          formVersionId: orphan.form_version_id,
          workOrderId: orphan.work_order_id,
        },
        base: null,
        at,
      });
      const answers = JSON.parse(orphan.answers) as Record<string, unknown>;
      if (Object.keys(answers).length > 0) {
        await insertChange(sql, {
          id: uuidv7(now.getTime(), random),
          kind: 'submission.answers',
          entityKey: `submission:${orphan.id}`,
          entityId: orphan.id,
          workOrderId: orphan.work_order_id,
          payload: { answers },
          base: null,
          at,
        });
      }
    }
    return orphans.length;
  });
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export async function pendingRows(sql: SqlConnection): Promise<OutboxRow[]> {
  return (await sql.all<RawRow>(`select * from outbox where state <> 'done' order by seq`)).map(
    toRow,
  );
}

/**
 * The changes to send now, in order.
 *
 * A change goes when it is due, everything it waits for has arrived, and no
 * earlier change to the same record is still outstanding. Several changes to one
 * record can share a batch — the server applies them in order and holds back the
 * rest if one fails — except a form's answers, whose base is only known once the
 * change before them has been applied.
 */
export async function selectBatch(
  sql: SqlConnection,
  deviceNow: Date,
  limit = 50,
): Promise<{ rows: OutboxRow[]; mutations: PushMutation[] }> {
  const outstanding = await pendingRows(sql);
  if (outstanding.length === 0) {
    return { rows: [], mutations: [] };
  }
  const unconfirmed = new Set(
    (
      await sql.all<{ media_id: string }>(`select media_id from uploads where state <> 'confirmed'`)
    ).map((row) => row.media_id),
  );
  const doneMutations = new Set(
    (
      await sql.all<{ id: string }>(
        `select id from outbox where state = 'done' and id in (select value from json_each(?))`,
        [JSON.stringify(outstanding.flatMap((row) => row.waitsFor.mutations))],
      )
    ).map((row) => row.id),
  );

  const blocked = new Set<string>();
  const included = new Map<string, number>();
  const rows: OutboxRow[] = [];
  const now = deviceNow.toISOString();

  for (const row of outstanding) {
    if (rows.length >= limit) {
      break;
    }
    if (blocked.has(row.entityKey)) {
      continue;
    }
    const due = row.nextAttemptAt === null || row.nextAttemptAt <= now;
    const waiting =
      row.waitsFor.media.some((mediaId) => unconfirmed.has(mediaId)) ||
      row.waitsFor.mutations.some((mutationId) => !doneMutations.has(mutationId));
    if (row.state !== 'pending' || !due || waiting) {
      blocked.add(row.entityKey);
      continue;
    }
    if (LAZY_BASE.has(row.kind) && (included.get(row.entityKey) ?? 0) > 0) {
      blocked.add(row.entityKey);
      continue;
    }
    rows.push(row);
    included.set(row.entityKey, (included.get(row.entityKey) ?? 0) + 1);
  }

  const mutations: PushMutation[] = [];
  for (const row of rows) {
    let base = row.base;
    if (LAZY_BASE.has(row.kind)) {
      const submission = await sql.get<{
        server_revision: number | null;
        server_answers: string | null;
      }>('select server_revision, server_answers from submissions where id = ?', [row.entityId]);
      base = {
        revision: submission?.server_revision ?? 1,
        answers:
          submission?.server_answers === null || submission?.server_answers === undefined
            ? {}
            : (JSON.parse(submission.server_answers) as Record<string, unknown>),
      };
    }
    mutations.push({
      id: row.id,
      kind: row.kind,
      entityId: row.entityId,
      recordedAt: row.recordedAt,
      payload: row.payload,
      ...(base === null ? {} : { base }),
    } as PushMutation);
  }
  return { rows, mutations };
}

/** After this many server-side failures a change stops retrying and asks for attention. */
export const MAX_ATTEMPTS = 10;

/** Seconds before the next try: 5, 10, 20… up to half an hour, or what the server asked for. */
export function backoffSeconds(attempts: number, retryAfterSeconds = 0): number {
  const exponential = Math.min(5 * 2 ** Math.max(0, attempts - 1), 30 * 60);
  return Math.max(exponential, retryAfterSeconds);
}

export interface PushCounts {
  pushed: number;
  conflicts: number;
  rejected: number;
  retried: number;
}

export async function applyPushResults(
  sql: SqlConnection,
  rows: readonly OutboxRow[],
  results: readonly PushResult[],
  deviceNow: Date,
): Promise<PushCounts> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const counts: PushCounts = { pushed: 0, conflicts: 0, rejected: 0, retried: 0 };
  const now = deviceNow.toISOString();

  for (const result of results) {
    const row = byId.get(result.id);
    if (row === undefined) {
      continue;
    }
    switch (result.outcome) {
      case 'applied':
        counts.pushed += 1;
        await sql.run(
          `update outbox set state = 'done', done_at = ?, last_error = null, conflict = null where seq = ?`,
          [now, row.seq],
        );
        if (row.kind.startsWith('submission.') && result.revision !== null) {
          await sql.run(
            'update submissions set server_revision = ?, server_answers = coalesce(?, server_answers) where id = ?',
            [
              result.revision,
              result.answers === null ? null : JSON.stringify(result.answers),
              row.entityId,
            ],
          );
        }
        break;
      case 'conflict':
        counts.conflicts += 1;
        await requestRefresh(sql, row.workOrderId);
        await sql.run(
          `update outbox set state = 'conflict', conflict = ?, last_error = ? where seq = ?`,
          [
            JSON.stringify(result.conflict),
            JSON.stringify({ code: result.code, message: result.message }),
            row.seq,
          ],
        );
        break;
      case 'rejected':
        counts.rejected += 1;
        await requestRefresh(sql, row.workOrderId);
        await sql.run(`update outbox set state = 'failed', last_error = ? where seq = ?`, [
          JSON.stringify({ code: result.code, message: result.message, details: result.details }),
          row.seq,
        ]);
        break;
      case 'retry': {
        counts.retried += 1;
        // Held back behind an earlier change is not a failure of this one.
        const attempts = result.code === 'blocked' ? row.attempts : row.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await sql.run(
            `update outbox set state = 'failed', attempts = ?, last_error = ? where seq = ?`,
            [attempts, JSON.stringify({ code: 'gave_up', message: result.message }), row.seq],
          );
          break;
        }
        const wait =
          result.code === 'blocked' ? 0 : backoffSeconds(attempts, result.retryAfterSeconds);
        await sql.run(
          'update outbox set attempts = ?, next_attempt_at = ?, last_error = ? where seq = ?',
          [
            attempts,
            new Date(deviceNow.getTime() + wait * 1000).toISOString(),
            JSON.stringify({ code: result.code, message: result.message }),
            row.seq,
          ],
        );
        break;
      }
    }
  }
  return counts;
}

/** Marks changes as handed to the network, which ends folding later autosaves into them. */
export async function markSent(
  sql: SqlConnection,
  rows: readonly OutboxRow[],
  deviceNow: Date,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await sql.run(`update outbox set sent_at = ? where seq in (select value from json_each(?))`, [
    deviceNow.toISOString(),
    JSON.stringify(rows.map((row) => row.seq)),
  ]);
}

/**
 * A batch that got no answer. With no connection the changes simply wait for the
 * next run; a server error counts as an attempt and backs off.
 */
export async function markBatchUnanswered(
  sql: SqlConnection,
  rows: readonly OutboxRow[],
  deviceNow: Date,
  reason: 'offline' | 'server_error',
): Promise<void> {
  for (const row of rows) {
    if (reason === 'offline') {
      continue;
    }
    const attempts = row.attempts + 1;
    await sql.run(
      'update outbox set attempts = ?, next_attempt_at = ?, last_error = ? where seq = ?',
      [
        attempts,
        new Date(deviceNow.getTime() + backoffSeconds(attempts) * 1000).toISOString(),
        JSON.stringify({
          code: 'server_error',
          message: 'The server could not take this change just now.',
        }),
        row.seq,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

async function outboxRow(sql: SqlConnection, mutationId: string): Promise<OutboxRow> {
  const raw = await sql.get<RawRow>('select * from outbox where id = ?', [mutationId]);
  if (raw === undefined) {
    throw new LocalChangeError('change_unknown', 'This change is not on this phone.');
  }
  return toRow(raw);
}

/** Sends the change again as a new change, in the same place in the order. */
async function reissue(
  sql: SqlConnection,
  context: ChangeContext,
  row: OutboxRow,
  update: { payload?: unknown; base?: unknown },
): Promise<string> {
  const now = context.clock.now();
  const id = uuidv7(now.getTime(), context.random);
  await sql.run(
    `update outbox set id = ?, state = 'pending', attempts = 0, next_attempt_at = null, last_error = null,
       conflict = null, payload = ?, base = ?, recorded_at = ?
     where seq = ?`,
    [
      id,
      JSON.stringify(update.payload ?? row.payload),
      update.base === undefined
        ? row.base === null
          ? null
          : JSON.stringify(row.base)
        : update.base === null
          ? null
          : JSON.stringify(update.base),
      now.toISOString(),
      row.seq,
    ],
  );
  return id;
}

/** Keep theirs: the change is dropped, and the next pull shows the server's version. */
export async function discardChange(context: ChangeContext, mutationId: string): Promise<void> {
  await context.db.write(OUTBOX_TABLES, async (sql) => {
    const row = await outboxRow(sql, mutationId);
    await requestRefresh(sql, row.workOrderId);
    await sql.run(`update outbox set state = 'done', done_at = ?, last_error = ? where seq = ?`, [
      context.clock.now().toISOString(),
      JSON.stringify({
        code: 'discarded',
        message: 'Discarded by the engineer.',
        previous: row.lastError,
      }),
      row.seq,
    ]);
  });
}

/** Try a refused or conflicting change again — after the engineer fixed what stood in its way. */
export async function retryChange(context: ChangeContext, mutationId: string): Promise<string> {
  return context.db.write(OUTBOX_TABLES, async (sql) => {
    const row = await outboxRow(sql, mutationId);
    if (row.state === 'done') {
      throw new LocalChangeError('change_done', 'This change has already reached the server.');
    }
    const conflict = row.conflict;
    if (conflict?.kind === 'state_changed') {
      // Apply mine again, from the state the job is really in.
      return reissue(sql, context, row, {
        base: { state: conflict.current.state, revision: conflict.current.revision },
      });
    }
    return reissue(sql, context, row, {});
  });
}

export type Choice = 'mine' | 'theirs';

export async function resolveAccessConflict(
  context: ChangeContext,
  mutationId: string,
  choices: Readonly<Record<string, Choice>>,
): Promise<string | undefined> {
  return context.db.write(OUTBOX_TABLES, async (sql) => {
    const row = await outboxRow(sql, mutationId);
    const conflict = row.conflict;
    if (conflict?.kind !== 'access_changed') {
      throw new LocalChangeError(
        'not_an_access_conflict',
        'This change is not an access-notes conflict.',
      );
    }
    const changes = { ...(row.payload.changes as Record<string, string | null>) };
    const base: Record<string, string | null> = {};
    const current = conflict.current as Record<string, string | null | undefined>;
    for (const field of Object.keys(changes)) {
      const disputed = conflict.fields.find((entry) => entry.field === field);
      if (disputed !== undefined && choices[field] !== 'mine') {
        delete changes[field];
        continue;
      }
      base[field] = current[field] ?? null;
    }
    if (Object.keys(changes).length === 0) {
      await sql.run(`update outbox set state = 'done', done_at = ?, last_error = ? where seq = ?`, [
        context.clock.now().toISOString(),
        JSON.stringify({ code: 'discarded', message: 'Kept the other version.' }),
        row.seq,
      ]);
      return undefined;
    }
    return reissue(sql, context, row, { payload: { changes }, base: { access: base } });
  });
}

export async function resolveAnswersConflict(
  context: ChangeContext,
  mutationId: string,
  choices: Readonly<Record<string, Choice>>,
): Promise<string> {
  return context.db.write(OUTBOX_TABLES, async (sql) => {
    const row = await outboxRow(sql, mutationId);
    const conflict = row.conflict;
    if (conflict?.kind !== 'answers_changed') {
      throw new LocalChangeError(
        'not_an_answers_conflict',
        'This change is not a conflict over answers.',
      );
    }
    const local = await sql.get<{ server_answers: string | null }>(
      'select server_answers from submissions where id = ?',
      [row.entityId],
    );
    const oldBase =
      local?.server_answers == null
        ? {}
        : (JSON.parse(local.server_answers) as Record<string, unknown>);
    const mine = row.payload.answers as Record<string, unknown>;
    const theirs = conflict.current.answers;
    const disputed = new Map(conflict.questions.map((question) => [question.id, question]));

    // Their version, with every change I made on top — and, where we both
    // changed the same question, whichever the engineer chose.
    const resolved: Record<string, unknown> = { ...theirs };
    for (const key of new Set([...Object.keys(mine), ...Object.keys(oldBase)])) {
      const question = disputed.get(key);
      if (question !== undefined) {
        if (choices[key] === 'mine') {
          setOrDelete(resolved, key, question.mine);
        }
        continue;
      }
      if (JSON.stringify(mine[key] ?? null) !== JSON.stringify(oldBase[key] ?? null)) {
        setOrDelete(resolved, key, mine[key]);
      }
    }

    await sql.run(
      'update submissions set answers = ?, server_revision = ?, server_answers = ? where id = ?',
      [JSON.stringify(resolved), conflict.current.revision, JSON.stringify(theirs), row.entityId],
    );
    return reissue(sql, context, row, { payload: { ...row.payload, answers: resolved } });
  });
}

function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === null || value === undefined) {
    delete target[key];
  } else {
    target[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface SyncStatus {
  pendingChanges: number;
  conflicts: number;
  failed: number;
  pendingUploads: number;
  pendingUploadBytes: number;
  failedUploads: number;
  /** By the server's clock. */
  lastSuccessfulSyncAt: string | null;
}

export async function syncStatus(sql: SqlConnection): Promise<SyncStatus> {
  const row = await sql.get<{
    pending: number;
    conflicts: number;
    failed: number;
    uploads: number;
    upload_bytes: number;
    failed_uploads: number;
    last_success: string | null;
  }>(
    `select
       (select count(*) from outbox where state = 'pending') as pending,
       (select count(*) from outbox where state = 'conflict') as conflicts,
       (select count(*) from outbox where state = 'failed') as failed,
       (select count(*) from uploads where state = 'queued') as uploads,
       (select coalesce(sum(byte_size - bytes_sent), 0) from uploads where state = 'queued') as upload_bytes,
       (select count(*) from uploads where state = 'failed') as failed_uploads,
       (select value from meta where key = 'last_sync_success_at') as last_success`,
  );
  return {
    pendingChanges: row?.pending ?? 0,
    conflicts: row?.conflicts ?? 0,
    failed: row?.failed ?? 0,
    pendingUploads: row?.uploads ?? 0,
    pendingUploadBytes: row?.upload_bytes ?? 0,
    failedUploads: row?.failed_uploads ?? 0,
    lastSuccessfulSyncAt: row?.last_success ?? null,
  };
}

export interface JobSyncState {
  /** Everything done on this job has reached the server: nothing is left only on the phone. */
  safeToLeave: boolean;
  pendingChanges: number;
  pendingUploads: number;
  /** Changes that need the engineer: conflicts, and refusals. */
  needsAttention: number;
}

export async function jobSyncState(sql: SqlConnection, workOrderId: string): Promise<JobSyncState> {
  const row = await sql.get<{
    pending: number;
    uploads: number;
    attention: number;
    unqueued: number;
  }>(
    `select
       (select count(*) from outbox where work_order_id = ?1 and state = 'pending') as pending,
       (select count(*) from uploads where work_order_id = ?1 and state <> 'confirmed') as uploads,
       (select count(*) from outbox where work_order_id = ?1 and state in ('conflict', 'failed')) as attention,
       (select count(*) from submissions
        where work_order_id = ?1 and server_revision is null
          and id not in (select entity_id from outbox where kind like 'submission.%')) as unqueued`,
    [workOrderId],
  );
  const pendingChanges = (row?.pending ?? 0) + (row?.unqueued ?? 0);
  const pendingUploads = row?.uploads ?? 0;
  const needsAttention = row?.attention ?? 0;
  return {
    safeToLeave: pendingChanges === 0 && pendingUploads === 0 && needsAttention === 0,
    pendingChanges,
    pendingUploads,
    needsAttention,
  };
}

/** Changes that need the engineer, newest last, with enough to show them in words. */
export async function changesNeedingAttention(sql: SqlConnection): Promise<OutboxRow[]> {
  return (
    await sql.all<RawRow>(`select * from outbox where state in ('conflict', 'failed') order by seq`)
  ).map(toRow);
}

/** What a change was about, in words a person recognises. */
export interface DescribedChange extends OutboxRow {
  job: { id: string; referenceLabel: string; title: string } | null;
  formTitle: string | null;
  checklistLabel: string | null;
  siteName: string | null;
}

export async function describeChanges(
  sql: SqlConnection,
  rows: readonly OutboxRow[],
): Promise<DescribedChange[]> {
  const described: DescribedChange[] = [];
  for (const row of rows) {
    const job =
      row.workOrderId === null
        ? undefined
        : await sql.get<{ id: string; reference_label: string; title: string; data: string }>(
            'select id, reference_label, title, data from work_orders where id = ?',
            [row.workOrderId],
          );
    const detail = job === undefined ? undefined : (JSON.parse(job.data) as WorkOrderDetail);
    const form = row.kind.startsWith('submission.')
      ? await sql.get<{ title: string }>(
          `select forms.title from submissions join forms on forms.id = submissions.form_id
           where submissions.id = ?`,
          [row.entityId],
        )
      : undefined;
    const site =
      row.kind === 'site.access'
        ? await sql.get<{ name: string }>('select name from sites where id = ?', [row.entityId])
        : undefined;
    described.push({
      ...row,
      job:
        job === undefined
          ? null
          : { id: job.id, referenceLabel: job.reference_label, title: job.title },
      formTitle: form?.title ?? null,
      checklistLabel:
        row.kind === 'work_order.checklist'
          ? (detail?.checklist.find((item) => item.id === row.payload.itemId)?.label ?? null)
          : null,
      siteName: site?.name ?? null,
    });
  }
  return described;
}
