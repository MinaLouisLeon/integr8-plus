import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type {
  Database,
  FormTemplateCategory,
  FormTemplateDocumentsTable,
  FormTemplateFilesTable,
  FormTemplateSource,
  FormTemplatesTable,
} from '../schema.js';

export interface FormTemplateRecord {
  key: string;
  title: Record<string, string>;
  description: Record<string, string>;
  category: FormTemplateCategory;
  definition: Record<string, unknown>;
  definitionSchemaVersion: number;
  updatedAt: Date;
  /** `builtin` (code-managed, read-only) or `staff` (saved from a company's form; 0069). */
  source: FormTemplateSource;
  retiredAt: Date | null;
  /** Where a staff-made template came from; null for a built-in one. */
  origin: { tenantId: string; formId: string; versionNumber: number | null } | null;
  createdAt: Date;
  /** How many PDF templates it carries. */
  documentCount: number;
}

export interface FormTemplateInput {
  key: string;
  title: Record<string, string>;
  description: Record<string, string>;
  category: FormTemplateCategory;
  definition: Record<string, unknown>;
}

/** A PDF template a library form carries (0069). */
export interface LibraryDocument {
  id: string;
  position: number;
  name: string;
  design: Record<string, unknown>;
  designSchemaVersion: number;
}

/** A picture one of those uses, in the platform-library bucket. */
export interface LibraryFile {
  id: string;
  bucket: string;
  storageKey: string;
  contentType: string;
  byteSize: number;
  etag: string | null;
}

/** What a staff-made template is made of: its form and its PDF templates. */
export interface LibraryContent {
  definition: Record<string, unknown>;
  /** The source form's version number; null for a template saved from a definition. */
  sourceVersionNumber: number | null;
  documents: readonly { name: string; design: Record<string, unknown> }[];
  files: readonly LibraryFile[];
}

/**
 * The global form template library, read from a company's request.
 *
 * Not tenant-scoped, because a template belongs to no company. It is still read
 * inside the tenant transaction, as `integr8_app`, where the only privilege on
 * `form_templates` is `select` — so this class could not write a template even
 * if it tried. A retired template is not offered (0069).
 */
export class FormTemplatesReader {
  constructor(private readonly db: Transaction<Database> | Kysely<Database>) {}

  async list(): Promise<FormTemplateRecord[]> {
    return (
      await this.db
        .selectFrom('form_templates')
        .selectAll()
        .where('retired_at', 'is', null)
        .orderBy('category')
        .orderBy('key')
        .execute()
    ).map((row) => toDomain(row, 0));
  }

  async find(key: string): Promise<FormTemplateRecord | undefined> {
    const row = await this.db
      .selectFrom('form_templates')
      .selectAll()
      .where('key', '=', key)
      .where('retired_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? undefined : toDomain(row, 0);
  }
}

/**
 * The library as the platform keeps it, as the platform role.
 *
 * Built-in templates start as whatever @integr8/form-engine ships, and
 * `db templates` keeps them equal to the code. Staff-made ones (0069) are
 * saved from a company's form and managed from the dashboard; `db templates`
 * never touches them, and nothing here deletes either kind — a company may
 * already have started from it, and a template that vanished from the list
 * would be a support question with no answer.
 */
export class FormTemplatesWriter {
  constructor(private readonly db: Kysely<Database>) {}

  /** Every template, retired ones included, with how many PDF templates each carries. */
  async list(): Promise<FormTemplateRecord[]> {
    const [rows, counts] = await Promise.all([
      this.db.selectFrom('form_templates').selectAll().orderBy('category').orderBy('key').execute(),
      this.#documentCounts(),
    ]);
    return rows.map((row) => toDomain(row, counts.get(row.key) ?? 0));
  }

  /** One template, retired or not. */
  async find(key: string): Promise<FormTemplateRecord | undefined> {
    const row = await this.db
      .selectFrom('form_templates')
      .selectAll()
      .where('key', '=', key)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    return toDomain(row, (await this.#documentCounts(key)).get(key) ?? 0);
  }

  /**
   * Loads the built-in templates. An upsert, and only ever over a built-in
   * row: a staff-made template that happens to hold a key the code later
   * ships is left exactly as staff made it.
   */
  async upsert(templates: readonly FormTemplateInput[]): Promise<number> {
    if (templates.length === 0) {
      return 0;
    }

    const rows = templates.map((template) => ({
      key: template.key,
      title: template.title,
      description: template.description,
      category: template.category,
      definition: template.definition,
      definition_schema_version: schemaVersionOf(template.definition),
    }));

    const result = await this.db
      .insertInto('form_templates')
      .values(rows)
      .onConflict((conflict) =>
        conflict
          .column('key')
          .doUpdateSet({
            title: sql`excluded.title`,
            description: sql`excluded.description`,
            category: sql`excluded.category`,
            definition: sql`excluded.definition`,
            definition_schema_version: sql`excluded.definition_schema_version`,
          })
          .where('form_templates.source', '=', 'builtin'),
      )
      .executeTakeFirst();

    return Number(result.numInsertedOrUpdatedRows ?? 0n);
  }

  /**
   * Adds a staff-made template with its PDF templates and pictures, in one
   * transaction. `false` when the key is taken, by either kind.
   */
  async createStaff(input: {
    key: string;
    title: Record<string, string>;
    description: Record<string, string>;
    category: FormTemplateCategory;
    /** The company form it was saved from; null for one saved from a definition. */
    origin: { tenantId: string; formId: string } | null;
    content: LibraryContent;
    by: string;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('form_templates')
        .values({
          key: input.key,
          title: input.title,
          description: input.description,
          category: input.category,
          definition: input.content.definition,
          definition_schema_version: schemaVersionOf(input.content.definition),
          source: 'staff',
          source_tenant_id: input.origin?.tenantId ?? null,
          source_form_id: input.origin?.formId ?? null,
          source_version_number: input.content.sourceVersionNumber,
          created_by: input.by,
          updated_by: input.by,
        })
        .onConflict((conflict) => conflict.column('key').doNothing())
        .returning('key')
        .executeTakeFirst();
      if (inserted === undefined) {
        return false;
      }
      await insertContent(trx, input.key, input.content);
      return true;
    });
  }

  /** Renames, re-describes or re-files a staff-made template. `undefined` for a built-in or none. */
  async updateDetails(
    key: string,
    change: {
      title?: Record<string, string> | undefined;
      description?: Record<string, string> | undefined;
      category?: FormTemplateCategory | undefined;
    },
    by: string,
  ): Promise<FormTemplateRecord | undefined> {
    const row = await this.db
      .updateTable('form_templates')
      .set({
        ...(change.title === undefined ? {} : { title: change.title }),
        ...(change.description === undefined ? {} : { description: change.description }),
        ...(change.category === undefined ? {} : { category: change.category }),
        updated_by: by,
      })
      .where('key', '=', key)
      .where('source', '=', 'staff')
      .returning('key')
      .executeTakeFirst();
    return row === undefined ? undefined : this.find(key);
  }

  /**
   * Replaces a staff-made template's form and PDF templates with newer ones.
   * Returns the pictures it no longer uses, for the caller to remove from the
   * bucket once this has committed; `undefined` for a built-in or none.
   */
  async replaceContent(
    key: string,
    content: LibraryContent,
    by: string,
  ): Promise<LibraryFile[] | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable('form_templates')
        .set({
          definition: content.definition,
          definition_schema_version: schemaVersionOf(content.definition),
          source_version_number: content.sourceVersionNumber,
          updated_by: by,
        })
        .where('key', '=', key)
        .where('source', '=', 'staff')
        .returning('key')
        .executeTakeFirst();
      if (row === undefined) {
        return undefined;
      }
      const old = (
        await trx
          .selectFrom('form_template_files')
          .selectAll()
          .where('template_key', '=', key)
          .execute()
      ).map(toFile);
      await trx.deleteFrom('form_template_documents').where('template_key', '=', key).execute();
      await trx.deleteFrom('form_template_files').where('template_key', '=', key).execute();
      await insertContent(trx, key, content);
      return old;
    });
  }

  /** Replaces only a staff-made template's form. `false` for a built-in or none. */
  async replaceDefinition(
    key: string,
    definition: Record<string, unknown>,
    by: string,
  ): Promise<boolean> {
    const row = await this.db
      .updateTable('form_templates')
      .set({
        definition,
        definition_schema_version: schemaVersionOf(definition),
        updated_by: by,
      })
      .where('key', '=', key)
      .where('source', '=', 'staff')
      .returning('key')
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Retires a staff-made template, or brings it back. `undefined` for a built-in or none. */
  async setRetired(
    key: string,
    retired: boolean,
    by: string,
  ): Promise<FormTemplateRecord | undefined> {
    const row = await this.db
      .updateTable('form_templates')
      .set(
        retired
          ? { retired_at: sql<Date>`coalesce(retired_at, now())`, retired_by: by, updated_by: by }
          : { retired_at: null, retired_by: null, updated_by: by },
      )
      .where('key', '=', key)
      .where('source', '=', 'staff')
      .returning('key')
      .executeTakeFirst();
    return row === undefined ? undefined : this.find(key);
  }

  /** The PDF templates a library form carries, in order. */
  async documents(key: string): Promise<LibraryDocument[]> {
    return (
      await this.db
        .selectFrom('form_template_documents')
        .selectAll()
        .where('template_key', '=', key)
        .orderBy('position')
        .execute()
    ).map(toDocument);
  }

  /** The pictures those use. */
  async files(key: string): Promise<LibraryFile[]> {
    return (
      await this.db
        .selectFrom('form_template_files')
        .selectAll()
        .where('template_key', '=', key)
        .orderBy('created_at')
        .orderBy('id')
        .execute()
    ).map(toFile);
  }

  async #documentCounts(key?: string): Promise<Map<string, number>> {
    let query = this.db
      .selectFrom('form_template_documents')
      .select(['template_key', (eb) => eb.fn.countAll<string>().as('count')])
      .groupBy('template_key');
    if (key !== undefined) {
      query = query.where('template_key', '=', key);
    }
    return new Map((await query.execute()).map((row) => [row.template_key, Number(row.count)]));
  }
}

async function insertContent(
  trx: Transaction<Database>,
  key: string,
  content: LibraryContent,
): Promise<void> {
  if (content.files.length > 0) {
    await trx
      .insertInto('form_template_files')
      .values(
        content.files.map((file) => ({
          id: file.id,
          template_key: key,
          bucket: file.bucket,
          storage_key: file.storageKey,
          content_type: file.contentType,
          byte_size: file.byteSize,
          etag: file.etag,
        })),
      )
      .execute();
  }
  if (content.documents.length > 0) {
    await trx
      .insertInto('form_template_documents')
      .values(
        content.documents.map((document, position) => ({
          template_key: key,
          position,
          name: document.name,
          design: document.design,
          design_schema_version: designSchemaVersionOf(document.design),
        })),
      )
      .execute();
  }
}

function schemaVersionOf(definition: Record<string, unknown>): number {
  const version = definition.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new TypeError('A template definition must carry an integer schemaVersion');
  }
  return version;
}

function designSchemaVersionOf(design: Record<string, unknown>): number {
  const version = design.schemaVersion;
  return typeof version === 'number' && Number.isInteger(version) ? version : 1;
}

function toDomain(row: Selectable<FormTemplatesTable>, documentCount: number): FormTemplateRecord {
  return {
    key: row.key,
    title: row.title,
    description: row.description,
    category: row.category,
    definition: row.definition,
    definitionSchemaVersion: row.definition_schema_version,
    updatedAt: row.updated_at,
    source: row.source,
    retiredAt: row.retired_at,
    origin:
      row.source_tenant_id === null || row.source_form_id === null
        ? null
        : {
            tenantId: row.source_tenant_id,
            formId: row.source_form_id,
            versionNumber: row.source_version_number,
          },
    createdAt: row.created_at,
    documentCount,
  };
}

function toDocument(row: Selectable<FormTemplateDocumentsTable>): LibraryDocument {
  return {
    id: row.id,
    position: row.position,
    name: row.name,
    design: row.design,
    designSchemaVersion: row.design_schema_version,
  };
}

function toFile(row: Selectable<FormTemplateFilesTable>): LibraryFile {
  return {
    id: row.id,
    bucket: row.bucket,
    storageKey: row.storage_key,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    etag: row.etag,
  };
}
