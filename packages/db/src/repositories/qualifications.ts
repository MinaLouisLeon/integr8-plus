import {
  type QualificationHolding,
  type QualificationKind,
  type QualificationRequirement,
  toUserId,
  type UserId,
} from '@integr8/core';
import { sql } from 'kysely';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/** A skill or certificate the company tracks (P26, migration 0052). */
export interface QualificationType {
  id: string;
  name: string;
  kind: QualificationKind;
  description: string | null;
  version: number;
  archivedAt: Date | null;
  createdAt: Date;
}

/** One record of a qualification a member holds. Dates are `YYYY-MM-DD`. */
export interface MemberQualification {
  id: string;
  userId: UserId;
  qualificationTypeId: string;
  reference: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  notes: string | null;
  version: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
  removedAt: Date | null;
  removedBy: UserId | null;
}

export interface QualificationTypeInput {
  name: string;
  kind: QualificationKind;
  description?: string | null;
}

export interface MemberQualificationInput {
  userId: string;
  qualificationTypeId: string;
  reference?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  notes?: string | null;
}

export type MemberQualificationChanges = Partial<
  Pick<MemberQualificationInput, 'reference' | 'issuedOn' | 'expiresOn' | 'notes'>
>;

export type QualificationTypeWrite =
  | { outcome: 'written'; type: QualificationType }
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; current: QualificationType }
  | { outcome: 'name_taken' };

export type MemberQualificationWrite =
  | { outcome: 'written'; record: MemberQualification }
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; current: MemberQualification }
  | { outcome: 'removed'; current: MemberQualification }
  | { outcome: 'type_unknown' }
  | { outcome: 'type_archived' }
  | { outcome: 'member_unknown' }
  | { outcome: 'skill_expires' }
  | { outcome: 'dates_reversed' };

export interface QualificationOverrideInput {
  workOrderId: string;
  visitId: string;
  reason: string;
  missing: readonly { qualificationTypeId: string; name: string }[];
  assigneeIds: readonly string[];
  startsAt: Date;
  endsAt: Date;
}

export interface QualificationOverride {
  id: string;
  workOrderId: string;
  visitId: string;
  reason: string;
  missing: { qualificationTypeId: string; name: string }[];
  assigneeIds: UserId[];
  startsAt: Date;
  endsAt: Date;
  createdBy: UserId;
  createdAt: Date;
}

/** A certificate whose expiry somebody should hear about. */
export interface ExpiryAlert {
  record: MemberQualification;
  typeName: string;
  stage: 'warning' | 'lapsed';
}

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const NOT_IN_PREREQUISITE_STATE = '55000';

/** Trimmed text, or null when there is none; undefined stays undefined. */
function blank(value: string | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * Skills and certificates for one company (P26).
 *
 * Migration 0052 keeps the records honest for every client: a skill never
 * expires, a removed record is final, an archived type takes no new records.
 * The rule the board applies — someone on each visit holds each requirement —
 * lives in `@integr8/core` and the API, because it depends on today's date.
 */
export class QualificationsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  // -------------------------------------------------------------------------
  // The company's list
  // -------------------------------------------------------------------------

  async listTypes(options: { includeArchived?: boolean } = {}): Promise<QualificationType[]> {
    let select = this.db
      .selectFrom('qualification_types')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (options.includeArchived !== true) {
      select = select.where('archived_at', 'is', null);
    }
    const rows = await select
      .orderBy(sql`lower(name)`)
      .orderBy('id')
      .execute();
    return rows.map(toType);
  }

  async findTypes(typeIds: readonly string[]): Promise<QualificationType[]> {
    if (typeIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('qualification_types')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', 'in', [...new Set(typeIds)])
      .execute();
    return rows.map(toType);
  }

  async findType(typeId: string): Promise<QualificationType | undefined> {
    return (await this.findTypes([typeId]))[0];
  }

  async createType(
    input: QualificationTypeInput,
    actor: UserId | string,
  ): Promise<QualificationTypeWrite> {
    return this.#typeWrite(async () => {
      const row = await this.db
        .insertInto('qualification_types')
        .values({
          tenant_id: this.tenantId,
          name: input.name.trim(),
          kind: input.kind,
          description: blank(input.description) ?? null,
          created_by: toUserId(actor),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
  }

  /** Renames, describes, archives or restores. The kind never changes. */
  async updateType(
    typeId: string,
    expectedVersion: number,
    changes: { name?: string; description?: string | null; archived?: boolean },
  ): Promise<QualificationTypeWrite> {
    const current = await this.findType(typeId);
    if (current === undefined) {
      return { outcome: 'not_found' };
    }
    if (current.version !== expectedVersion) {
      return { outcome: 'conflict', current };
    }
    return this.#typeWrite(async () => {
      const description = blank(changes.description);
      const row = await this.db
        .updateTable('qualification_types')
        .set({
          ...(changes.name === undefined ? {} : { name: changes.name.trim() }),
          ...(description === undefined ? {} : { description }),
          ...(changes.archived === undefined
            ? {}
            : { archived_at: changes.archived ? sql<Date>`coalesce(archived_at, now())` : null }),
        })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', typeId)
        .where('version', '=', expectedVersion)
        .returning('id')
        .executeTakeFirst();
      return row?.id;
    }, typeId);
  }

  // -------------------------------------------------------------------------
  // What people hold
  // -------------------------------------------------------------------------

  #records() {
    return this.db
      .selectFrom('member_qualifications')
      .select([
        'id',
        'user_id',
        'qualification_type_id',
        'reference',
        sql<string | null>`issued_on::text`.as('issued_on'),
        sql<string | null>`expires_on::text`.as('expires_on'),
        'notes',
        'version',
        'created_by',
        'created_at',
        'updated_at',
        'removed_at',
        'removed_by',
      ])
      .where('member_qualifications.tenant_id', '=', this.tenantId);
  }

  /** Records, newest expiry last. Removed ones only when asked. */
  async listRecords(
    query: {
      userIds?: readonly string[];
      typeIds?: readonly string[];
      includeRemoved?: boolean;
    } = {},
  ): Promise<MemberQualification[]> {
    let select = this.#records();
    if (query.userIds !== undefined) {
      if (query.userIds.length === 0) {
        return [];
      }
      select = select.where('user_id', 'in', [...new Set(query.userIds)]);
    }
    if (query.typeIds !== undefined) {
      if (query.typeIds.length === 0) {
        return [];
      }
      select = select.where('qualification_type_id', 'in', [...new Set(query.typeIds)]);
    }
    if (query.includeRemoved !== true) {
      select = select.where('removed_at', 'is', null);
    }
    const rows = await select
      .orderBy('user_id')
      .orderBy('qualification_type_id')
      .orderBy(sql`expires_on nulls last`)
      .orderBy('created_at')
      .limit(10_000)
      .execute();
    return rows.map(toRecord);
  }

  async findRecord(recordId: string): Promise<MemberQualification | undefined> {
    const row = await this.#records().where('id', '=', recordId).executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async addRecord(
    input: MemberQualificationInput,
    actor: UserId | string,
  ): Promise<MemberQualificationWrite> {
    const type = await this.findType(input.qualificationTypeId);
    if (type === undefined) {
      return { outcome: 'type_unknown' };
    }
    if (type.archivedAt !== null) {
      return { outcome: 'type_archived' };
    }
    const problem = datesProblem(type.kind, input.issuedOn ?? null, input.expiresOn ?? null);
    if (problem !== undefined) {
      return { outcome: problem };
    }
    return this.#recordWrite(async () => {
      const row = await this.db
        .insertInto('member_qualifications')
        .values({
          tenant_id: this.tenantId,
          user_id: input.userId,
          qualification_type_id: input.qualificationTypeId,
          reference: blank(input.reference) ?? null,
          issued_on: input.issuedOn ?? null,
          expires_on: input.expiresOn ?? null,
          notes: blank(input.notes) ?? null,
          created_by: toUserId(actor),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
  }

  async updateRecord(
    recordId: string,
    expectedVersion: number,
    changes: MemberQualificationChanges,
  ): Promise<MemberQualificationWrite> {
    const current = await this.findRecord(recordId);
    if (current === undefined) {
      return { outcome: 'not_found' };
    }
    if (current.removedAt !== null) {
      return { outcome: 'removed', current };
    }
    if (current.version !== expectedVersion) {
      return { outcome: 'conflict', current };
    }
    const type = await this.findType(current.qualificationTypeId);
    const issuedOn = changes.issuedOn === undefined ? current.issuedOn : changes.issuedOn;
    const expiresOn = changes.expiresOn === undefined ? current.expiresOn : changes.expiresOn;
    const problem = datesProblem(type?.kind ?? 'certificate', issuedOn, expiresOn);
    if (problem !== undefined) {
      return { outcome: problem };
    }
    return this.#recordWrite(async () => {
      const reference = blank(changes.reference);
      const notes = blank(changes.notes);
      const row = await this.db
        .updateTable('member_qualifications')
        .set({
          ...(reference === undefined ? {} : { reference }),
          ...(notes === undefined ? {} : { notes }),
          ...(changes.issuedOn === undefined ? {} : { issued_on: changes.issuedOn }),
          ...(changes.expiresOn === undefined ? {} : { expires_on: changes.expiresOn }),
        })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', recordId)
        .where('version', '=', expectedVersion)
        .where('removed_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      return row?.id;
    }, recordId);
  }

  /** Takes a record away. Final; it stays in the history. */
  async removeRecord(
    recordId: string,
    expectedVersion: number,
    actor: UserId | string,
  ): Promise<MemberQualificationWrite> {
    const current = await this.findRecord(recordId);
    if (current === undefined) {
      return { outcome: 'not_found' };
    }
    if (current.removedAt !== null) {
      return { outcome: 'removed', current };
    }
    if (current.version !== expectedVersion) {
      return { outcome: 'conflict', current };
    }
    return this.#recordWrite(async () => {
      const row = await this.db
        .updateTable('member_qualifications')
        .set({ removed_at: sql<Date>`now()`, removed_by: toUserId(actor) })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', recordId)
        .where('version', '=', expectedVersion)
        .where('removed_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      return row?.id;
    }, recordId);
  }

  /** What these people hold of these qualifications, for checking a visit. */
  async holdings(
    userIds: readonly string[],
    typeIds: readonly string[],
  ): Promise<QualificationHolding[]> {
    const records = await this.listRecords({ userIds, typeIds });
    return records.map((record) => ({
      userId: record.userId,
      qualificationTypeId: record.qualificationTypeId,
      issuedOn: record.issuedOn,
      expiresOn: record.expiresOn,
    }));
  }

  // -------------------------------------------------------------------------
  // What jobs need
  // -------------------------------------------------------------------------

  /** Each job type's requirements, archived qualifications included so a screen can show them. */
  async jobTypeRequirements(jobTypeIds: readonly string[]): Promise<Map<string, string[]>> {
    const byJobType = new Map<string, string[]>();
    if (jobTypeIds.length === 0) {
      return byJobType;
    }
    const rows = await this.db
      .selectFrom('job_type_qualifications')
      .select(['job_type_id', 'qualification_type_id'])
      .where('tenant_id', '=', this.tenantId)
      .where('job_type_id', 'in', [...new Set(jobTypeIds)])
      .orderBy('created_at')
      .execute();
    for (const row of rows) {
      byJobType.set(row.job_type_id, [
        ...(byJobType.get(row.job_type_id) ?? []),
        row.qualification_type_id,
      ]);
    }
    return byJobType;
  }

  /** Makes exactly these the job type's requirements. Jobs already created keep their own. */
  async setJobTypeRequirements(
    jobTypeId: string,
    typeIds: readonly string[],
    actor: UserId | string,
  ): Promise<void> {
    const wanted = [...new Set(typeIds)];
    await this.db
      .deleteFrom('job_type_qualifications')
      .where('tenant_id', '=', this.tenantId)
      .where('job_type_id', '=', jobTypeId)
      .$if(wanted.length > 0, (query) => query.where('qualification_type_id', 'not in', wanted))
      .execute();
    if (wanted.length === 0) {
      return;
    }
    await this.db
      .insertInto('job_type_qualifications')
      .values(
        wanted.map((typeId) => ({
          tenant_id: this.tenantId,
          job_type_id: jobTypeId,
          qualification_type_id: typeId,
          created_by: toUserId(actor),
        })),
      )
      .onConflict((conflict) => conflict.doNothing())
      .execute();
  }

  /**
   * Each job's requirements that still count: archived qualifications are
   * nobody's requirement any more.
   */
  async workOrderRequirements(
    workOrderIds: readonly string[],
  ): Promise<Map<string, QualificationRequirement[]>> {
    const byJob = new Map<string, QualificationRequirement[]>();
    if (workOrderIds.length === 0) {
      return byJob;
    }
    const rows = await this.db
      .selectFrom('work_order_qualifications as w')
      .innerJoin('qualification_types as t', (join) =>
        join.onRef('t.id', '=', 'w.qualification_type_id').onRef('t.tenant_id', '=', 'w.tenant_id'),
      )
      .select(['w.work_order_id', 'w.qualification_type_id', 't.name'])
      .where('w.tenant_id', '=', this.tenantId)
      .where('w.work_order_id', 'in', [...new Set(workOrderIds)])
      .where('t.archived_at', 'is', null)
      .orderBy(sql`lower(t.name)`)
      .execute();
    for (const row of rows) {
      byJob.set(row.work_order_id, [
        ...(byJob.get(row.work_order_id) ?? []),
        { qualificationTypeId: row.qualification_type_id, name: row.name },
      ]);
    }
    return byJob;
  }

  /** Makes exactly these the job's requirements. */
  async setWorkOrderRequirements(
    workOrderId: string,
    typeIds: readonly string[],
    actor: UserId | string,
  ): Promise<void> {
    const wanted = [...new Set(typeIds)];
    await this.db
      .deleteFrom('work_order_qualifications')
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', '=', workOrderId)
      .$if(wanted.length > 0, (query) => query.where('qualification_type_id', 'not in', wanted))
      .execute();
    if (wanted.length === 0) {
      return;
    }
    await this.db
      .insertInto('work_order_qualifications')
      .values(
        wanted.map((typeId) => ({
          tenant_id: this.tenantId,
          work_order_id: workOrderId,
          qualification_type_id: typeId,
          added_by: toUserId(actor),
        })),
      )
      .onConflict((conflict) => conflict.doNothing())
      .execute();
  }

  // -------------------------------------------------------------------------
  // Going ahead anyway
  // -------------------------------------------------------------------------

  /** Records why a visit went ahead without a qualification. Writes the job's history. */
  async recordOverride(
    input: QualificationOverrideInput,
    actor: UserId | string,
  ): Promise<QualificationOverride> {
    const row = await this.db
      .insertInto('work_order_qualification_overrides')
      .values({
        tenant_id: this.tenantId,
        work_order_id: input.workOrderId,
        visit_id: input.visitId,
        reason: input.reason.trim(),
        // As JSON text: pg would send a bare array as a Postgres array literal.
        missing: sql<
          { qualificationTypeId: string; name: string }[]
        >`${JSON.stringify(input.missing.map((gap) => ({ qualificationTypeId: gap.qualificationTypeId, name: gap.name })))}::jsonb`,
        assignee_ids: [...input.assigneeIds],
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        created_by: toUserId(actor),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toOverride(row);
  }

  async listOverrides(workOrderId: string): Promise<QualificationOverride[]> {
    const rows = await this.db
      .selectFrom('work_order_qualification_overrides')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', '=', workOrderId)
      .orderBy('created_at')
      .execute();
    return rows.map(toOverride);
  }

  // -------------------------------------------------------------------------
  // Expiry alerts
  // -------------------------------------------------------------------------

  /**
   * Certificates somebody should hear about today: those expiring within the
   * warning period not yet warned about, and those lapsed not yet announced.
   * A certificate already renewed — another record of the same qualification
   * lasting longer — is returned as `renewed`, so the caller can mark it and
   * move on without telling anyone.
   */
  async dueExpiryAlerts(
    today: string,
    warnUntil: string,
  ): Promise<{ alerts: ExpiryAlert[]; renewed: { id: string; stage: 'warning' | 'lapsed' }[] }> {
    const rows = await this.#records()
      .innerJoin('qualification_types as t', (join) =>
        join
          .onRef('t.id', '=', 'member_qualifications.qualification_type_id')
          .onRef('t.tenant_id', '=', 'member_qualifications.tenant_id'),
      )
      .innerJoin('tenant_users as u', (join) =>
        join
          .onRef('u.user_id', '=', 'member_qualifications.user_id')
          .onRef('u.tenant_id', '=', 'member_qualifications.tenant_id'),
      )
      .select([
        't.name as type_name',
        'u.status as member_status',
        'u.deleted_at as member_deleted_at',
      ])
      .select(['member_qualifications.expiry_warned_at', 'member_qualifications.lapse_alerted_at'])
      .where('member_qualifications.removed_at', 'is', null)
      .where('t.archived_at', 'is', null)
      .where('member_qualifications.expires_on', 'is not', null)
      .where((eb) =>
        eb.or([
          eb.and([
            eb('member_qualifications.expires_on', '<', sql<string>`${today}::date`),
            eb('member_qualifications.lapse_alerted_at', 'is', null),
          ]),
          eb.and([
            eb('member_qualifications.expires_on', '>=', sql<string>`${today}::date`),
            eb('member_qualifications.expires_on', '<=', sql<string>`${warnUntil}::date`),
            eb('member_qualifications.expiry_warned_at', 'is', null),
          ]),
        ]),
      )
      .orderBy('member_qualifications.expires_on')
      .limit(2000)
      .execute();
    if (rows.length === 0) {
      return { alerts: [], renewed: [] };
    }
    const others = await this.listRecords({
      userIds: rows.map((row) => row.user_id),
      typeIds: rows.map((row) => row.qualification_type_id),
    });
    const alerts: ExpiryAlert[] = [];
    const renewed: { id: string; stage: 'warning' | 'lapsed' }[] = [];
    for (const row of rows) {
      const record = toRecord(row);
      const stage = (record.expiresOn ?? '') < today ? 'lapsed' : 'warning';
      const isRenewed = others.some(
        (other) =>
          other.id !== record.id &&
          other.userId === record.userId &&
          other.qualificationTypeId === record.qualificationTypeId &&
          (other.expiresOn === null || other.expiresOn > (record.expiresOn ?? '')),
      );
      const memberGone = row.member_status !== 'active' || row.member_deleted_at !== null;
      if (isRenewed || memberGone) {
        renewed.push({ id: record.id, stage });
      } else {
        alerts.push({ record, typeName: row.type_name, stage });
      }
    }
    return { alerts, renewed };
  }

  /** Notes that an alert went out, so it goes once. */
  async markAlerted(recordIds: readonly string[], stage: 'warning' | 'lapsed'): Promise<void> {
    if (recordIds.length === 0) {
      return;
    }
    // Lapsed implies warned: a certificate that lapsed unnoticed is not warned about after.
    await this.db
      .updateTable('member_qualifications')
      .set(
        stage === 'lapsed'
          ? {
              lapse_alerted_at: sql<Date>`now()`,
              expiry_warned_at: sql<Date>`coalesce(expiry_warned_at, now())`,
            }
          : { expiry_warned_at: sql<Date>`now()` },
      )
      .where('tenant_id', '=', this.tenantId)
      .where('id', 'in', [...new Set(recordIds)])
      .where('removed_at', 'is', null)
      .execute();
  }

  // -------------------------------------------------------------------------

  async #typeWrite(
    write: () => Promise<string | undefined>,
    typeId?: string,
  ): Promise<QualificationTypeWrite> {
    await sql`savepoint qualification_type_write`.execute(this.db);
    let id: string | undefined;
    try {
      id = await write();
      await sql`release savepoint qualification_type_write`.execute(this.db);
    } catch (error) {
      await sql`rollback to savepoint qualification_type_write`.execute(this.db);
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        return { outcome: 'name_taken' };
      }
      throw error;
    }
    if (id === undefined) {
      const current = typeId === undefined ? undefined : await this.findType(typeId);
      return current === undefined ? { outcome: 'not_found' } : { outcome: 'conflict', current };
    }
    const type = await this.findType(id);
    return type === undefined ? { outcome: 'not_found' } : { outcome: 'written', type };
  }

  async #recordWrite(
    write: () => Promise<string | undefined>,
    recordId?: string,
  ): Promise<MemberQualificationWrite> {
    await sql`savepoint member_qualification_write`.execute(this.db);
    let id: string | undefined;
    try {
      id = await write();
      await sql`release savepoint member_qualification_write`.execute(this.db);
    } catch (error) {
      await sql`rollback to savepoint member_qualification_write`.execute(this.db);
      const code = (error as { code?: string; constraint?: string }).code;
      const constraint = (error as { constraint?: string }).constraint;
      if (code === FOREIGN_KEY_VIOLATION) {
        return constraint === 'member_qualifications_type_fk'
          ? { outcome: 'type_unknown' }
          : { outcome: 'member_unknown' };
      }
      if (code === CHECK_VIOLATION) {
        return constraint === 'member_qualifications_dates_ordered'
          ? { outcome: 'dates_reversed' }
          : { outcome: 'skill_expires' };
      }
      if (code === NOT_IN_PREREQUISITE_STATE) {
        // An archived type, or a record removed in between.
        const current = recordId === undefined ? undefined : await this.findRecord(recordId);
        return current?.removedAt != null
          ? { outcome: 'removed', current }
          : { outcome: 'type_archived' };
      }
      throw error;
    }
    if (id === undefined) {
      const current = recordId === undefined ? undefined : await this.findRecord(recordId);
      if (current === undefined) {
        return { outcome: 'not_found' };
      }
      return current.removedAt === null
        ? { outcome: 'conflict', current }
        : { outcome: 'removed', current };
    }
    const record = await this.findRecord(id);
    return record === undefined ? { outcome: 'not_found' } : { outcome: 'written', record };
  }
}

function datesProblem(
  kind: QualificationKind,
  issuedOn: string | null,
  expiresOn: string | null,
): 'skill_expires' | 'dates_reversed' | undefined {
  if (kind === 'skill' && expiresOn !== null) {
    return 'skill_expires';
  }
  if (issuedOn !== null && expiresOn !== null && expiresOn < issuedOn) {
    return 'dates_reversed';
  }
  return undefined;
}

function toType(row: {
  id: string;
  name: string;
  kind: QualificationKind;
  description: string | null;
  version: number;
  archived_at: Date | null;
  created_at: Date;
}): QualificationType {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    description: row.description,
    version: row.version,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  };
}

function toRecord(row: {
  id: string;
  user_id: string;
  qualification_type_id: string;
  reference: string | null;
  issued_on: string | null;
  expires_on: string | null;
  notes: string | null;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  removed_at: Date | null;
  removed_by: string | null;
}): MemberQualification {
  return {
    id: row.id,
    userId: toUserId(row.user_id),
    qualificationTypeId: row.qualification_type_id,
    reference: row.reference,
    issuedOn: row.issued_on,
    expiresOn: row.expires_on,
    notes: row.notes,
    version: row.version,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
    removedBy: row.removed_by === null ? null : toUserId(row.removed_by),
  };
}

function toOverride(row: {
  id: string;
  work_order_id: string;
  visit_id: string;
  reason: string;
  missing: { qualificationTypeId: string; name: string }[];
  assignee_ids: string[];
  starts_at: Date;
  ends_at: Date;
  created_by: string;
  created_at: Date;
}): QualificationOverride {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    visitId: row.visit_id,
    reason: row.reason,
    missing: row.missing,
    assigneeIds: row.assignee_ids.map(toUserId),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
  };
}
