import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { Database, FormTemplateCategory, FormTemplatesTable } from '../schema.js';

export interface FormTemplateRecord {
  key: string;
  title: Record<string, string>;
  description: Record<string, string>;
  category: FormTemplateCategory;
  definition: Record<string, unknown>;
  definitionSchemaVersion: number;
  updatedAt: Date;
}

export interface FormTemplateInput {
  key: string;
  title: Record<string, string>;
  description: Record<string, string>;
  category: FormTemplateCategory;
  definition: Record<string, unknown>;
}

/**
 * The global form template library, read from a company's request.
 *
 * Not tenant-scoped, because a template belongs to no company. It is still read
 * inside the tenant transaction, as `integr8_app`, where the only privilege on
 * `form_templates` is `select` — so this class could not write a template even
 * if it tried.
 */
export class FormTemplatesReader {
  constructor(private readonly db: Transaction<Database> | Kysely<Database>) {}

  async list(): Promise<FormTemplateRecord[]> {
    return (
      await this.db
        .selectFrom('form_templates')
        .selectAll()
        .orderBy('category')
        .orderBy('key')
        .execute()
    ).map(toDomain);
  }

  async find(key: string): Promise<FormTemplateRecord | undefined> {
    const row = await this.db
      .selectFrom('form_templates')
      .selectAll()
      .where('key', '=', key)
      .executeTakeFirst();
    return row === undefined ? undefined : toDomain(row);
  }
}

/**
 * Loading the library, as the schema owner.
 *
 * The library starts as whatever @integr8/form-engine ships, synchronised by
 * `db templates`, and P15's dashboard edits it from there. An upsert rather
 * than a replace: removing a template from the code does not remove it from
 * the database, because companies may already have cloned it and a template
 * that vanished from the list would be a support question with no answer.
 */
export class FormTemplatesWriter {
  constructor(private readonly db: Kysely<Database>) {}

  /** The library as it stands, for the dashboard that manages it (P15). */
  async list(): Promise<FormTemplateRecord[]> {
    return new FormTemplatesReader(this.db).list();
  }

  async find(key: string): Promise<FormTemplateRecord | undefined> {
    return new FormTemplatesReader(this.db).find(key);
  }

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
        conflict.column('key').doUpdateSet({
          title: sql`excluded.title`,
          description: sql`excluded.description`,
          category: sql`excluded.category`,
          definition: sql`excluded.definition`,
          definition_schema_version: sql`excluded.definition_schema_version`,
        }),
      )
      .executeTakeFirst();

    return Number(result.numInsertedOrUpdatedRows ?? 0n);
  }
}

function schemaVersionOf(definition: Record<string, unknown>): number {
  const version = definition.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new TypeError('A template definition must carry an integer schemaVersion');
  }
  return version;
}

function toDomain(row: Selectable<FormTemplatesTable>): FormTemplateRecord {
  return {
    key: row.key,
    title: row.title,
    description: row.description,
    category: row.category,
    definition: row.definition,
    definitionSchemaVersion: row.definition_schema_version,
    updatedAt: row.updated_at,
  };
}
