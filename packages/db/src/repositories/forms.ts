import { type TenantId, type UserId, toTenantId, toUserId } from '@integr8/core';
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
}

export interface CreateFormInput {
  title: string;
  createdBy: UserId | string;
}

export interface CreateDraftInput {
  formId: string;
  definition: Record<string, unknown>;
  createdBy: UserId | string;
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

  async createForm(input: CreateFormInput): Promise<Form> {
    const row = await this.db
      .insertInto('forms')
      .values({
        tenant_id: this.tenantId,
        title: input.title.trim(),
        created_by: toUserId(input.createdBy),
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
    return (await this.#forms().selectAll().orderBy('created_at', 'desc').execute()).map(toForm);
  }

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
      .set({ definition, definition_schema_version: schemaVersionOf(definition) })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', versionId)
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toVersion(row);
  }

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
  ): Promise<FormVersion | undefined> {
    const row = await this.db
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
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', versionId)
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst();
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

function toForm(row: Selectable<FormsTable>): Form {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    title: row.title,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function toVersion(row: Selectable<FormVersionsTable>): FormVersion {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    formId: row.form_id,
    status: formVersionStatusSchema.parse(row.status),
    versionNumber: row.version_number,
    definition: row.definition,
    definitionSchemaVersion: row.definition_schema_version,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    publishedBy: row.published_by === null ? null : toUserId(row.published_by),
  };
}
