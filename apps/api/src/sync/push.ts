import { can, findTransition, type Principal } from '@integr8/core';
import { type Submission, type TenantTransaction, type WorkOrder, withTenant } from '@integr8/db';
import { z } from 'zod';
import { ApiError, type ErrorDetail } from '../http/errors.js';
import { fingerprintRequest } from '../http/idempotency.js';
import type { RequestContext } from '../http/routes.js';
import { updateAccessNotes } from '../routes/v1/customers.js';
import {
  mayWork,
  peopleOf,
  personSchema,
  readableWorkOrder,
  requireWork,
  workOrderStateSchema,
} from '../routes/v1/operations.js';
import {
  answersSchema,
  compiledVersion,
  dateSchema,
  mayEdit,
  mayFill,
  resolveToday,
  revalidate,
} from '../routes/v1/submissions.js';
import { audit as auditWorkOrder } from '../routes/v1/work-orders.js';
import { mergeRecords, sameValue } from './merge.js';

/**
 * Applying what a phone did offline (P12).
 *
 * Each change arrives with an id the phone chose (a UUIDv7) and is applied **at
 * most once, ever**: the id is claimed in the P04 idempotency table before
 * anything is written, and the outcome is stored in the same transaction as the
 * change. A resend — however long after, up to `SYNC_REPLAY_DAYS` — gets the
 * stored outcome back and changes nothing. A server that dies mid-change leaves a
 * claim that lapses within minutes, so the resend then applies it.
 *
 * Changes are applied in the order sent. When one does not apply, later changes
 * to the same record in the same batch wait (`retry`, `blocked`), so a job never
 * receives "completed" after its "arrived" was refused.
 *
 * The server is the authority. A change made against a version of the record the
 * server no longer holds is merged if it can be without losing anyone's work, and
 * otherwise returned as a **conflict**, with both versions, for the engineer to
 * decide. Nothing is overwritten because a phone's clock says it is later.
 */

const accessFieldSchema = z.enum(['gateCode', 'parking', 'askFor', 'hazards', 'notes']);
type AccessField = z.infer<typeof accessFieldSchema>;
const ACCESS_FIELDS = accessFieldSchema.options;

const accessValuesSchema = z.object({
  gateCode: z.string().trim().max(200).nullable().optional(),
  parking: z.string().trim().max(2000).nullable().optional(),
  askFor: z.string().trim().max(500).nullable().optional(),
  hazards: z.string().trim().max(4000).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});

const common = {
  id: z.uuid(),
  entityId: z.uuid(),
  /** When the phone recorded the change, by the phone's clock. */
  recordedAt: z.iso.datetime({ offset: true }),
};

export const mutationSchema = z.discriminatedUnion('kind', [
  z.object({
    ...common,
    kind: z.literal('work_order.transition'),
    payload: z.object({ to: workOrderStateSchema, reason: z.string().trim().max(2000).optional() }),
    base: z.object({ state: workOrderStateSchema, revision: z.number().int().min(1) }),
  }),
  z.object({
    ...common,
    kind: z.literal('work_order.checklist'),
    payload: z.object({ itemId: z.uuid(), done: z.boolean() }),
  }),
  z.object({
    ...common,
    kind: z.literal('work_order.comment'),
    payload: z.object({
      commentId: z.uuid(),
      body: z.string().trim().min(1).max(10_000),
      visibility: z.enum(['internal', 'customer']),
    }),
  }),
  z.object({
    ...common,
    kind: z.literal('site.access'),
    payload: z.object({ changes: accessValuesSchema }),
    base: z.object({ access: accessValuesSchema }),
  }),
  z.object({
    ...common,
    kind: z.literal('submission.start'),
    payload: z.object({
      formId: z.uuid(),
      formVersionId: z.uuid(),
      workOrderId: z.uuid().nullable(),
    }),
  }),
  z.object({
    ...common,
    kind: z.literal('submission.answers'),
    payload: z.object({ answers: answersSchema }),
    base: z.object({ revision: z.number().int().min(1), answers: answersSchema }),
  }),
  z.object({
    ...common,
    kind: z.literal('submission.submit'),
    payload: z.object({
      answers: answersSchema,
      /** The day the form was filled, in the engineer's calendar. */
      filledOn: dateSchema,
      reason: z.string().trim().min(1).max(2000).optional(),
    }),
    base: z.object({ revision: z.number().int().min(1), answers: answersSchema }),
  }),
]);

export type Mutation = z.infer<typeof mutationSchema>;

export const conflictSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('state_changed'),
    current: z.object({
      state: workOrderStateSchema,
      revision: z.number().int(),
      changedAt: z.string(),
      changedBy: personSchema.nullable(),
      reason: z.string().nullable(),
    }),
    /** Whether the engineer may still make their change from the job's current state. */
    canReapply: z.boolean(),
  }),
  z.object({
    kind: z.literal('forms_missing'),
    forms: z.array(z.object({ formId: z.uuid(), title: z.string() })),
  }),
  z.object({
    kind: z.literal('access_changed'),
    fields: z.array(
      z.object({
        field: accessFieldSchema,
        base: z.string().nullable(),
        mine: z.string().nullable(),
        theirs: z.string().nullable(),
      }),
    ),
    current: accessValuesSchema.extend({
      updatedAt: z.string().nullable(),
      updatedBy: personSchema.nullable(),
    }),
  }),
  z.object({
    kind: z.literal('answers_changed'),
    questions: z.array(
      z.object({ id: z.string(), base: z.unknown(), mine: z.unknown(), theirs: z.unknown() }),
    ),
    current: z.object({
      revision: z.number().int(),
      status: z.enum(['draft', 'submitted', 'reopened']),
      answers: answersSchema,
    }),
  }),
  z.object({
    kind: z.literal('already_submitted'),
    current: z.object({
      revision: z.number().int(),
      status: z.enum(['draft', 'submitted', 'reopened']),
      submittedAt: z.string().nullable(),
      submittedBy: personSchema,
      answers: answersSchema,
    }),
  }),
]);

export type SyncConflict = z.infer<typeof conflictSchema>;

const detailSchema = z.object({ field: z.string(), code: z.string(), message: z.string() });

export const resultSchema = z.discriminatedUnion('outcome', [
  z.object({
    id: z.uuid(),
    outcome: z.literal('applied'),
    /** This change had already been applied; this is the stored answer. */
    replayed: z.boolean(),
    /** The server already showed what the change asked for, so nothing was written. */
    alreadyApplied: z.boolean(),
    revision: z.number().int().nullable(),
    /** For a form, the answers the server now holds: the next change is merged against these. */
    answers: answersSchema.nullable(),
  }),
  z.object({
    id: z.uuid(),
    outcome: z.literal('conflict'),
    replayed: z.boolean(),
    code: z.string(),
    message: z.string(),
    conflict: conflictSchema,
  }),
  z.object({
    id: z.uuid(),
    outcome: z.literal('rejected'),
    replayed: z.boolean(),
    code: z.string(),
    message: z.string(),
    details: z.array(detailSchema),
  }),
  z.object({
    id: z.uuid(),
    outcome: z.literal('retry'),
    code: z.string(),
    message: z.string(),
    retryAfterSeconds: z.number().int(),
  }),
]);

export type MutationResult = z.infer<typeof resultSchema>;

type Settled = Exclude<MutationResult, { outcome: 'retry' }>;
type Outcome =
  | {
      outcome: 'applied';
      alreadyApplied: boolean;
      revision: number | null;
      answers: Record<string, unknown> | null;
    }
  | { outcome: 'conflict'; code: string; message: string; conflict: SyncConflict }
  | { outcome: 'rejected'; code: string; message: string; details?: readonly ErrorDetail[] }
  | { outcome: 'retry'; code: string; message: string; retryAfterSeconds?: number };

/** A claim lapses this soon if the server stops mid-change, so the resend can apply it. */
const CLAIM_SECONDS = 120;

const applied = (
  revision: number | null,
  alreadyApplied = false,
  answers: Record<string, unknown> | null = null,
): Outcome => ({
  outcome: 'applied',
  alreadyApplied,
  revision,
  answers,
});
const rejected = (code: string, message: string, details?: readonly ErrorDetail[]): Outcome => ({
  outcome: 'rejected',
  code,
  message,
  ...(details === undefined ? {} : { details }),
});

/** The record a change is to, for ordering within a batch. */
function entityKey(mutation: Mutation): string {
  return `${mutation.kind.split('.')[0]!}:${mutation.entityId}`;
}

export interface PushContext {
  context: RequestContext;
  /** The server's estimate of when the phone recorded each change. */
  recordedAt: (mutation: Mutation) => Date;
}

export async function applyMutations(
  mutations: readonly Mutation[],
  push: PushContext,
): Promise<MutationResult[]> {
  const results: MutationResult[] = [];
  const blocked = new Set<string>();
  for (const mutation of mutations) {
    const key = entityKey(mutation);
    if (blocked.has(key)) {
      results.push({
        id: mutation.id,
        outcome: 'retry',
        code: 'blocked',
        message: 'An earlier change to the same record has not been applied yet.',
        retryAfterSeconds: 0,
      });
      continue;
    }
    const result = await applyOnce(mutation, push);
    if (result.outcome !== 'applied') {
      blocked.add(key);
    }
    results.push(result);
  }
  return results;
}

async function applyOnce(mutation: Mutation, push: PushContext): Promise<MutationResult> {
  const { context } = push;
  const { principal, config } = context;
  const idempotencyKey = `sync:${mutation.id}`;
  const now = new Date();

  const claim = await withTenant(principal.tenantId, (tx) =>
    tx.idempotency.claim({
      idempotencyKey,
      userId: principal.userId,
      method: 'SYNC',
      path: `/v1/sync/push#${mutation.kind}`,
      requestFingerprint: fingerprintRequest('SYNC', mutation.kind, mutation),
      expiresAt: new Date(now.getTime() + CLAIM_SECONDS * 1000),
    }),
  );

  switch (claim.outcome) {
    case 'replay':
      return { ...(claim.record.responseBody as Settled), replayed: true };
    case 'in_progress':
      return {
        id: mutation.id,
        outcome: 'retry',
        code: 'in_progress',
        message: 'This change is being applied by another request.',
        retryAfterSeconds: 5,
      };
    case 'fingerprint_mismatch':
      return {
        id: mutation.id,
        outcome: 'rejected',
        replayed: false,
        code: 'mutation_id_reused',
        message: 'This change id was already used for a different change.',
        details: [],
      };
    case 'claimed':
      break;
  }

  const replayUntil = new Date(now.getTime() + config.SYNC_REPLAY_DAYS * 24 * 60 * 60 * 1000);
  const settle = (outcome: Exclude<Outcome, { outcome: 'retry' }>): Settled =>
    outcome.outcome === 'applied'
      ? { id: mutation.id, replayed: false, ...outcome }
      : outcome.outcome === 'conflict'
        ? { id: mutation.id, replayed: false, ...outcome }
        : {
            id: mutation.id,
            replayed: false,
            outcome: 'rejected',
            code: outcome.code,
            message: outcome.message,
            details: (outcome.details ?? []).map(({ field, code, message }) => ({
              field,
              code,
              message,
            })),
          };

  let outcome: Outcome;
  try {
    outcome = await withTenant(principal.tenantId, async (tx) => {
      const result = await apply(tx, mutation, push);
      if (result.outcome !== 'retry') {
        // In the same transaction as the change: applied and remembered, or neither.
        await tx.idempotency.complete(
          idempotencyKey,
          { status: 200, body: settle(result) },
          new Date(),
          replayUntil,
        );
      }
      return result;
    });
  } catch (error) {
    outcome = fromError(error);
    if (outcome.outcome !== 'retry') {
      const settled = outcome;
      await withTenant(principal.tenantId, (tx) =>
        tx.idempotency.complete(
          idempotencyKey,
          { status: 200, body: settle(settled) },
          new Date(),
          replayUntil,
        ),
      );
    } else {
      context.logger.warn('sync mutation failed; the phone will retry', {
        mutationId: mutation.id,
        kind: mutation.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (outcome.outcome === 'retry') {
    await withTenant(principal.tenantId, (tx) => tx.idempotency.release(idempotencyKey)).catch(
      () => undefined,
    );
    return {
      id: mutation.id,
      outcome: 'retry',
      code: outcome.code,
      message: outcome.message,
      retryAfterSeconds: outcome.retryAfterSeconds ?? 30,
    };
  }
  return settle(outcome);
}

/** An error thrown by a shared helper, as an outcome: refusals are final, anything else is retried. */
function fromError(error: unknown): Outcome {
  if (error instanceof ApiError) {
    if (error.status >= 500 || error.status === 429) {
      return { outcome: 'retry', code: error.code, message: error.message };
    }
    return rejected(error.code, error.message, error.details);
  }
  return {
    outcome: 'retry',
    code: 'server_error',
    message: 'The change could not be applied just now.',
  };
}

async function apply(
  tx: TenantTransaction,
  mutation: Mutation,
  push: PushContext,
): Promise<Outcome> {
  switch (mutation.kind) {
    case 'work_order.transition':
      return transition(tx, mutation, push);
    case 'work_order.checklist':
      return checklist(tx, mutation, push);
    case 'work_order.comment':
      return comment(tx, mutation, push);
    case 'site.access':
      return access(tx, mutation, push);
    case 'submission.start':
      return startSubmission(tx, mutation, push);
    case 'submission.answers':
      return saveAnswers(tx, mutation, push);
    case 'submission.submit':
      return submit(tx, mutation, push);
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

async function jobFor(tx: TenantTransaction, principal: Principal, workOrderId: string) {
  try {
    return await readableWorkOrder(tx, principal, workOrderId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

const unavailable = () =>
  rejected(
    'work_order_unavailable',
    'This job is no longer yours to change: it was reassigned, or removed.',
  );

async function stateChanged(
  tx: TenantTransaction,
  principal: Principal,
  job: WorkOrder,
  to: string,
): Promise<Outcome> {
  const [events, people] = await Promise.all([tx.workOrders.listEvents(job.id), peopleOf(tx)]);
  const last = events.filter((event) => event.kind === 'transitioned').at(-1);
  const transition = findTransition(job.state, to as WorkOrder['state']);
  const canReapply =
    transition !== undefined &&
    (transition.permission === 'work_order.progress'
      ? await mayWork(tx, principal, job)
      : can(principal.role, transition.permission));
  return {
    outcome: 'conflict',
    code: 'state_changed',
    message: `While you were offline this job moved to ${job.state.replace('_', ' ')}.`,
    conflict: {
      kind: 'state_changed',
      current: {
        state: job.state,
        revision: job.revision,
        changedAt: (last?.occurredAt ?? job.updatedAt).toISOString(),
        changedBy:
          last === undefined ? null : { id: last.actorId, name: people.get(last.actorId) ?? '' },
        reason: last?.reason ?? job.lastReason,
      },
      canReapply,
    },
  };
}

async function transition(
  tx: TenantTransaction,
  mutation: Extract<Mutation, { kind: 'work_order.transition' }>,
  { context }: PushContext,
): Promise<Outcome> {
  const { principal } = context;
  const job = await jobFor(tx, principal, mutation.entityId);
  if (job === undefined) {
    return unavailable();
  }
  const { to, reason } = mutation.payload;
  if (job.state === to) {
    return applied(job.revision, true);
  }
  if (job.state !== mutation.base.state) {
    return stateChanged(tx, principal, job, to);
  }

  const allowed = findTransition(job.state, to);
  if (allowed === undefined) {
    return rejected('transition_not_allowed', `A ${job.state} job cannot move to ${to}.`);
  }
  const permitted =
    allowed.permission === 'work_order.progress'
      ? await mayWork(tx, principal, job)
      : can(principal.role, allowed.permission);
  if (!permitted) {
    return rejected('forbidden', 'You may not make this change to this job.');
  }

  // The state is the one the phone saw; anything else that changed (a new
  // description, a note) does not stand in the way, so apply on the current revision.
  const result = await tx.workOrders.transition(job.id, job.revision, to, principal.userId, reason);
  switch (result.outcome) {
    case 'written':
      await auditWorkOrder(tx, context, 'work_order.transitioned', job.id, {
        from: job.state,
        to,
        via: 'sync',
        ...(reason === undefined ? {} : { reason }),
      });
      return applied(result.workOrder.revision);
    case 'conflict':
      return {
        outcome: 'retry',
        code: 'work_order_changed',
        message: 'Changed while applying.',
        retryAfterSeconds: 1,
      };
    case 'forms_missing':
      return {
        outcome: 'conflict',
        code: 'required_forms_missing',
        message: `Submit ${result.forms.map((form) => form.title).join(', ')} before completing this job.`,
        conflict: { kind: 'forms_missing', forms: result.forms },
      };
    case 'closed':
    case 'not_allowed':
      return stateChanged(tx, principal, result.current, to);
    case 'reason_required':
      return rejected('reason_required', 'This change needs a reason.');
    case 'nobody_assigned':
      return rejected('nobody_assigned', 'Nobody is assigned to this job.');
    case 'not_found':
      return unavailable();
  }
}

async function checklist(
  tx: TenantTransaction,
  mutation: Extract<Mutation, { kind: 'work_order.checklist' }>,
  { context }: PushContext,
): Promise<Outcome> {
  const { principal } = context;
  const job = await jobFor(tx, principal, mutation.entityId);
  if (job === undefined) {
    return unavailable();
  }
  await requireWork(tx, principal, job);
  const item = (await tx.workOrders.listChecklist(job.id)).find(
    (candidate) => candidate.id === mutation.payload.itemId,
  );
  if (item === undefined) {
    return rejected('checklist_item_unknown', 'This checklist item is no longer on the job.');
  }
  // A box is ticked or not: if it already shows what the engineer wanted, that is agreement.
  if (item.done === mutation.payload.done) {
    return applied(null, true);
  }
  if (['complete', 'reviewed', 'cancelled'].includes(job.state)) {
    return stateChanged(tx, principal, job, job.state);
  }
  await tx.workOrders.setChecklistItem(job.id, item.id, mutation.payload.done, principal.userId);
  return applied(null);
}

async function comment(
  tx: TenantTransaction,
  mutation: Extract<Mutation, { kind: 'work_order.comment' }>,
  { context }: PushContext,
): Promise<Outcome> {
  const { principal } = context;
  const existing = await tx.workOrders.findComment(mutation.payload.commentId);
  if (existing !== undefined) {
    return existing.workOrderId === mutation.entityId && existing.authorId === principal.userId
      ? applied(null, true)
      : rejected('comment_id_taken', 'This note id belongs to another note.');
  }
  const job = await jobFor(tx, principal, mutation.entityId);
  if (job === undefined) {
    return unavailable();
  }
  await requireWork(tx, principal, job);
  await tx.workOrders.addComment(
    job.id,
    {
      id: mutation.payload.commentId,
      body: mutation.payload.body,
      visibility: mutation.payload.visibility,
    },
    principal.userId,
  );
  return applied(null);
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

async function access(
  tx: TenantTransaction,
  mutation: Extract<Mutation, { kind: 'site.access' }>,
  { context }: PushContext,
): Promise<Outcome> {
  const site = await tx.sites.find(mutation.entityId);
  if (site === undefined) {
    return rejected('site_unavailable', 'This site no longer exists.');
  }
  const changed = ACCESS_FIELDS.filter((field) => mutation.payload.changes[field] !== undefined);
  const value = (text: string | null | undefined) => {
    const trimmed = text?.trim() ?? '';
    return trimmed === '' ? null : trimmed;
  };
  const theirs = (field: AccessField) => value(site.access[field]);

  const conflicts = changed.flatMap((field) => {
    const base = value(mutation.base.access[field]);
    const mine = value(mutation.payload.changes[field]);
    return theirs(field) !== base && theirs(field) !== mine
      ? [{ field, base, mine, theirs: theirs(field) }]
      : [];
  });
  if (conflicts.length > 0) {
    const people = await peopleOf(tx);
    return {
      outcome: 'conflict',
      code: 'access_changed',
      message: 'Someone else changed these access notes while you were offline.',
      conflict: {
        kind: 'access_changed',
        fields: conflicts,
        current: {
          gateCode: site.access.gateCode,
          parking: site.access.parking,
          askFor: site.access.askFor,
          hazards: site.access.hazards,
          notes: site.access.notes,
          updatedAt: site.access.updatedAt?.toISOString() ?? null,
          updatedBy:
            site.access.updatedBy === null
              ? null
              : { id: site.access.updatedBy, name: people.get(site.access.updatedBy) ?? '' },
        },
      },
    };
  }

  const toWrite = Object.fromEntries(
    changed
      .filter((field) => theirs(field) !== value(mutation.payload.changes[field]))
      .map((field) => [field, value(mutation.payload.changes[field])]),
  );
  if (Object.keys(toWrite).length === 0) {
    return applied(null, true);
  }
  await updateAccessNotes(tx, context, site, toWrite);
  return applied(null);
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

async function startSubmission(
  tx: TenantTransaction,
  mutation: Extract<Mutation, { kind: 'submission.start' }>,
  { context }: PushContext,
): Promise<Outcome> {
  const { principal } = context;
  const { formId, formVersionId, workOrderId } = mutation.payload;
  const existing = await tx.submissions.findById(mutation.entityId);
  if (existing !== undefined) {
    return existing.submittedBy === principal.userId && existing.formVersionId === formVersionId
      ? applied(existing.revision, true, existing.answers)
      : rejected('submission_id_taken', 'This form id belongs to another submission.');
  }

  const [form, version] = await Promise.all([
    tx.forms.findForm(formId),
    tx.forms.findVersion(formVersionId),
  ]);
  if (form === undefined || version?.formId !== form.id || version.status !== 'published') {
    return rejected('form_version_unavailable', 'This version of the form is not available.');
  }
  if (!mayFill(principal, form)) {
    return rejected('forbidden', 'Your role is not one this form may be filled by.');
  }
  if (workOrderId !== null) {
    const job = await jobFor(tx, principal, workOrderId);
    if (job === undefined) {
      return unavailable();
    }
    await requireWork(tx, principal, job);
    if (['complete', 'reviewed', 'cancelled'].includes(job.state)) {
      return stateChanged(tx, principal, job, 'in_progress');
    }
    if (!(await tx.workOrders.listForms(job.id)).some((entry) => entry.formId === form.id)) {
      return rejected('form_not_on_work_order', 'This form is no longer one of the job’s forms.');
    }
  }
  const draft = await tx.submissions.startDraft({
    id: mutation.entityId,
    formVersionId: version.id,
    submittedBy: principal.userId,
    ...(workOrderId === null ? {} : { workOrderId }),
  });
  return applied(draft.revision, false, draft.answers);
}

async function ownSubmission(tx: TenantTransaction, principal: Principal, id: string) {
  const submission = await tx.submissions.findById(id);
  const amendable = submission?.status === 'reopened' && can(principal.role, 'submission.amend');
  return submission?.submittedBy === principal.userId || amendable ? submission : undefined;
}

async function alreadySubmitted(tx: TenantTransaction, submission: Submission): Promise<Outcome> {
  const people = await peopleOf(tx);
  return {
    outcome: 'conflict',
    code: 'already_submitted',
    message: 'This form was submitted from somewhere else while you were offline.',
    conflict: {
      kind: 'already_submitted',
      current: {
        revision: submission.revision,
        status: submission.status,
        submittedAt: submission.submittedAt?.toISOString() ?? null,
        submittedBy: { id: submission.submittedBy, name: people.get(submission.submittedBy) ?? '' },
        answers: submission.answers,
      },
    },
  };
}

/** The answers to write: mine if the server has not moved on, or a merge if it has. */
function answersToWrite(
  submission: Submission,
  base: { revision: number; answers: Record<string, unknown> },
  mine: Record<string, unknown>,
): { answers: Record<string, unknown>; changed: boolean } | Outcome {
  if (submission.revision === base.revision) {
    return { answers: mine, changed: !sameValue(mine, submission.answers) };
  }
  const merged = mergeRecords(base.answers, mine, submission.answers);
  if (merged.outcome === 'conflict') {
    return {
      outcome: 'conflict',
      code: 'answers_changed',
      message: 'These answers were changed on another device while you were offline.',
      conflict: {
        kind: 'answers_changed',
        questions: merged.conflicts.map((entry) => ({
          id: entry.key,
          base: entry.base,
          mine: entry.mine,
          theirs: entry.theirs,
        })),
        current: {
          revision: submission.revision,
          status: submission.status,
          answers: submission.answers,
        },
      },
    };
  }
  return { answers: merged.value, changed: merged.changed };
}

async function saveAnswers(
  tx: TenantTransaction,
  mutation: Extract<Mutation, { kind: 'submission.answers' }>,
  { context }: PushContext,
): Promise<Outcome> {
  const { principal } = context;
  const submission = await ownSubmission(tx, principal, mutation.entityId);
  if (submission === undefined) {
    return rejected('submission_unavailable', 'This form is not yours to change.');
  }
  if (submission.status === 'submitted') {
    return sameValue(submission.answers, mutation.payload.answers)
      ? applied(submission.revision, true, submission.answers)
      : alreadySubmitted(tx, submission);
  }
  if (!mayEdit(principal, submission, await tx.forms.findForm(submission.formId))) {
    return rejected('forbidden', 'You may not change this submission.');
  }
  const plan = answersToWrite(submission, mutation.base, mutation.payload.answers);
  if ('outcome' in plan) {
    return plan;
  }
  if (!plan.changed) {
    return applied(submission.revision, true, submission.answers);
  }
  const result = await tx.submissions.saveAnswers(
    submission.id,
    plan.answers,
    submission.revision,
    principal.userId,
  );
  if (result.outcome === 'written') {
    return applied(result.submission.revision, false, result.submission.answers);
  }
  return {
    outcome: 'retry',
    code: 'submission_changed',
    message: 'Changed while applying.',
    retryAfterSeconds: 1,
  };
}

async function submit(
  tx: TenantTransaction,
  mutation: Extract<Mutation, { kind: 'submission.submit' }>,
  { context, recordedAt }: PushContext,
): Promise<Outcome> {
  const { principal } = context;
  const submission = await ownSubmission(tx, principal, mutation.entityId);
  if (submission === undefined) {
    return rejected('submission_unavailable', 'This form is not yours to submit.');
  }
  if (submission.status === 'submitted') {
    return submission.submittedBy === principal.userId &&
      sameValue(submission.answers, mutation.payload.answers)
      ? applied(submission.revision, true, submission.answers)
      : alreadySubmitted(tx, submission);
  }
  const form = await tx.forms.findForm(submission.formId);
  if (!mayEdit(principal, submission, form)) {
    return rejected('forbidden', 'You may not submit this.');
  }
  if (submission.status === 'reopened' && mutation.payload.reason === undefined) {
    return rejected('reason_required', 'Say why this submission is being corrected.');
  }
  const plan = answersToWrite(submission, mutation.base, mutation.payload.answers);
  if ('outcome' in plan) {
    return plan;
  }

  const version = await tx.forms.findVersion(submission.formVersionId);
  if (version === undefined) {
    return rejected('form_version_unavailable', 'The version this form was filled on is gone.');
  }
  // "Today" in the form's rules is the day it was filled — judged against when the
  // phone recorded it, on the server's clock, not against the day it synced.
  const today = resolveToday(mutation.payload.filledOn, recordedAt(mutation));
  let answers: Record<string, unknown>;
  try {
    answers = await revalidate(tx, compiledVersion(version), plan.answers, today);
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.details ?? []).length > 0 &&
      (error.details ?? []).every((detail) => detail.code === 'media_not_found')
    ) {
      // A photo still on its way. The phone sends answers after their files, so
      // this is a race, not a mistake.
      return {
        outcome: 'retry',
        code: 'media_not_ready',
        message: 'A file this form names has not finished uploading.',
        retryAfterSeconds: 30,
      };
    }
    throw error;
  }

  const result = await tx.submissions.submit(
    submission.id,
    answers,
    submission.revision,
    principal.userId,
    submission.status === 'reopened' ? mutation.payload.reason : undefined,
  );
  if (result.outcome === 'written') {
    return applied(result.submission.revision, false, result.submission.answers);
  }
  return {
    outcome: 'retry',
    code: 'submission_changed',
    message: 'Changed while applying.',
    retryAfterSeconds: 1,
  };
}
