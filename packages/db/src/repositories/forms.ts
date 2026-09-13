import {
  type Role,
  roleSchema,
  type TenantId,
  type UserId,
  toTenantId,
  toUserId,
} from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import {
  type FormsTable,
  type FormVersionsTable,
  type FormVersionStatus,
  formVersionStatusSchema,
} from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export interface Form {
  id: string;
  tenantId: TenantId;
  title: string;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  /** Roles that may fill this form. Never empty. */
  fillRoles: Role[];
  /** Whether a signature is mandatory before a job using this form can close. */
  signatureRequired: boolean;
  clonedFromFormId: string | null;
  sourceTemplateKey: string | null;
}

export interface FormVersion {
  id: string;
  tenantId: TenantId;
  formId: string;
  status: FormVersionStatus;
  /** Null while a draft. */
  versionNumber: number | null;
  definition: Record<string, unknown>;
  definitionSchemaVersion: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
  publishedBy: UserId | null;
  /** Incremented by every save of a draft. */
  revision: number;
  changeNote: string | null;
  changes: Record<string, unknown> | null;
}

/** A version without its definition, for lists where the definition is dead weight. */
export type FormVersionSummary = Omit<FormVersion, 'definition'>;

export interface CreateFormInput {
  title: string;
  createdBy: UserId | string;
  fillRoles?: readonly Role[];
  signatureRequired?: boolean;
  clonedFromFormId?: string;
  sourceTemplateKey?: string;
}

export interface UpdateFormInput {
  title?: string;
  fillRoles?: readonly Role[];
  signatureRequired?: boolean;
}

export interface CreateDraftInput {
  formId: string;
  definition: Record<string, unknown>;
  createdBy: UserId | string;
}

export type SaveDraftResult =
  | { outcome: 'saved'; version: FormVersion }
  /** Somebody saved first. `current` is what they saved. */
  | { outcome: 'conflict'; current: FormVersion | undefined };

export interface PublishOptions {
  changeNote?: string | null;
  changes?: Record<string, unknown> | null;
  /**
   * The revision the publisher reviewed. When given, a draft saved since — by
   * another tab, or another admin — is not published, so nobody publishes
   * changes they never saw.
   */
  expectedRevision?: number;
}

/**
 * Forms and their versions, for one company.
 *
 * This repository stores definitions; it does not judge them. Whether a
 * definition is valid is `prepareForPublish` in @integr8/form-engine, which the
 * publishing service calls before `publishDraft`. What *is* guaranteed here — by
 * migration 0006, not by this class — is that a published version never changes
 * again, whoever asks and however they ask.
 */
export class FormsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /** The one place a `forms` read is scoped. */
  #forms() {
    return this.db.selectFrom('forms').where('forms.tenant_id', '=', this.tenantId);
  }

  /** The one place a `form_versions` read is scoped. */
  #versions() {
    return this.db.selectFrom('form_versions').where('form_versions.tenant_id', '=', this.tenantId);
  }

  // -------------------------------------------------------------------------
  // Forms
  // -------------------------------------------------------------------------

  async createForm(input: CreateFormInput): Promise<Form> {
    const row = await this.db
      .insertInto('forms')
      .values({
        tenant_id: this.tenantId,
        title: input.title.trim(),
        created_by: toUserId(input.createdBy),
        ...(input.fillRoles === undefined ? {} : { fill_roles: roles(input.fillRoles) }),
        ...(input.signatureRequired === undefined
          ? {}
          : { signature_required: input.signatureRequired }),
        cloned_from_form_id: input.clonedFromFormId ?? null,
        source_template_key: input.sourceTemplateKey ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toForm(row);
  }

  async findForm(formId: string): Promise<Form | undefined> {
    const row = await this.#forms().selectAll().where('id', '=', formId).executeTakeFirst();
    return row === undefined ? undefined : toForm(row);
  }

  async listForms(): Promise<Form[]> {
    return (
      await this.#forms()
        .selectAll()
        .where('archived_at', 'is', null)
        .orderBy('created_at', 'desc')
        .execute()
    ).map(toForm);
  }

  /** Title and settings. Returns `undefined` for a form that is not there. */
  async updateForm(formId: string, input: UpdateFormInput): Promise<Form | undefined> {
    const changes = {
      ...(input.title === undefined ? {} : { title: input.title.trim() }),
      ...(input.fillRoles === undefined ? {} : { fill_roles: roles(input.fillRoles) }),
      ...(input.signatureRequired === undefined
        ? {}
        : { signature_required: input.signatureRequired }),
    };
    if (Object.keys(changes).length === 0) {
      return this.findForm(formId);
    }

    const row = await this.db
      .updateTable('forms')
      .set(changes)
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', formId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toForm(row);
  }

  // -------------------------------------------------------------------------
  // Drafts
  // -------------------------------------------------------------------------

  /**
   * Starts a new draft. Refused by a unique index if the form already has one:
   * two drafts of one form would publish over each other.
   */
  async createDraft(input: CreateDraftInput): Promise<FormVersion> {
    const row = await this.db
      .insertInto('form_versions')
      .values({
        tenant_id: this.tenantId,
        form_id: input.formId,
        definition: input.definition,
        definition_schema_version: schemaVersionOf(input.definition),
        created_by: toUserId(input.createdBy),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toVersion(row);
  }

  async findDraft(formId: string): Promise<FormVersion | undefined> {
    const row = await this.#versions()
      .selectAll()
      .where('form_id', '=', formId)
      .where('status', '=', 'draft')
      .executeTakeFirst();
    return row === undefined ? undefined : toVersion(row);
  }

  /**
   * Replaces a draft's definition. Returns `undefined` if the version is not a
   * draft — and the database would refuse the update of a published one anyway.
   */
  async updateDraft(
    versionId: string,
    definition: Record<string, unknown>,
  ): Promise<FormVersion | undefined> {
    const row = await this.db
      .updateTable('form_versions')
      .set({
        definition,
        definition_schema_version: schemaVersionOf(definition),
        revision: sql<number>`revision + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', versionId)
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toVersion(row);
  }

  /**
   * The builder's autosave: write the draft, but only over the revision the
   * builder last saw.
   *
   * `expectedRevision` is `null` when the builder believes there is no draft
   * yet. If another tab created one first, the unique draft index refuses the
   * insert and that is reported as a conflict too — never as a second draft and
   * never as an error the builder cannot explain.
   */
  async saveDraft(
    formId: string,
    definition: Record<string, unknown>,
    expectedRevision: number | null,
    savedBy: UserId | string,
  ): Promise<SaveDraftResult> {
    if (expectedRevision === null) {
      const existing = await this.findDraft(formId);
      if (existing !== undefined) {
        return { outcome: 'conflict', current: existing };
      }
      // A savepoint, so losing the race on the unique draft index rolls back
      // only this insert and leaves the caller's transaction usable. Kysely has
      // no nested transaction on an open one, so it is said in SQL.
      await sql`savepoint save_draft`.execute(this.db);
      try {
        const created = await this.db
          .insertInto('form_versions')
          .values({
            tenant_id: this.tenantId,
            form_id: formId,
            definition,
            definition_schema_version: schemaVersionOf(definition),
            created_by: toUserId(savedBy),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await sql`release savepoint save_draft`.execute(this.db);
        return { outcome: 'saved', version: toVersion(created) };
      } catch (error) {
        await sql`rollback to savepoint save_draft`.execute(this.db);
        if (isUniqueViolation(error)) {
          return { outcome: 'conflict', current: await this.findDraft(formId) };
        }
        throw error;
      }
    }

    const row = await this.db
      .updateTable('form_versions')
      .set({
        definition,
        definition_schema_version: schemaVersionOf(definition),
        revision: sql<number>`revision + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('form_id', '=', formId)
      .where('status', '=', 'draft')
      .where('revision', '=', expectedRevision)
      .returningAll()
      .executeTakeFirst();

    return row === undefined
      ? { outcome: 'conflict', current: await this.findDraft(formId) }
      : { outcome: 'saved', version: toVersion(row) };
  }

  // -------------------------------------------------------------------------
  // Publishing and history
  // -------------------------------------------------------------------------

  /**
   * Publishes a draft: assigns the next version number and freezes it.
   *
   * One statement, so the number is taken from the same snapshot the draft is
   * published in. Two publishes of the same draft race on `status = 'draft'`
   * and one updates nothing; a second draft of the same form cannot exist to
   * race with; and `unique (form_id, version_number)` is the backstop for both.
   *
   * This is the last update a version ever receives.
   */
  async publishDraft(
    versionId: string,
    publishedBy: UserId | string,
    options: PublishOptions = {},
  ): Promise<FormVersion | undefined> {
    let query = this.db
      .updateTable('form_versions')
      .set({
        status: 'published',
        version_number: sql<number>`(
          select coalesce(max(prior.version_number), 0) + 1
            from form_versions as prior
           where prior.tenant_id = ${this.tenantId}
             and prior.form_id = form_versions.form_id
        )`,
        published_at: sql<Date>`now()`,
        published_by: toUserId(publishedBy),
        change_note: options.changeNote ?? null,
        changes: options.changes ?? null,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', versionId)
      .where('status', '=', 'draft');

    if (options.expectedRevision !== undefined) {
      query = query.where('revision', '=', options.expectedRevision);
    }

    const row = await query.returningAll().executeTakeFirst();
    return row === undefined ? undefined : toVersion(row);
  }

  async findVersion(versionId: string): Promise<FormVersion | undefined> {
    const row = await this.#versions().selectAll().where('id', '=', versionId).executeTakeFirst();
    return row === undefined ? undefined : toVersion(row);
  }

  /** Published versions newest first, then the draft if there is one. */
  async listVersions(formId: string): Promise<FormVersion[]> {
    return (
      await this.#versions()
        .selectAll()
        .where('form_id', '=', formId)
        .orderBy(sql`version_number desc nulls last`)
        .execute()
    ).map(toVersion);
  }

  /** Every version of every form, without definitions. What a form list needs. */
  async listVersionSummaries(): Promise<FormVersionSummary[]> {
    const rows = await this.#versions()
      .select([
        'id',
        'tenant_id',
        'form_id',
        'status',
        'version_number',
        'definition_schema_version',
        'created_by',
        'created_at',
        'updated_at',
        'published_at',
        'published_by',
        'revision',
        'change_note',
        'changes',
      ])
      .orderBy(sql`version_number desc nulls last`)
      .execute();
    return rows.map((row) => summaryOf(row));
  }

  /** The version new submissions should be made against. */
  async findLatestPublished(formId: string): Promise<FormVersion | undefined> {
    const row = await this.#versions()
      .selectAll()
      .where('form_id', '=', formId)
      .where('status', '=', 'published')
      .orderBy('version_number', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? undefined : toVersion(row);
  }
}

function roles(values: readonly Role[]): Role[] {
  return [...new Set(values.map((value) => roleSchema.parse(value)))];
}

/**
 * The definition's own `schemaVersion`. A check constraint makes the column and
 * the document agree; reading it here means the caller cannot pass one that
 * disagrees and be surprised by the constraint.
 */
function schemaVersionOf(definition: Record<string, unknown>): number {
  const version = definition.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new TypeError('A form definition must carry an integer schemaVersion');
  }
  return version;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

function toForm(row: Selectable<FormsTable>): Form {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    title: row.title,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    fillRoles: row.fill_roles.map((role) => roleSchema.parse(role)),
    signatureRequired: row.signature_required,
    clonedFromFormId: row.cloned_from_form_id,
    sourceTemplateKey: row.source_template_key,
  };
}

function summaryOf(row: Omit<Selectable<FormVersionsTable>, 'definition'>): FormVersionSummary {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    formId: row.form_id,
    status: formVersionStatusSchema.parse(row.status),
    versionNumber: row.version_number,
    definitionSchemaVersion: row.definition_schema_version,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    publishedBy: row.published_by === null ? null : toUserId(row.published_by),
    revision: row.revision,
    changeNote: row.change_note,
    changes: row.changes,
  };
}

function toVersion(row: Selectable<FormVersionsTable>): FormVersion {
  return { ...summaryOf(row), definition: row.definition };
}
