import { type TenantId, type UserId, toTenantId, toUserId } from '@integr8/core';
import { type ExpressionBuilder, type Selectable, sql } from 'kysely';
import type {
  Database,
  ReportableValueType,
  SubmissionEventKind,
  SubmissionEventsTable,
  SubmissionStatus,
  SubmissionsTable,
} from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export interface Submission {
  id: string;
  tenantId: TenantId;
  formId: string;
  formVersionId: string;
  status: SubmissionStatus;
  answers: Record<string, unknown>;
  /** The person filling it in. */
  submittedBy: UserId;
  /** When first submitted; null while a draft. */
  submittedAt: Date | null;
  amendedAt: Date | null;
  revision: number;
  /** The job this form was filled for, if any. */
  workOrderId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubmissionEvent {
  sequence: number;
  kind: SubmissionEventKind;
  answers: Record<string, unknown> | null;
  actorId: UserId;
  reason: string | null;
  occurredAt: Date;
}

export interface CreateSubmissionInput {
  formVersionId: string;
  /** Already revalidated by `validateSubmission` from @integr8/form-engine. */
  answers: Record<string, unknown>;
  submittedBy: UserId | string;
}

export interface StartDraftInput {
  /** Chosen by a phone that started the form offline (P12), so a resend finds it. */
  id?: string;
  formVersionId: string;
  submittedBy: UserId | string;
  answers?: Record<string, unknown>;
  /** The job it is filled for. The form must be one of the job's; the database refuses otherwise. */
  workOrderId?: string;
}

/** Why a write did not happen, so the API can say the right thing. */
export type WriteRefusal =
  /** No such submission in this company. */
  | 'not_found'
  /** Somebody changed it since `expectedRevision`. */
  | 'conflict'
  /** Its state does not allow this: saving a submitted one, reopening a draft. */
  | 'wrong_status';

export type WriteResult =
  | { outcome: 'written'; submission: Submission }
  | { outcome: WriteRefusal; current: Submission | undefined };

export type ValueOperator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains';

export interface ValueFilter {
  field: string;
  type: ReportableValueType;
  operator: ValueOperator;
  /** Text as the field's answer would be written: `12.5`, `2026-09-13`, `true`. */
  value: string;
}

export interface SubmissionQuery {
  formId?: string;
  statuses?: readonly SubmissionStatus[];
  submittedBy?: string;
  /** Inclusive lower bound on `submitted_at`. */
  submittedFrom?: Date;
  /** Exclusive upper bound on `submitted_at`. */
  submittedBefore?: Date;
  /** Full-text search over every written answer. */
  text?: string;
  /** Filled for this job. */
  workOrderId?: string;
  /** Filled for a job at this site. */
  siteId?: string;
  /** Filled for a job for this customer. */
  customerId?: string;
  /** All must match. A value filter needs `formId`: field ids mean something only within a form. */
  values?: readonly ValueFilter[];
  /** `submitted` sorts by first submission, `updated` by last change — what a drafts list wants. */
  order?: 'submitted' | 'updated';
  /** The last row of the previous page. */
  after?: { at: Date; id: string };
  limit?: number;
}

/** A page of results, and where the next one starts. */
export interface SubmissionPage {
  items: Submission[];
  next: { at: Date; id: string } | undefined;
}

/**
 * Submissions for one company, through their lifecycle.
 *
 *   draft --submit--> submitted --reopen--> reopened --submit--> submitted
 *
 * Every write names who is making it and, where the database requires one, why.
 * What this class does not do is decide whether answers are *valid*: that is
 * `validateSubmission` from @integr8/form-engine, which the API runs before
 * calling `submit`. And what it cannot do is change a submitted answer or write
 * history — migration 0008 refuses the first for every role and reserves the
 * second for its own trigger.
 */
export class SubmissionsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /** The one place a `submissions` read is scoped. */
  #scoped() {
    return this.db.selectFrom('submissions').where('submissions.tenant_id', '=', this.tenantId);
  }

  /** The form a version belongs to, as a subquery, so a caller cannot name a mismatched pair. */
  #formOf(formVersionId: string) {
    return sql<string>`(select form_id from form_versions where tenant_id = ${this.tenantId} and id = ${formVersionId})`;
  }

  /** Submits in one step. What a client that fills offline and syncs later sends (P12). */
  async create(input: CreateSubmissionInput): Promise<Submission> {
    const row = await this.db
      .insertInto('submissions')
      .values({
        tenant_id: this.tenantId,
        form_id: this.#formOf(input.formVersionId),
        form_version_id: input.formVersionId,
        status: 'submitted',
        answers: input.answers,
        submitted_by: toUserId(input.submittedBy),
        last_actor: toUserId(input.submittedBy),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toDomain(row);
  }

  async startDraft(input: StartDraftInput): Promise<Submission> {
    const row = await this.db
      .insertInto('submissions')
      .values({
        ...(input.id === undefined ? {} : { id: input.id }),
        tenant_id: this.tenantId,
        form_id: this.#formOf(input.formVersionId),
        form_version_id: input.formVersionId,
        status: 'draft',
        answers: input.answers ?? {},
        submitted_by: toUserId(input.submittedBy),
        last_actor: toUserId(input.submittedBy),
        ...(input.workOrderId === undefined ? {} : { work_order_id: input.workOrderId }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toDomain(row);
  }

  async findById(submissionId: string): Promise<Submission | undefined> {
    const row = await this.#scoped().selectAll().where('id', '=', submissionId).executeTakeFirst();
    return row === undefined ? undefined : toDomain(row);
  }

  /** Autosave of a draft, or of a reopened submission being corrected. */
  async saveAnswers(
    submissionId: string,
    answers: Record<string, unknown>,
    expectedRevision: number,
    actor: UserId | string,
  ): Promise<WriteResult> {
    return this.#write(submissionId, expectedRevision, ['draft', 'reopened'], {
      answers,
      last_actor: toUserId(actor),
    });
  }

  /**
   * Submits a draft, or the correction of a reopened submission.
   *
   * `reason` is required by the database for a correction and ignored for a
   * first submission. `answers` must already be the server's revalidated
   * answers — calculated values its own, hidden answers removed.
   */
  async submit(
    submissionId: string,
    answers: Record<string, unknown>,
    expectedRevision: number,
    actor: UserId | string,
    reason?: string,
  ): Promise<WriteResult> {
    return this.#write(submissionId, expectedRevision, ['draft', 'reopened'], {
      answers,
      status: 'submitted',
      last_actor: toUserId(actor),
      last_reason: reason ?? null,
    });
  }

  async reopen(
    submissionId: string,
    expectedRevision: number,
    actor: UserId | string,
    reason: string,
  ): Promise<WriteResult> {
    return this.#write(submissionId, expectedRevision, ['submitted'], {
      status: 'reopened',
      last_actor: toUserId(actor),
      last_reason: reason,
    });
  }

  async #write(
    submissionId: string,
    expectedRevision: number,
    from: readonly SubmissionStatus[],
    changes: {
      answers?: Record<string, unknown>;
      status?: SubmissionStatus;
      last_actor: string;
      last_reason?: string | null;
    },
  ): Promise<WriteResult> {
    const row = await this.db
      .updateTable('submissions')
      .set({
        ...changes,
        ...(changes.answers === undefined ? {} : { answers: changes.answers }),
        revision: sql<number>`revision + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', submissionId)
      .where('revision', '=', expectedRevision)
      .where('status', 'in', [...from])
      .returningAll()
      .executeTakeFirst();

    if (row !== undefined) {
      return { outcome: 'written', submission: toDomain(row) };
    }

    const current = await this.findById(submissionId);
    if (current === undefined) {
      return { outcome: 'not_found', current };
    }
    if (current.revision !== expectedRevision) {
      return { outcome: 'conflict', current };
    }
    return { outcome: 'wrong_status', current };
  }

  /** Every submit, reopening and amendment, oldest first. */
  async listEvents(submissionId: string): Promise<SubmissionEvent[]> {
    const rows = await this.db
      .selectFrom('submission_events')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('submission_id', '=', submissionId)
      .orderBy('sequence')
      .execute();
    return rows.map(toEvent);
  }

  async listForVersion(formVersionId: string, limit = 100): Promise<Submission[]> {
    return (
      await this.#scoped()
        .selectAll()
        .where('form_version_id', '=', formVersionId)
        .orderBy('created_at', 'desc')
        .limit(limit)
        .execute()
    ).map(toDomain);
  }

  /**
   * Searches and filters, newest first, a page at a time.
   *
   * Pages are keyset, not offset: the ten-thousandth submission costs what the
   * first does, and a submission arriving while someone pages does not shift
   * every later page by one.
   */
  async list(query: SubmissionQuery = {}): Promise<SubmissionPage> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const column = query.order === 'updated' ? 'updated_at' : 'submitted_at';

    let select = this.#scoped().selectAll('submissions');

    if (query.formId !== undefined) {
      select = select.where('submissions.form_id', '=', query.formId);
    }
    if (query.statuses !== undefined && query.statuses.length > 0) {
      select = select.where('submissions.status', 'in', [...query.statuses]);
    }
    if (query.submittedBy !== undefined) {
      select = select.where('submissions.submitted_by', '=', query.submittedBy);
    }
    if (query.submittedFrom !== undefined) {
      select = select.where('submissions.submitted_at', '>=', query.submittedFrom);
    }
    if (query.submittedBefore !== undefined) {
      select = select.where('submissions.submitted_at', '<', query.submittedBefore);
    }
    if (query.text !== undefined && query.text.trim() !== '') {
      select = select.where(
        sql<boolean>`submissions.search @@ websearch_to_tsquery('simple', ${query.text.trim()})`,
      );
    }
    if (query.workOrderId !== undefined) {
      select = select.where('submissions.work_order_id', '=', query.workOrderId);
    }
    if (query.siteId !== undefined || query.customerId !== undefined) {
      const { siteId, customerId } = query;
      select = select.where((eb) => {
        let jobs = eb
          .selectFrom('work_orders')
          .select(sql`1`.as('one'))
          .where('work_orders.tenant_id', '=', this.tenantId)
          .whereRef('work_orders.id', '=', 'submissions.work_order_id');
        if (siteId !== undefined) {
          jobs = jobs.where('work_orders.site_id', '=', siteId);
        }
        if (customerId !== undefined) {
          jobs = jobs.where('work_orders.customer_id', '=', customerId);
        }
        return eb.exists(jobs);
      });
    }
    for (const filter of query.values ?? []) {
      if (query.formId === undefined) {
        throw new TypeError(
          'A value filter needs formId: a field id means something only within a form',
        );
      }
      const formId = query.formId;
      select = select.where((eb) => valueMatches(eb, this.tenantId, formId, filter));
    }
    if (column === 'submitted_at') {
      select = select.where('submissions.submitted_at', 'is not', null);
    }
    if (query.after !== undefined) {
      const { at, id } = query.after;
      select = select.where(
        sql<boolean>`(submissions.${sql.ref(column)}, submissions.id) < (${at}, ${id})`,
      );
    }

    const rows = await select
      .orderBy(`submissions.${column}`, 'desc')
      .orderBy('submissions.id', 'desc')
      .limit(limit + 1)
      .execute();

    const items = rows.slice(0, limit).map(toDomain);
    const last = items.at(-1);
    return {
      items,
      next:
        rows.length > limit && last !== undefined
          ? { at: (column === 'updated_at' ? last.updatedAt : last.submittedAt)!, id: last.id }
          : undefined,
    };
  }
}

const VALUE_COLUMN = {
  text: 'value_text',
  number: 'value_number',
  date: 'value_date',
  time: 'value_time',
  datetime: 'value_timestamp',
  boolean: 'value_boolean',
} as const;

const SQL_OPERATOR = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;

/** `exists` a reportable value of this submission matching the filter. Uses the per-type index. */
function valueMatches(
  eb: ExpressionBuilder<Database, 'submissions'>,
  tenantId: TenantId,
  formId: string,
  filter: ValueFilter,
) {
  const column = VALUE_COLUMN[filter.type];
  let values = eb
    .selectFrom('submission_values')
    .select(sql`1`.as('one'))
    .where('submission_values.tenant_id', '=', tenantId)
    .where('submission_values.form_id', '=', formId)
    .where('submission_values.field_id', '=', filter.field)
    .whereRef('submission_values.submission_id', '=', 'submissions.id');

  if (filter.operator === 'contains') {
    if (filter.type !== 'text') {
      throw new TypeError('"contains" applies to text values only');
    }
    values = values.where(
      sql<boolean>`submission_values.value_text ilike ${`%${escapeLike(filter.value)}%`}`,
    );
  } else {
    const cast = {
      text: sql`${filter.value}::text`,
      number: sql`${filter.value}::numeric`,
      date: sql`${filter.value}::date`,
      time: sql`${filter.value}::time`,
      datetime: sql`${filter.value}::timestamptz`,
      boolean: sql`${filter.value}::boolean`,
    }[filter.type];
    values = values.where(
      sql<boolean>`${sql.ref(`submission_values.${column}`)} ${sql.raw(SQL_OPERATOR[filter.operator])} ${cast}`,
    );
  }

  return eb.exists(values);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}

function toDomain(row: Selectable<SubmissionsTable>): Submission {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    formId: row.form_id,
    formVersionId: row.form_version_id,
    status: row.status,
    answers: row.answers,
    submittedBy: toUserId(row.submitted_by),
    submittedAt: row.submitted_at,
    amendedAt: row.amended_at,
    revision: row.revision,
    workOrderId: row.work_order_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvent(row: Selectable<SubmissionEventsTable>): SubmissionEvent {
  return {
    sequence: row.sequence,
    kind: row.kind,
    answers: row.answers,
    actorId: toUserId(row.actor_id),
    reason: row.reason,
    occurredAt: row.occurred_at,
  };
}
