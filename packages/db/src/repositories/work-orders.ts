import {
  canComplete,
  CLOSED_WORK_ORDER_STATES,
  type CompletionMissing,
  completionMissing,
  findTransition,
  type TenantId,
  type UserId,
  type WorkOrderPriority,
  type WorkOrderState,
  toTenantId,
  toUserId,
} from '@integr8/core';
import { type Selectable, sql, type Updateable } from 'kysely';
import type {
  CommentVisibility,
  SubmissionStatus,
  WorkOrderAssignmentsTable,
  WorkOrderChecklistItemsTable,
  WorkOrderCommentsTable,
  WorkOrderEventKind,
  WorkOrderEventsTable,
  WorkOrdersTable,
} from '../schema.js';
import { prefixQuery } from './customers.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export interface WorkOrder {
  id: string;
  tenantId: TenantId;
  reference: number;
  customerId: string;
  siteId: string;
  jobTypeId: string;
  title: string;
  description: string | null;
  instructions: string | null;
  priority: WorkOrderPriority;
  state: WorkOrderState;
  dueFrom: Date | null;
  dueBy: Date | null;
  stateChangedAt: Date;
  completedAt: Date | null;
  reviewedAt: Date | null;
  cancelledAt: Date | null;
  lastReason: string | null;
  revision: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
  /** Photos to take before and after the work, copied from the job type (P14). */
  beforePhotos: number;
  afterPhotos: number;
  signatureRequired: boolean;
  signoff: Signoff | null;
}

/** The customer's sign-off on a job, or why nobody could give one (P14). */
export type Signoff = {
  signedAt: Date;
  signedBy: UserId;
} & (
  | { fileId: string; name: string; role: string | null; unavailableReason: null }
  | { fileId: null; name: null; role: null; unavailableReason: string }
);

export type SignoffInput =
  { fileId: string; name: string; role?: string | null } | { unavailableReason: string };

export interface CrewMember {
  userId: string;
  lead: boolean;
}

export interface Assignment {
  id: string;
  userId: UserId;
  lead: boolean;
  assignedBy: UserId;
  assignedAt: Date;
}

export interface ChecklistItem {
  id: string;
  position: number;
  label: string;
  done: boolean;
  doneBy: UserId | null;
  doneAt: Date | null;
}

export interface WorkOrderForm {
  formId: string;
  title: string;
  required: boolean;
  position: number;
  /** The most recent submission of this form for this job, if anyone has started one. */
  submission: { id: string; status: SubmissionStatus; submittedAt: Date | null } | null;
}

export interface WorkOrderComment {
  id: string;
  authorId: UserId;
  visibility: CommentVisibility;
  body: string;
  createdAt: Date;
}

export interface WorkOrderEvent {
  id: string;
  kind: WorkOrderEventKind;
  fromState: WorkOrderState | null;
  toState: WorkOrderState | null;
  userId: UserId | null;
  actorId: UserId;
  reason: string | null;
  details: Record<string, unknown>;
  /** When it happened: for a change made offline, when the phone recorded it. */
  occurredAt: Date;
  /** When the server wrote it. */
  recordedAt: Date;
}

export interface CreateWorkOrderInput {
  customerId: string;
  siteId: string;
  jobTypeId: string;
  /** Defaults to the job type's name. */
  title?: string;
  description?: string | null;
  /** Defaults to the job type's instructions. */
  instructions?: string | null;
  /** Defaults to the job type's default priority. */
  priority?: WorkOrderPriority;
  dueFrom?: Date | null;
  dueBy?: Date | null;
  crew?: readonly CrewMember[];
}

export interface WorkOrderChanges {
  customerId?: string;
  siteId?: string;
  title?: string;
  description?: string | null;
  instructions?: string | null;
  priority?: WorkOrderPriority;
  dueFrom?: Date | null;
  dueBy?: Date | null;
}

export type WorkOrderOrder = 'due' | 'created' | 'reference';

export interface WorkOrderQuery {
  states?: readonly WorkOrderState[];
  priorities?: readonly WorkOrderPriority[];
  jobTypeIds?: readonly string[];
  customerId?: string;
  siteId?: string;
  /** Jobs this person is currently assigned to. */
  assigneeId?: string;
  /** Jobs nobody is assigned to. */
  unassigned?: boolean;
  /** Inclusive lower bound on `due_by`. */
  dueFrom?: Date;
  /** Exclusive upper bound on `due_by`. */
  dueBefore?: Date;
  /** Not closed, and due before now. */
  overdue?: boolean;
  /**
   * Closed (complete, reviewed or cancelled) at or after this instant: when it was completed,
   * or cancelled if it never was. A phone keeps this much history.
   */
  closedSince?: Date;
  /** Words from the title or description, or a reference such as `WO-000123` or `123`. */
  text?: string;
  order?: WorkOrderOrder;
  after?: string;
  limit?: number;
}

export interface WorkOrderPage {
  items: WorkOrder[];
  /** Opaque: pass it back as `after`. */
  next: string | undefined;
}

export type TransitionRefusal =
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; current: WorkOrder }
  | { outcome: 'not_allowed'; current: WorkOrder }
  | { outcome: 'reason_required'; current: WorkOrder }
  | { outcome: 'nobody_assigned'; current: WorkOrder }
  | { outcome: 'incomplete'; current: WorkOrder; missing: CompletionMissing }
  | { outcome: 'closed'; current: WorkOrder };

export type WorkOrderWrite = { outcome: 'written'; workOrder: WorkOrder } | TransitionRefusal;

/** Trimmed text, or null when there is none: an empty description is no description. */
function textOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** A reference as someone might type it: `WO-000123`, `wo123`, `123`. */
export function parseWorkOrderReference(text: string): number | undefined {
  const match = /^\s*(?:wo-?)?0*(\d{1,9})\s*$/iu.exec(text);
  return match === null ? undefined : Number(match[1]);
}

/** More changes than a timesheet shows at once: a sign the window is too wide. */
export const TIMESHEET_CHANGE_LIMIT = 10_000;

/**
 * Work orders for one company: the job, its crew, checklist, forms, comments
 * and history.
 *
 * Migration 0010 enforces the state machine, the reasons, dispatching only
 * with a crew and completing only with the required forms submitted — for every
 * client. This class checks the same things first so a refusal can say exactly
 * what is missing, and reports the database's refusal the same way if a
 * concurrent change got there between the check and the write.
 */
export class WorkOrdersRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  #workOrders() {
    return this.db.selectFrom('work_orders').where('work_orders.tenant_id', '=', this.tenantId);
  }

  async create(input: CreateWorkOrderInput, actor: UserId | string): Promise<WorkOrder> {
    const jobType = await this.db
      .selectFrom('job_types')
      .select([
        'name',
        'instructions',
        'default_priority',
        'checklist',
        'before_photos',
        'after_photos',
        'signature_required',
      ])
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', input.jobTypeId)
      .executeTakeFirstOrThrow();

    const row = await this.db
      .insertInto('work_orders')
      .values({
        tenant_id: this.tenantId,
        customer_id: input.customerId,
        site_id: input.siteId,
        job_type_id: input.jobTypeId,
        title: (input.title ?? jobType.name).trim(),
        description: input.description?.trim() ?? null,
        instructions:
          input.instructions === undefined ? jobType.instructions : textOrNull(input.instructions),
        priority: input.priority ?? jobType.default_priority,
        due_from: input.dueFrom ?? null,
        due_by: input.dueBy ?? null,
        before_photos: jobType.before_photos,
        after_photos: jobType.after_photos,
        signature_required: jobType.signature_required,
        last_actor: toUserId(actor),
        created_by: toUserId(actor),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.db
      .insertInto('work_order_forms')
      .columns(['tenant_id', 'work_order_id', 'form_id', 'required', 'position', 'added_by'])
      .expression((eb) =>
        eb
          .selectFrom('job_type_forms')
          .select([
            'job_type_forms.tenant_id',
            sql<string>`${row.id}::uuid`.as('work_order_id'),
            'job_type_forms.form_id',
            'job_type_forms.required',
            'job_type_forms.position',
            sql<string>`${toUserId(actor)}::uuid`.as('added_by'),
          ])
          .where('job_type_forms.tenant_id', '=', this.tenantId)
          .where('job_type_forms.job_type_id', '=', input.jobTypeId),
      )
      .execute();

    if (jobType.checklist.length > 0) {
      await this.db
        .insertInto('work_order_checklist_items')
        .values(
          jobType.checklist.map((item, position) => ({
            tenant_id: this.tenantId,
            work_order_id: row.id,
            position,
            label: item.label,
          })),
        )
        .execute();
    }

    if (input.crew !== undefined && input.crew.length > 0) {
      await this.setCrew(row.id, input.crew, actor);
    }
    return toWorkOrder(row);
  }

  async find(workOrderId: string): Promise<WorkOrder | undefined> {
    const row = await this.#workOrders()
      .selectAll()
      .where('id', '=', workOrderId)
      .executeTakeFirst();
    return row === undefined ? undefined : toWorkOrder(row);
  }

  async findMany(workOrderIds: readonly string[]): Promise<WorkOrder[]> {
    if (workOrderIds.length === 0) {
      return [];
    }
    return (
      await this.#workOrders()
        .selectAll()
        .where('id', 'in', [...new Set(workOrderIds)])
        .execute()
    ).map(toWorkOrder);
  }

  async findByReference(reference: number): Promise<WorkOrder | undefined> {
    const row = await this.#workOrders()
      .selectAll()
      .where('reference', '=', reference)
      .executeTakeFirst();
    return row === undefined ? undefined : toWorkOrder(row);
  }

  /** Whether this person is on the job's crew now. */
  async isAssigned(workOrderId: string, userId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('work_order_assignments')
      .select('id')
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', '=', workOrderId)
      .where('user_id', '=', userId)
      .where('unassigned_at', 'is', null)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Filters and pages. Keyset: each order carries its own cursor, encoded so the
   * caller treats it as opaque.
   */
  async list(query: WorkOrderQuery = {}): Promise<WorkOrderPage> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const order = query.order ?? 'due';
    let select = this.#workOrders().selectAll('work_orders');

    if (query.states !== undefined && query.states.length > 0) {
      select = select.where('work_orders.state', 'in', [...query.states]);
    }
    if (query.priorities !== undefined && query.priorities.length > 0) {
      select = select.where('work_orders.priority', 'in', [...query.priorities]);
    }
    if (query.jobTypeIds !== undefined && query.jobTypeIds.length > 0) {
      select = select.where('work_orders.job_type_id', 'in', [...query.jobTypeIds]);
    }
    if (query.customerId !== undefined) {
      select = select.where('work_orders.customer_id', '=', query.customerId);
    }
    if (query.siteId !== undefined) {
      select = select.where('work_orders.site_id', '=', query.siteId);
    }
    if (query.assigneeId !== undefined) {
      const assignee = query.assigneeId;
      select = select.where((eb) =>
        eb.exists(
          eb
            .selectFrom('work_order_assignments')
            .select(sql`1`.as('one'))
            .where('work_order_assignments.tenant_id', '=', this.tenantId)
            .whereRef('work_order_assignments.work_order_id', '=', 'work_orders.id')
            .where('work_order_assignments.user_id', '=', assignee)
            .where('work_order_assignments.unassigned_at', 'is', null),
        ),
      );
    }
    if (query.unassigned === true) {
      select = select.where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('work_order_assignments')
              .select(sql`1`.as('one'))
              .where('work_order_assignments.tenant_id', '=', this.tenantId)
              .whereRef('work_order_assignments.work_order_id', '=', 'work_orders.id')
              .where('work_order_assignments.unassigned_at', 'is', null),
          ),
        ),
      );
    }
    if (query.dueFrom !== undefined) {
      select = select.where('work_orders.due_by', '>=', query.dueFrom);
    }
    if (query.dueBefore !== undefined) {
      select = select.where('work_orders.due_by', '<', query.dueBefore);
    }
    if (query.overdue === true) {
      select = select
        .where('work_orders.due_by', '<', sql<Date>`now()`)
        .where('work_orders.state', 'not in', ['complete', 'reviewed', 'cancelled']);
    }
    if (query.closedSince !== undefined) {
      select = select
        .where('work_orders.state', 'in', ['complete', 'reviewed', 'cancelled'])
        .where(
          sql<Date>`coalesce(work_orders.completed_at, work_orders.cancelled_at)`,
          '>=',
          query.closedSince,
        );
    }
    if (query.text !== undefined && query.text.trim() !== '') {
      const reference = parseWorkOrderReference(query.text);
      const words = prefixQuery(query.text);
      select = select.where((eb) =>
        eb.or([
          ...(reference === undefined ? [] : [eb('work_orders.reference', '=', reference)]),
          ...(words === undefined
            ? []
            : [sql<boolean>`work_orders.search @@ to_tsquery('simple', ${words})`]),
        ]),
      );
    }

    const cursor = query.after === undefined ? undefined : decodeCursor(query.after);
    if (order === 'due') {
      // Undated jobs last; `infinity` keeps the comparison a single tuple.
      const key = sql`coalesce(work_orders.due_by, 'infinity'::timestamptz)`;
      if (cursor !== undefined) {
        select = select.where(
          sql<boolean>`(${key}, work_orders.id) > (${cursor.key}::timestamptz, ${cursor.id}::uuid)`,
        );
      }
      select = select.orderBy(key).orderBy('work_orders.id');
    } else if (order === 'created') {
      if (cursor !== undefined) {
        select = select.where(
          sql<boolean>`(work_orders.created_at, work_orders.id) < (${cursor.key}::timestamptz, ${cursor.id}::uuid)`,
        );
      }
      select = select.orderBy('work_orders.created_at', 'desc').orderBy('work_orders.id', 'desc');
    } else {
      if (cursor !== undefined) {
        select = select.where('work_orders.reference', '<', Number(cursor.key));
      }
      select = select.orderBy('work_orders.reference', 'desc');
    }

    const rows = await select.limit(limit + 1).execute();
    const items = rows.slice(0, limit).map(toWorkOrder);
    const last = items.at(-1);
    let next: string | undefined;
    if (rows.length > limit && last !== undefined) {
      const key =
        order === 'due'
          ? (last.dueBy?.toISOString() ?? 'infinity')
          : order === 'created'
            ? last.createdAt.toISOString()
            : String(last.reference);
      next = encodeCursor({ key, id: last.id });
    }
    return { items, next };
  }

  /** Counts by state for the same filters, without the state filter itself. */
  async countByState(query: Omit<WorkOrderQuery, 'states' | 'after' | 'limit' | 'order'> = {}) {
    const page = await this.#countSelect(query).execute();
    return Object.fromEntries(page.map((row) => [row.state, Number(row.count)])) as Partial<
      Record<WorkOrderState, number>
    >;
  }

  #countSelect(query: Omit<WorkOrderQuery, 'states' | 'after' | 'limit' | 'order'>) {
    let select = this.#workOrders().select([
      'work_orders.state',
      sql<string>`count(*)`.as('count'),
    ]);
    if (query.customerId !== undefined) {
      select = select.where('work_orders.customer_id', '=', query.customerId);
    }
    if (query.siteId !== undefined) {
      select = select.where('work_orders.site_id', '=', query.siteId);
    }
    if (query.assigneeId !== undefined) {
      const assignee = query.assigneeId;
      select = select.where((eb) =>
        eb.exists(
          eb
            .selectFrom('work_order_assignments')
            .select(sql`1`.as('one'))
            .where('work_order_assignments.tenant_id', '=', this.tenantId)
            .whereRef('work_order_assignments.work_order_id', '=', 'work_orders.id')
            .where('work_order_assignments.user_id', '=', assignee)
            .where('work_order_assignments.unassigned_at', 'is', null),
        ),
      );
    }
    return select.groupBy('work_orders.state');
  }

  // -------------------------------------------------------------------------
  // Changes
  // -------------------------------------------------------------------------

  async update(
    workOrderId: string,
    expectedRevision: number,
    changes: WorkOrderChanges,
    actor: UserId | string,
    reason?: string,
  ): Promise<WorkOrderWrite> {
    const current = await this.find(workOrderId);
    if (current === undefined) {
      return { outcome: 'not_found' };
    }
    if (current.revision !== expectedRevision) {
      return { outcome: 'conflict', current };
    }
    if (['complete', 'reviewed', 'cancelled'].includes(current.state)) {
      return { outcome: 'closed', current };
    }
    const columns = {
      ...(changes.customerId === undefined ? {} : { customer_id: changes.customerId }),
      ...(changes.siteId === undefined ? {} : { site_id: changes.siteId }),
      ...(changes.title === undefined ? {} : { title: changes.title.trim() }),
      ...(changes.description === undefined
        ? {}
        : { description: textOrNull(changes.description) }),
      ...(changes.instructions === undefined
        ? {}
        : { instructions: textOrNull(changes.instructions) }),
      ...(changes.priority === undefined ? {} : { priority: changes.priority }),
      ...(changes.dueFrom === undefined ? {} : { due_from: changes.dueFrom }),
      ...(changes.dueBy === undefined ? {} : { due_by: changes.dueBy }),
    };
    return this.#write(workOrderId, expectedRevision, {
      ...columns,
      last_actor: toUserId(actor),
      last_reason: textOrNull(reason),
    });
  }

  /**
   * Moves a job to another state, if the state machine and its preconditions allow it.
   *
   * `happenedAt` is when a phone recorded the change offline (P14): the job and its
   * history say it happened then, kept by the database between the previous state
   * change and now.
   */
  async transition(
    workOrderId: string,
    expectedRevision: number,
    to: WorkOrderState,
    actor: UserId | string,
    reason?: string,
    options: { happenedAt?: Date } = {},
  ): Promise<WorkOrderWrite> {
    const current = await this.find(workOrderId);
    if (current === undefined) {
      return { outcome: 'not_found' };
    }
    if (current.revision !== expectedRevision) {
      return { outcome: 'conflict', current };
    }
    const transition = findTransition(current.state, to);
    if (transition === undefined) {
      return { outcome: 'not_allowed', current };
    }
    const why = reason?.trim() ?? '';
    if (transition.requiresReason && why === '') {
      return { outcome: 'reason_required', current };
    }
    if (to === 'dispatched' && (await this.listCrew(workOrderId)).length === 0) {
      return { outcome: 'nobody_assigned', current };
    }
    if (to === 'complete') {
      const missing = await this.completionMissing(current);
      if (!canComplete(missing)) {
        return { outcome: 'incomplete', current, missing };
      }
    }
    if (options.happenedAt !== undefined) {
      await sql`select set_config('integr8.happened_at', ${options.happenedAt.toISOString()}, true)`.execute(
        this.db,
      );
    }
    try {
      return await this.#write(workOrderId, expectedRevision, {
        state: to,
        last_actor: toUserId(actor),
        last_reason: why === '' ? null : why,
      });
    } finally {
      if (options.happenedAt !== undefined) {
        await sql`select set_config('integr8.happened_at', '', true)`.execute(this.db);
      }
    }
  }

  /** What stands between a job and completing it, in the terms every client uses. */
  async completionMissing(job: WorkOrder): Promise<CompletionMissing> {
    const [forms, photos] = await Promise.all([this.listForms(job.id), this.photoCounts(job.id)]);
    return completionMissing({
      forms: forms.map((form) => ({
        formId: form.formId,
        title: form.title,
        required: form.required,
        submitted: form.submission?.status === 'submitted',
      })),
      photos: {
        before: { needed: job.beforePhotos, taken: photos.before },
        after: { needed: job.afterPhotos, taken: photos.after },
      },
      signoff: { required: job.signatureRequired, recorded: job.signoff !== null },
    });
  }

  /** Before and after photos on a job, not removed. */
  async photoCounts(workOrderId: string): Promise<{ before: number; after: number }> {
    const rows = await this.db
      .selectFrom('attachments')
      .select(['stage', (eb) => eb.fn.countAll<string>().as('count')])
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', '=', workOrderId)
      .where('removed_at', 'is', null)
      .where('stage', 'is not', null)
      .groupBy('stage')
      .execute();
    const count = (stage: string) => Number(rows.find((row) => row.stage === stage)?.count ?? 0);
    return { before: count('before'), after: count('after') };
  }

  /**
   * Records the customer's sign-off, or why nobody could sign, replacing an earlier
   * one. Refused once the job is closed: a completed job's sign-off is part of it.
   */
  async signOff(
    workOrderId: string,
    input: SignoffInput & { signedAt: Date },
    actor: UserId | string,
  ): Promise<
    { outcome: 'written'; workOrder: WorkOrder } | { outcome: 'not_found' } | { outcome: 'closed' }
  > {
    const signed = 'fileId' in input;
    const row = await this.db
      .updateTable('work_orders')
      .set({
        signed_off_at: input.signedAt,
        signed_off_by: toUserId(actor),
        signoff_file_id: signed ? input.fileId : null,
        signoff_name: signed ? input.name.trim() : null,
        signoff_role: signed ? textOrNull(input.role) : null,
        signoff_unavailable_reason: signed ? null : input.unavailableReason.trim(),
        last_actor: toUserId(actor),
        last_reason: null,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', workOrderId)
      .where('state', 'not in', [...CLOSED_WORK_ORDER_STATES])
      .returningAll()
      .executeTakeFirst();
    if (row !== undefined) {
      return { outcome: 'written', workOrder: toWorkOrder(row) };
    }
    return (await this.find(workOrderId)) === undefined
      ? { outcome: 'not_found' }
      : { outcome: 'closed' };
  }

  async #write(
    workOrderId: string,
    expectedRevision: number,
    columns: Updateable<WorkOrdersTable> & { last_actor: string; last_reason: string | null },
  ): Promise<WorkOrderWrite> {
    // A savepoint, so a refusal from the database leaves the transaction usable
    // for reading back what the job is now.
    await sql`savepoint work_order_write`.execute(this.db);
    try {
      const row = await this.db
        .updateTable('work_orders')
        .set(columns)
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', workOrderId)
        .where('revision', '=', expectedRevision)
        .returningAll()
        .executeTakeFirst();
      await sql`release savepoint work_order_write`.execute(this.db);
      if (row !== undefined) {
        return { outcome: 'written', workOrder: toWorkOrder(row) };
      }
    } catch (error) {
      // The database's own refusal of something that changed after the checks
      // above: a form reopened, a crew emptied, a state moved on.
      const code = (error as { code?: string }).code;
      if (code !== '23514' && code !== '55000') {
        throw error;
      }
      await sql`rollback to savepoint work_order_write`.execute(this.db);
      const current = await this.find(workOrderId);
      if (current === undefined) {
        return { outcome: 'not_found' };
      }
      return { outcome: 'not_allowed', current };
    }
    const current = await this.find(workOrderId);
    return current === undefined ? { outcome: 'not_found' } : { outcome: 'conflict', current };
  }

  // -------------------------------------------------------------------------
  // Crew
  // -------------------------------------------------------------------------

  async listCrew(workOrderId: string): Promise<Assignment[]> {
    return (
      await this.db
        .selectFrom('work_order_assignments')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('work_order_id', '=', workOrderId)
        .where('unassigned_at', 'is', null)
        .orderBy('is_lead', 'desc')
        .orderBy('assigned_at')
        .execute()
    ).map(toAssignment);
  }

  /** Current crews for many jobs at once, for a list. */
  async listCrews(workOrderIds: readonly string[]): Promise<Map<string, Assignment[]>> {
    const crews = new Map<string, Assignment[]>();
    if (workOrderIds.length === 0) {
      return crews;
    }
    const rows = await this.db
      .selectFrom('work_order_assignments')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', 'in', [...new Set(workOrderIds)])
      .where('unassigned_at', 'is', null)
      .orderBy('is_lead', 'desc')
      .orderBy('assigned_at')
      .execute();
    for (const row of rows) {
      crews.set(row.work_order_id, [...(crews.get(row.work_order_id) ?? []), toAssignment(row)]);
    }
    return crews;
  }

  /**
   * Makes the crew exactly these people. At most one lead; a crew of one with no
   * lead named makes that person lead. People taken off are unassigned, not
   * deleted, so the history says who took them off.
   */
  async setCrew(
    workOrderId: string,
    crew: readonly CrewMember[],
    actor: UserId | string,
  ): Promise<Assignment[]> {
    const wanted = new Map(crew.map((member) => [member.userId, member.lead]));
    const leads = [...wanted.entries()].filter(([, lead]) => lead).map(([userId]) => userId);
    if (leads.length > 1) {
      throw new RangeError('A crew has at most one lead');
    }
    const lead = leads[0] ?? (wanted.size === 1 ? [...wanted.keys()][0] : undefined);
    const current = await this.listCrew(workOrderId);
    const by = toUserId(actor);

    const leaving = current.filter((member) => !wanted.has(member.userId));
    if (leaving.length > 0) {
      await this.db
        .updateTable('work_order_assignments')
        .set({ unassigned_at: sql<Date>`now()`, unassigned_by: by, is_lead: false })
        .where('tenant_id', '=', this.tenantId)
        .where(
          'id',
          'in',
          leaving.map((member) => member.id),
        )
        .execute();
    }
    // Clear a lead that is changing hands before naming the new one: one lead at a time.
    const staying = current.filter((member) => wanted.has(member.userId));
    for (const member of staying) {
      if (member.lead && member.userId !== lead) {
        await this.#setLead(member.id, false, by);
      }
    }
    const arriving = [...wanted.keys()].filter(
      (userId) => !current.some((member) => member.userId === userId),
    );
    if (arriving.length > 0) {
      await this.db
        .insertInto('work_order_assignments')
        .values(
          arriving.map((userId) => ({
            tenant_id: this.tenantId,
            work_order_id: workOrderId,
            user_id: userId,
            is_lead: userId === lead,
            assigned_by: by,
          })),
        )
        .execute();
    }
    for (const member of staying) {
      if (!member.lead && member.userId === lead) {
        await this.#setLead(member.id, true, by);
      }
    }
    return this.listCrew(workOrderId);
  }

  async #setLead(assignmentId: string, lead: boolean, by: UserId) {
    await this.db
      .updateTable('work_order_assignments')
      .set({ is_lead: lead, assigned_by: by })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', assignmentId)
      .execute();
  }

  // -------------------------------------------------------------------------
  // Checklist, forms, comments, history
  // -------------------------------------------------------------------------

  async listChecklist(workOrderId: string): Promise<ChecklistItem[]> {
    return (
      await this.db
        .selectFrom('work_order_checklist_items')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('work_order_id', '=', workOrderId)
        .orderBy('position')
        .execute()
    ).map(toChecklistItem);
  }

  async addChecklistItem(workOrderId: string, label: string): Promise<ChecklistItem> {
    const row = await this.db
      .insertInto('work_order_checklist_items')
      .values({
        tenant_id: this.tenantId,
        work_order_id: workOrderId,
        label: label.trim(),
        position: sql<number>`(select coalesce(max(position) + 1, 0) from work_order_checklist_items where tenant_id = ${this.tenantId} and work_order_id = ${workOrderId})`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toChecklistItem(row);
  }

  async setChecklistItem(
    workOrderId: string,
    itemId: string,
    done: boolean,
    actor: UserId | string,
  ): Promise<ChecklistItem | undefined> {
    const row = await this.db
      .updateTable('work_order_checklist_items')
      .set(
        done
          ? { done: true, done_by: toUserId(actor), done_at: sql<Date>`now()` }
          : { done: false, done_by: null, done_at: null },
      )
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', '=', workOrderId)
      .where('id', '=', itemId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toChecklistItem(row);
  }

  /** The job's forms, each with its most recent submission for this job. */
  async listForms(workOrderId: string): Promise<WorkOrderForm[]> {
    const rows = await this.db
      .selectFrom('work_order_forms')
      .innerJoin('forms', (join) =>
        join
          .onRef('forms.tenant_id', '=', 'work_order_forms.tenant_id')
          .onRef('forms.id', '=', 'work_order_forms.form_id'),
      )
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('submissions')
            .select(['submissions.id', 'submissions.status', 'submissions.submitted_at'])
            .where('submissions.tenant_id', '=', this.tenantId)
            .whereRef('submissions.work_order_id', '=', 'work_order_forms.work_order_id')
            .whereRef('submissions.form_id', '=', 'work_order_forms.form_id')
            // A submitted one counts before a draft started later.
            .orderBy(
              sql`case submissions.status when 'submitted' then 0 when 'reopened' then 1 else 2 end`,
            )
            .orderBy('submissions.updated_at', 'desc')
            .limit(1)
            .as('latest'),
        (join) => join.onTrue(),
      )
      .select([
        'work_order_forms.form_id',
        'work_order_forms.required',
        'work_order_forms.position',
        'forms.title',
        'latest.id as submission_id',
        'latest.status as submission_status',
        'latest.submitted_at as submission_submitted_at',
      ])
      .where('work_order_forms.tenant_id', '=', this.tenantId)
      .where('work_order_forms.work_order_id', '=', workOrderId)
      .orderBy('work_order_forms.position')
      .orderBy('forms.title')
      .execute();
    return rows.map((row) => ({
      formId: row.form_id,
      title: row.title,
      required: row.required,
      position: row.position,
      submission:
        row.submission_id === null || row.submission_status === null
          ? null
          : {
              id: row.submission_id,
              status: row.submission_status,
              submittedAt: row.submission_submitted_at,
            },
    }));
  }

  /** Adds a form to one job. Adding one already there changes whether it is required. */
  async addForm(
    workOrderId: string,
    formId: string,
    required: boolean,
    actor: UserId | string,
  ): Promise<void> {
    await this.db
      .insertInto('work_order_forms')
      .values({
        tenant_id: this.tenantId,
        work_order_id: workOrderId,
        form_id: formId,
        required,
        added_by: toUserId(actor),
        position: sql<number>`(select coalesce(max(position) + 1, 0) from work_order_forms where tenant_id = ${this.tenantId} and work_order_id = ${workOrderId})`,
      })
      .onConflict((conflict) =>
        conflict.columns(['tenant_id', 'work_order_id', 'form_id']).doUpdateSet({ required }),
      )
      .execute();
  }

  /** Removes a form nobody has started for this job. Returns false if someone has. */
  async removeForm(workOrderId: string, formId: string): Promise<boolean> {
    const started = await this.db
      .selectFrom('submissions')
      .select('id')
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', '=', workOrderId)
      .where('form_id', '=', formId)
      .executeTakeFirst();
    if (started !== undefined) {
      return false;
    }
    await this.db
      .deleteFrom('work_order_forms')
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', '=', workOrderId)
      .where('form_id', '=', formId)
      .execute();
    return true;
  }

  /** A comment by id, on any job in the company. */
  async findComment(
    commentId: string,
  ): Promise<(WorkOrderComment & { workOrderId: string }) | undefined> {
    const row = await this.db
      .selectFrom('work_order_comments')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', commentId)
      .executeTakeFirst();
    return row === undefined ? undefined : { ...toComment(row), workOrderId: row.work_order_id };
  }

  async addComment(
    workOrderId: string,
    input: {
      body: string;
      visibility: CommentVisibility;
      /** Chosen by a phone that wrote the comment offline (P12), so a resend finds it. */
      id?: string;
    },
    author: UserId | string,
  ): Promise<WorkOrderComment> {
    const row = await this.db
      .insertInto('work_order_comments')
      .values({
        ...(input.id === undefined ? {} : { id: input.id }),
        tenant_id: this.tenantId,
        work_order_id: workOrderId,
        author_id: toUserId(author),
        visibility: input.visibility,
        body: input.body.trim(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toComment(row);
  }

  async listComments(
    workOrderId: string,
    visibility?: CommentVisibility,
  ): Promise<WorkOrderComment[]> {
    let select = this.db
      .selectFrom('work_order_comments')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', '=', workOrderId);
    if (visibility !== undefined) {
      select = select.where('visibility', '=', visibility);
    }
    return (await select.orderBy('created_at').orderBy('id').execute()).map(toComment);
  }

  /**
   * What a timesheet is made of: the jobs worked in a window, each with its whole
   * history there — whoever tapped each change, since a crew shares one job — and
   * the change before the window, so a job already under way when the window
   * opens is counted from its start. With a person, the jobs they changed or were
   * on the crew of; with none, every job changed in the window.
   */
  async listTransitions(query: { from: Date; to: Date; userId?: UserId | string }): Promise<{
    changes: (WorkOrderEvent & { workOrderId: string })[];
    crews: { workOrderId: string; userId: string }[];
    truncated: boolean;
  }> {
    const limit = TIMESHEET_CHANGE_LIMIT;
    const inWindow = this.db
      .selectFrom('work_order_events')
      .select('work_order_id')
      .where('tenant_id', '=', this.tenantId)
      .where('kind', '=', 'transitioned')
      .where('occurred_at', '>=', query.from)
      .where('occurred_at', '<', query.to);
    let jobs = inWindow;
    if (query.userId !== undefined) {
      const userId = toUserId(query.userId);
      jobs = inWindow.where((where) =>
        where.or([
          where('actor_id', '=', userId),
          where(
            'work_order_id',
            'in',
            this.db
              .selectFrom('work_order_assignments')
              .select('work_order_id')
              .where('tenant_id', '=', this.tenantId)
              .where('user_id', '=', userId)
              .where('assigned_at', '<', query.to)
              .where((open) =>
                open.or([
                  open('unassigned_at', 'is', null),
                  open('unassigned_at', '>', query.from),
                ]),
              ),
          ),
        ]),
      );
    }
    const ids = [...new Set((await jobs.execute()).map((row) => row.work_order_id))];
    if (ids.length === 0) {
      return { changes: [], crews: [], truncated: false };
    }
    const [rows, before, crews] = await Promise.all([
      this.db
        .selectFrom('work_order_events')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('kind', '=', 'transitioned')
        .where('work_order_id', 'in', ids)
        .where('occurred_at', '>=', query.from)
        .where('occurred_at', '<', query.to)
        .orderBy('occurred_at')
        .limit(limit + 1)
        .execute(),
      this.db
        .selectFrom('work_order_events')
        .selectAll()
        .distinctOn('work_order_id')
        .where('tenant_id', '=', this.tenantId)
        .where('kind', '=', 'transitioned')
        .where('work_order_id', 'in', ids)
        .where('occurred_at', '<', query.from)
        .orderBy('work_order_id')
        .orderBy('occurred_at', 'desc')
        .execute(),
      this.db
        .selectFrom('work_order_assignments')
        .select(['work_order_id', 'user_id'])
        .distinct()
        .where('tenant_id', '=', this.tenantId)
        .where('work_order_id', 'in', ids)
        .where('assigned_at', '<', query.to)
        .where((open) =>
          open.or([open('unassigned_at', 'is', null), open('unassigned_at', '>', query.from)]),
        )
        .execute(),
    ]);
    const withJob = (row: (typeof rows)[number]) => ({
      ...toEvent(row),
      workOrderId: row.work_order_id,
    });
    return {
      changes: [...before.map(withJob), ...rows.slice(0, limit).map(withJob)].sort(
        (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
      ),
      crews: crews.map((row) => ({ workOrderId: row.work_order_id, userId: row.user_id })),
      truncated: rows.length > limit,
    };
  }

  /** One history entry, with the job it belongs to. */
  async findEvent(
    eventId: string,
  ): Promise<(WorkOrderEvent & { workOrderId: string }) | undefined> {
    const row = await this.db
      .selectFrom('work_order_events')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', eventId)
      .executeTakeFirst();
    return row === undefined ? undefined : { ...toEvent(row), workOrderId: row.work_order_id };
  }

  async listEvents(workOrderId: string): Promise<WorkOrderEvent[]> {
    return (
      await this.db
        .selectFrom('work_order_events')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('work_order_id', '=', workOrderId)
        .orderBy('sequence')
        .execute()
    ).map(toEvent);
  }

  /** Earlier jobs at the same site, newest first: what "previous reports" means on a job. */
  async listPreviousAtSite(siteId: string, excluding: string, limit = 10): Promise<WorkOrder[]> {
    return (
      await this.#workOrders()
        .selectAll()
        .where('site_id', '=', siteId)
        .where('id', '<>', excluding)
        .orderBy('created_at', 'desc')
        .limit(limit)
        .execute()
    ).map(toWorkOrder);
  }
}

function encodeCursor(cursor: { key: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): { key: string; id: string } | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { key?: unknown }).key === 'string' &&
      typeof (parsed as { id?: unknown }).id === 'string' &&
      /^[0-9a-f-]{36}$/u.test((parsed as { id: string }).id)
    ) {
      return parsed as { key: string; id: string };
    }
  } catch {
    // Fall through: a cursor that does not parse is treated as no cursor at all.
  }
  return undefined;
}

function toWorkOrder(row: Selectable<WorkOrdersTable>): WorkOrder {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    reference: row.reference,
    customerId: row.customer_id,
    siteId: row.site_id,
    jobTypeId: row.job_type_id,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
    priority: row.priority,
    state: row.state,
    dueFrom: row.due_from,
    dueBy: row.due_by,
    stateChangedAt: row.state_changed_at,
    completedAt: row.completed_at,
    reviewedAt: row.reviewed_at,
    cancelledAt: row.cancelled_at,
    lastReason: row.last_reason,
    revision: row.revision,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    beforePhotos: row.before_photos,
    afterPhotos: row.after_photos,
    signatureRequired: row.signature_required,
    signoff: toSignoff(row),
  };
}

function toSignoff(row: Selectable<WorkOrdersTable>): Signoff | null {
  if (row.signed_off_at === null || row.signed_off_by === null) {
    return null;
  }
  const base = { signedAt: row.signed_off_at, signedBy: toUserId(row.signed_off_by) };
  return row.signoff_file_id === null
    ? {
        ...base,
        fileId: null,
        name: null,
        role: null,
        unavailableReason: row.signoff_unavailable_reason ?? '',
      }
    : {
        ...base,
        fileId: row.signoff_file_id,
        name: row.signoff_name ?? '',
        role: row.signoff_role,
        unavailableReason: null,
      };
}

function toAssignment(row: Selectable<WorkOrderAssignmentsTable>): Assignment {
  return {
    id: row.id,
    userId: toUserId(row.user_id),
    lead: row.is_lead,
    assignedBy: toUserId(row.assigned_by),
    assignedAt: row.assigned_at,
  };
}

function toChecklistItem(row: Selectable<WorkOrderChecklistItemsTable>): ChecklistItem {
  return {
    id: row.id,
    position: row.position,
    label: row.label,
    done: row.done,
    doneBy: row.done_by === null ? null : toUserId(row.done_by),
    doneAt: row.done_at,
  };
}

function toComment(row: Selectable<WorkOrderCommentsTable>): WorkOrderComment {
  return {
    id: row.id,
    authorId: toUserId(row.author_id),
    visibility: row.visibility,
    body: row.body,
    createdAt: row.created_at,
  };
}

function toEvent(row: Selectable<WorkOrderEventsTable>): WorkOrderEvent {
  return {
    id: row.id,
    kind: row.kind,
    fromState: row.from_state,
    toState: row.to_state,
    userId: row.user_id === null ? null : toUserId(row.user_id),
    actorId: toUserId(row.actor_id),
    reason: row.reason,
    details: row.details,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
}
