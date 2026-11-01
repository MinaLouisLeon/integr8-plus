import { type TenantId, toTenantId, toUserId, type UserId } from '@integr8/core';
import { type Kysely, type Selectable, sql } from 'kysely';
import type {
  Database,
  DocumentFieldValuesTable,
  DocumentLookupRole,
  DocumentSource,
  DocumentStatus,
  DocumentsTable,
  DocumentTemplatesTable,
  WebsiteKeysTable,
} from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * PDF documents made from submissions (docs/documents/ADR-0001).
 *
 * Templates belong to a form and are archived, never deleted. A document is
 * created pending, with its public code and the fields it was made with, then
 * marked ready with its file by the render job, or failed with a reason. Its
 * link opens while it is ready, not expired by a person and not past its own
 * expiry date.
 */

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface DocumentTemplate {
  id: string;
  formId: string;
  name: string;
  design: unknown;
  designSchemaVersion: number;
  revision: number;
  archivedAt: Date | null;
  createdBy: UserId;
  updatedBy: UserId;
  createdAt: Date;
  updatedAt: Date;
}

export class DocumentTemplatesRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  #templates() {
    return this.db
      .selectFrom('document_templates')
      .where('document_templates.tenant_id', '=', this.tenantId);
  }

  async list(
    options: { formId?: string | undefined; includeArchived?: boolean | undefined } = {},
  ): Promise<DocumentTemplate[]> {
    let query = this.#templates().selectAll();
    if (options.formId !== undefined) {
      query = query.where('form_id', '=', options.formId);
    }
    if (options.includeArchived !== true) {
      query = query.where('archived_at', 'is', null);
    }
    return (await query.orderBy('name').orderBy('id').execute()).map(toTemplate);
  }

  async find(templateId: string): Promise<DocumentTemplate | undefined> {
    const row = await this.#templates().selectAll().where('id', '=', templateId).executeTakeFirst();
    return row === undefined ? undefined : toTemplate(row);
  }

  async create(input: {
    id: string;
    formId: string;
    name: string;
    design: unknown;
    by: UserId | string;
  }): Promise<DocumentTemplate> {
    const row = await this.db
      .insertInto('document_templates')
      .values({
        id: input.id,
        tenant_id: this.tenantId,
        form_id: input.formId,
        name: input.name,
        design: JSON.stringify(input.design),
        design_schema_version: schemaVersionOf(input.design),
        created_by: toUserId(input.by),
        updated_by: toUserId(input.by),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTemplate(row);
  }

  /**
   * Saves a change as the next revision. `undefined` when the template is
   * gone or another save got there first (the revision moved on).
   */
  async update(
    templateId: string,
    expectedRevision: number,
    change: { name?: string | undefined; design?: unknown },
    by: UserId | string,
  ): Promise<DocumentTemplate | undefined> {
    const row = await this.db
      .updateTable('document_templates')
      .set({
        ...(change.name === undefined ? {} : { name: change.name }),
        ...(change.design === undefined
          ? {}
          : {
              design: JSON.stringify(change.design),
              design_schema_version: schemaVersionOf(change.design),
            }),
        revision: sql<number>`revision + 1`,
        updated_by: toUserId(by),
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', templateId)
      .where('revision', '=', expectedRevision)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toTemplate(row);
  }

  async setArchived(
    templateId: string,
    archived: boolean,
    by: UserId | string,
  ): Promise<DocumentTemplate | undefined> {
    const row = await this.db
      .updateTable('document_templates')
      .set({ archived_at: archived ? sql<Date>`now()` : null, updated_by: toUserId(by) })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', templateId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toTemplate(row);
  }
}

/** The design's own `schemaVersion`, kept beside it so a query can find old designs (1.3.0). */
function schemaVersionOf(design: unknown): number {
  const version = (design as { schemaVersion?: unknown } | null)?.schemaVersion;
  return typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : 1;
}

function toTemplate(row: Selectable<DocumentTemplatesTable>): DocumentTemplate {
  return {
    id: row.id,
    formId: row.form_id,
    name: row.name,
    design: row.design,
    designSchemaVersion: row.design_schema_version,
    revision: row.revision,
    archivedAt: row.archived_at,
    createdBy: toUserId(row.created_by),
    updatedBy: toUserId(row.updated_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface DocumentFieldValue {
  key: string;
  label: Record<string, string>;
  value: string;
  lookupRole: DocumentLookupRole | null;
}

export interface DocumentRecord {
  id: string;
  /** Generated from a submission, or uploaded by a person (0067). */
  source: DocumentSource;
  /** Null for an uploaded document; set for every generated one. */
  templateId: string | null;
  templateRevision: number | null;
  submissionId: string | null;
  formId: string | null;
  /** An uploaded document's reference number. */
  reference: string | null;
  /** The customer an uploaded document is for. */
  customerId: string | null;
  /** Whether the QR code's link and the company website may show it (0067). */
  shareable: boolean;
  title: string;
  publicCode: string;
  status: DocumentStatus;
  failureCode: string | null;
  fileId: string | null;
  byteSize: number | null;
  pageCount: number | null;
  sha256: string | null;
  renderedAt: Date | null;
  expiredAt: Date | null;
  expiredBy: UserId | null;
  expiresAt: Date | null;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
  fields: DocumentFieldValue[];
}

/**
 * Whether the document's link is live now: ready, not expired by anyone or by
 * date. Whether it may be shown outside the company at all is `shareable`,
 * checked beside this wherever the outside asks (0067).
 */
export function linkOpens(document: DocumentRecord, now: Date = new Date()): boolean {
  return (
    document.status === 'ready' &&
    document.expiredAt === null &&
    (document.expiresAt === null || document.expiresAt.getTime() > now.getTime())
  );
}

/** What search and the website lookup compare: trimmed, spaces collapsed, lower-cased. */
export function normalizeFieldValue(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');
}

export interface DocumentListQuery {
  /** Matched against every field value, and the title. */
  q?: string | undefined;
  /** Restricts `q` to one field. */
  fieldKey?: string | undefined;
  formId?: string | undefined;
  templateId?: string | undefined;
  submissionId?: string | undefined;
  /** Generated from submissions, or uploaded (0067). */
  source?: DocumentSource | undefined;
  /** `active`: the link opens; `expired`: it does not, by a person or by date. */
  state?: 'active' | 'expired' | 'pending' | 'failed' | undefined;
  createdFrom?: Date | undefined;
  createdBefore?: Date | undefined;
  limit: number;
  /** The last row of the previous page. */
  after?: { createdAt: Date; id: string } | undefined;
}

export class DocumentsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  #documents() {
    return this.db.selectFrom('documents').where('documents.tenant_id', '=', this.tenantId);
  }

  async create(input: {
    id: string;
    templateId: string;
    templateRevision: number;
    submissionId: string;
    formId: string;
    title: string;
    publicCode: string;
    expiresAt: Date | null;
    by: UserId | string;
    fields: readonly DocumentFieldValue[];
  }): Promise<DocumentRecord> {
    const row = await this.db
      .insertInto('documents')
      .values({
        id: input.id,
        tenant_id: this.tenantId,
        template_id: input.templateId,
        template_revision: input.templateRevision,
        submission_id: input.submissionId,
        form_id: input.formId,
        title: input.title,
        public_code: input.publicCode,
        expires_at: input.expiresAt,
        created_by: toUserId(input.by),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.#insertFields(input.id, input.fields);
    return toDocument(row, [...input.fields]);
  }

  /**
   * Records a PDF a person uploaded (0067): ready at once, since the file is
   * already stored, with its reference (and customer) as the fields the
   * website lookup finds it by.
   */
  async createUploaded(input: {
    id: string;
    title: string;
    reference: string;
    customerId: string | null;
    publicCode: string;
    expiresAt: Date | null;
    shareable: boolean;
    by: UserId | string;
    file: { fileId: string; byteSize: number; sha256: string; pageCount: number | null };
    fields: readonly DocumentFieldValue[];
  }): Promise<DocumentRecord> {
    const row = await this.db
      .insertInto('documents')
      .values({
        id: input.id,
        tenant_id: this.tenantId,
        source: 'uploaded',
        template_id: null,
        template_revision: null,
        submission_id: null,
        form_id: null,
        reference: input.reference,
        customer_id: input.customerId,
        shareable: input.shareable,
        title: input.title,
        public_code: input.publicCode,
        status: 'ready',
        file_id: input.file.fileId,
        byte_size: input.file.byteSize,
        page_count: input.file.pageCount,
        sha256: input.file.sha256,
        rendered_at: sql<Date>`now()`,
        expires_at: input.expiresAt,
        created_by: toUserId(input.by),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.#insertFields(input.id, input.fields);
    return toDocument(row, [...input.fields]);
  }

  async #insertFields(documentId: string, fields: readonly DocumentFieldValue[]): Promise<void> {
    if (fields.length === 0) {
      return;
    }
    await this.db
      .insertInto('document_field_values')
      .values(
        fields.map((field) => ({
          tenant_id: this.tenantId,
          document_id: documentId,
          field_key: field.key,
          label: JSON.stringify(field.label) as unknown as Record<string, string>,
          value: field.value,
          value_normalized: normalizeFieldValue(field.value),
          lookup_role: field.lookupRole,
        })),
      )
      .execute();
  }

  /** Whether the QR code's link and the company website may show it. */
  async setShareable(
    documentId: string,
    shareable: boolean,
  ): Promise<{ document: DocumentRecord; changed: boolean } | undefined> {
    const current = await this.find(documentId);
    if (current === undefined) {
      return undefined;
    }
    if (current.shareable === shareable) {
      return { document: current, changed: false };
    }
    const row = await this.db
      .updateTable('documents')
      .set({ shareable })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', documentId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : { document: toDocument(row, current.fields), changed: true };
  }

  async find(documentId: string): Promise<DocumentRecord | undefined> {
    const row = await this.#documents().selectAll().where('id', '=', documentId).executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    const fields = await this.#fieldsFor([row.id]);
    return toDocument(row, fields.get(row.id) ?? []);
  }

  /** The document with this public code, in this company. */
  async findByCode(publicCode: string): Promise<DocumentRecord | undefined> {
    const row = await this.#documents()
      .selectAll()
      .where('public_code', '=', publicCode)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    const fields = await this.#fieldsFor([row.id]);
    return toDocument(row, fields.get(row.id) ?? []);
  }

  async list(query: DocumentListQuery): Promise<DocumentRecord[]> {
    let select = this.#documents().selectAll('documents');
    if (query.formId !== undefined) {
      select = select.where('documents.form_id', '=', query.formId);
    }
    if (query.templateId !== undefined) {
      select = select.where('documents.template_id', '=', query.templateId);
    }
    if (query.submissionId !== undefined) {
      select = select.where('documents.submission_id', '=', query.submissionId);
    }
    if (query.source !== undefined) {
      select = select.where('documents.source', '=', query.source);
    }
    if (query.createdFrom !== undefined) {
      select = select.where('documents.created_at', '>=', query.createdFrom);
    }
    if (query.createdBefore !== undefined) {
      select = select.where('documents.created_at', '<', query.createdBefore);
    }
    switch (query.state) {
      case 'pending':
      case 'failed':
        select = select.where('documents.status', '=', query.state);
        break;
      case 'active':
        select = select
          .where('documents.status', '=', 'ready')
          .where('documents.expired_at', 'is', null)
          .where((eb) =>
            eb.or([
              eb('documents.expires_at', 'is', null),
              eb('documents.expires_at', '>', sql<Date>`now()`),
            ]),
          );
        break;
      case 'expired':
        select = select
          .where('documents.status', '=', 'ready')
          .where((eb) =>
            eb.or([
              eb('documents.expired_at', 'is not', null),
              eb('documents.expires_at', '<=', sql<Date>`now()`),
            ]),
          );
        break;
      default:
        break;
    }
    const q = query.q === undefined ? '' : normalizeFieldValue(query.q);
    if (q !== '') {
      const pattern = `%${escapeLike(q)}%`;
      select = select.where((eb) => {
        const inFields = eb.exists(
          eb
            .selectFrom('document_field_values as v')
            .select(sql`1`.as('one'))
            .whereRef('v.tenant_id', '=', 'documents.tenant_id')
            .whereRef('v.document_id', '=', 'documents.id')
            .where('v.value_normalized', 'like', pattern)
            .$if(query.fieldKey !== undefined, (inner) =>
              inner.where('v.field_key', '=', query.fieldKey ?? ''),
            ),
        );
        return query.fieldKey === undefined
          ? eb.or([inFields, eb(sql`lower(documents.title)`, 'like', pattern)])
          : inFields;
      });
    }
    if (query.after !== undefined) {
      const { createdAt, id } = query.after;
      select = select.where((eb) =>
        eb.or([
          eb('documents.created_at', '<', createdAt),
          eb.and([eb('documents.created_at', '=', createdAt), eb('documents.id', '<', id)]),
        ]),
      );
    }
    const rows = await select
      .orderBy('documents.created_at', 'desc')
      .orderBy('documents.id', 'desc')
      .limit(query.limit)
      .execute();
    const fields = await this.#fieldsFor(rows.map((row) => row.id));
    return rows.map((row) => toDocument(row, fields.get(row.id) ?? []));
  }

  async markReady(
    documentId: string,
    file: { fileId: string; byteSize: number; pageCount: number; sha256: string },
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('documents')
      .set({
        status: 'ready',
        failure_code: null,
        file_id: file.fileId,
        byte_size: file.byteSize,
        page_count: file.pageCount,
        sha256: file.sha256,
        rendered_at: sql<Date>`now()`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', documentId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async markFailed(documentId: string, failureCode: string): Promise<boolean> {
    const result = await this.db
      .updateTable('documents')
      .set({ status: 'failed', failure_code: failureCode })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', documentId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /** Stops the link now (`expired: true`), or lets it open again. */
  async setExpired(
    documentId: string,
    expired: boolean,
    by: UserId | string,
  ): Promise<DocumentRecord | undefined> {
    const row = await this.db
      .updateTable('documents')
      .set(
        expired
          ? {
              expired_at: sql<Date>`coalesce(expired_at, now())`,
              expired_by: sql<string>`coalesce(expired_by, ${toUserId(by)}::uuid)`,
            }
          : { expired_at: null, expired_by: null },
      )
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', documentId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : this.find(row.id);
  }

  /** When the link stops by itself; `null` for never. */
  async setExpiresAt(
    documentId: string,
    expiresAt: Date | null,
  ): Promise<DocumentRecord | undefined> {
    const row = await this.db
      .updateTable('documents')
      .set({ expires_at: expiresAt })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', documentId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : this.find(row.id);
  }

  /** Removes the record and its fields; returns the file to delete, if it had one. */
  async delete(documentId: string): Promise<{ fileId: string | null } | undefined> {
    const row = await this.db
      .deleteFrom('documents')
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', documentId)
      .returning(['file_id'])
      .executeTakeFirst();
    return row === undefined ? undefined : { fileId: row.file_id };
  }

  /**
   * The website lookup (D10): the newest shareable document whose lookup key
   * matches, whose second field matches too when it has one, and whose link
   * opens. Exact after normalising; never a list. Without a field name (a
   * lookup by reference, 0067) the value is matched against whichever field
   * is the document's key, and the second value against whichever is its
   * confirming field.
   */
  async lookup(input: {
    key: { field?: string | undefined; value: string };
    confirm?: { field?: string | undefined; value: string } | undefined;
  }): Promise<DocumentRecord | undefined> {
    const keyValue = normalizeFieldValue(input.key.value);
    if (keyValue === '') {
      return undefined;
    }
    const candidates = await this.#documents()
      .innerJoin('document_field_values as k', (join) =>
        join
          .onRef('k.tenant_id', '=', 'documents.tenant_id')
          .onRef('k.document_id', '=', 'documents.id'),
      )
      .selectAll('documents')
      .$if(input.key.field !== undefined, (query) =>
        query.where('k.field_key', '=', input.key.field ?? ''),
      )
      .where('k.lookup_role', '=', 'key')
      .where('documents.shareable', '=', true)
      .where('k.value_normalized', '=', keyValue)
      .where('documents.status', '=', 'ready')
      .where('documents.expired_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('documents.expires_at', 'is', null),
          eb('documents.expires_at', '>', sql<Date>`now()`),
        ]),
      )
      .orderBy('documents.created_at', 'desc')
      .orderBy('documents.id', 'desc')
      .limit(20)
      .execute();
    if (candidates.length === 0) {
      return undefined;
    }
    const fields = await this.#fieldsFor(candidates.map((row) => row.id));
    const seen = new Set<string>();
    for (const row of candidates) {
      // Matched by any key field, a document can come up once per field.
      if (seen.has(row.id)) {
        continue;
      }
      seen.add(row.id);
      const own = fields.get(row.id) ?? [];
      const confirmField = own.find((field) => field.lookupRole === 'confirm');
      if (confirmField !== undefined) {
        // The template asks for a second field: it must be given, and match.
        if (
          input.confirm === undefined ||
          (input.confirm.field !== undefined && input.confirm.field !== confirmField.key) ||
          normalizeFieldValue(input.confirm.value) !== normalizeFieldValue(confirmField.value)
        ) {
          continue;
        }
      }
      return toDocument(row, own);
    }
    return undefined;
  }

  async #fieldsFor(documentIds: readonly string[]): Promise<Map<string, DocumentFieldValue[]>> {
    const byDocument = new Map<string, DocumentFieldValue[]>();
    if (documentIds.length === 0) {
      return byDocument;
    }
    const rows = await this.db
      .selectFrom('document_field_values')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('document_id', 'in', [...new Set(documentIds)])
      .orderBy('field_key')
      .execute();
    for (const row of rows) {
      const list = byDocument.get(row.document_id) ?? [];
      list.push(toFieldValue(row));
      byDocument.set(row.document_id, list);
    }
    return byDocument;
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}

function toFieldValue(row: Selectable<DocumentFieldValuesTable>): DocumentFieldValue {
  return { key: row.field_key, label: row.label, value: row.value, lookupRole: row.lookup_role };
}

function toDocument(row: Selectable<DocumentsTable>, fields: DocumentFieldValue[]): DocumentRecord {
  return {
    id: row.id,
    source: row.source,
    templateId: row.template_id,
    templateRevision: row.template_revision,
    submissionId: row.submission_id,
    formId: row.form_id,
    reference: row.reference,
    customerId: row.customer_id,
    shareable: row.shareable,
    title: row.title,
    publicCode: row.public_code,
    status: row.status,
    failureCode: row.failure_code,
    fileId: row.file_id,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    pageCount: row.page_count,
    sha256: row.sha256,
    renderedAt: row.rendered_at,
    expiredAt: row.expired_at,
    expiredBy: row.expired_by === null ? null : toUserId(row.expired_by),
    expiresAt: row.expires_at,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fields,
  };
}

// ---------------------------------------------------------------------------
// Before any company is known
// ---------------------------------------------------------------------------

/**
 * Which company a public document code belongs to (D7). Platform connection:
 * whoever scans a QR code has no session and belongs to no company, so the
 * code is found across every company first and the document is then read on
 * that company's own connection. Only an active company's code matches.
 */
export class PublicDocumentsLookup {
  constructor(private readonly db: Kysely<Database>) {}

  async byCode(
    publicCode: string,
  ): Promise<{ tenantId: TenantId; documentId: string } | undefined> {
    const row = await this.db
      .selectFrom('documents')
      .innerJoin('tenants', 'tenants.id', 'documents.tenant_id')
      .select(['documents.tenant_id', 'documents.id'])
      .where('documents.public_code', '=', publicCode)
      .where('tenants.deleted_at', 'is', null)
      .where('tenants.status', '=', 'active')
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : { tenantId: toTenantId(row.tenant_id), documentId: row.id };
  }
}

// ---------------------------------------------------------------------------
// Website keys (platform-level)
// ---------------------------------------------------------------------------

export interface WebsiteKey {
  id: string;
  tenantId: TenantId;
  keyHint: string;
  label: string | null;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  lastUsedAt: Date | null;
  lookups: number;
  found: number;
}

/** At most this many live keys per company: one in use, one rolling in (D11). */
export const MAX_LIVE_WEBSITE_KEYS = 2;

export class WebsiteKeysRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async listForTenant(tenantId: string): Promise<WebsiteKey[]> {
    const rows = await this.db
      .selectFrom('website_keys')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map(toWebsiteKey);
  }

  async liveCount(tenantId: string): Promise<number> {
    const row = await this.db
      .selectFrom('website_keys')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('tenant_id', '=', tenantId)
      .where('revoked_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async create(input: {
    id: string;
    tenantId: string;
    keyHash: string;
    keyHint: string;
    label: string | null;
    createdBy: string;
  }): Promise<WebsiteKey> {
    const row = await this.db
      .insertInto('website_keys')
      .values({
        id: input.id,
        tenant_id: input.tenantId,
        key_hash: input.keyHash,
        key_hint: input.keyHint,
        label: input.label,
        enabled: true,
        created_by: input.createdBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toWebsiteKey(row);
  }

  async setEnabled(
    tenantId: string,
    keyId: string,
    enabled: boolean,
  ): Promise<WebsiteKey | undefined> {
    const row = await this.db
      .updateTable('website_keys')
      .set({ enabled })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', keyId)
      .where('revoked_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toWebsiteKey(row);
  }

  async delete(tenantId: string, keyId: string): Promise<WebsiteKey | undefined> {
    const row = await this.db
      .deleteFrom('website_keys')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', keyId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toWebsiteKey(row);
  }

  async revoke(tenantId: string, keyId: string, by: string): Promise<WebsiteKey | undefined> {
    const row = await this.db
      .updateTable('website_keys')
      .set({ revoked_at: sql<Date>`now()`, revoked_by: by })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', keyId)
      .where('revoked_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toWebsiteKey(row);
  }

  /** The live key with this hash, and its company, if the company is active. */
  async findLiveByHash(keyHash: string): Promise<{ id: string; tenantId: TenantId } | undefined> {
    const row = await this.db
      .selectFrom('website_keys')
      .innerJoin('tenants', 'tenants.id', 'website_keys.tenant_id')
      .select(['website_keys.id', 'website_keys.tenant_id'])
      .where('website_keys.key_hash', '=', keyHash)
      .where('website_keys.revoked_at', 'is', null)
      .where('website_keys.enabled', '=', true)
      .where('tenants.deleted_at', 'is', null)
      .where('tenants.status', '=', 'active')
      .executeTakeFirst();
    return row === undefined ? undefined : { id: row.id, tenantId: toTenantId(row.tenant_id) };
  }

  /** Counts one lookup, and whether it found a document. */
  async recordUse(keyId: string, found: boolean): Promise<void> {
    await this.db
      .updateTable('website_keys')
      .set({
        last_used_at: sql<Date>`now()`,
        lookups: sql<string>`lookups + 1`,
        found: found ? sql<string>`found + 1` : sql<string>`found`,
      })
      .where('id', '=', keyId)
      .execute();
  }
}

function toWebsiteKey(row: Selectable<WebsiteKeysTable>): WebsiteKey {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    keyHint: row.key_hint,
    label: row.label,
    enabled: row.enabled,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    lastUsedAt: row.last_used_at,
    lookups: Number(row.lookups),
    found: Number(row.found),
  };
}
