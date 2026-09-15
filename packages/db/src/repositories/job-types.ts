import {
  type TenantId,
  type UserId,
  type WorkOrderPriority,
  toTenantId,
  toUserId,
} from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { ChecklistTemplateItem, JobTypesTable } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export interface JobTypeForm {
  formId: string;
  required: boolean;
  position: number;
}

export interface JobType {
  id: string;
  tenantId: TenantId;
  name: string;
  code: string;
  description: string | null;
  expectedDurationMinutes: number | null;
  defaultPriority: WorkOrderPriority;
  instructions: string | null;
  checklist: ChecklistTemplateItem[];
  forms: JobTypeForm[];
  /** Photos to take before and after the work (P14). */
  beforePhotos: number;
  afterPhotos: number;
  /** Whether the customer must sign off before a job of this type completes. */
  signatureRequired: boolean;
  archivedAt: Date | null;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobTypeInput {
  name: string;
  code: string;
  description?: string | null;
  expectedDurationMinutes?: number | null;
  defaultPriority?: WorkOrderPriority;
  instructions?: string | null;
  checklist?: readonly ChecklistTemplateItem[];
  beforePhotos?: number;
  afterPhotos?: number;
  signatureRequired?: boolean;
  /** Replaces the list. Order is kept. */
  forms?: readonly { formId: string; required: boolean }[];
}

const blank = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null || value.trim() === '' ? null : value.trim();

/** A code as people type one: `boiler service` becomes `BOILER-SERVICE`. */
export function normaliseJobTypeCode(code: string): string {
  return code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/**
 * The kinds of job a company does, and what each carries onto a new work order:
 * forms (some required), a checklist, instructions, an expected duration, how
 * many before and after photos to take, and whether the customer signs off.
 *
 * A work order copies these when it is created, so changing a type changes the
 * jobs created afterwards and none that are already out.
 */
export class JobTypesRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  #jobTypes() {
    return this.db.selectFrom('job_types').where('job_types.tenant_id', '=', this.tenantId);
  }

  async create(input: JobTypeInput, createdBy: UserId | string): Promise<JobType> {
    const row = await this.db
      .insertInto('job_types')
      .values({
        tenant_id: this.tenantId,
        created_by: toUserId(createdBy),
        ...columns(input),
        name: input.name.trim(),
        code: normaliseJobTypeCode(input.code),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (input.forms !== undefined) {
      await this.#replaceForms(row.id, input.forms);
    }
    return (await this.find(row.id))!;
  }

  async update(jobTypeId: string, input: Partial<JobTypeInput>): Promise<JobType | undefined> {
    const changes = columns(input);
    if (Object.keys(changes).length > 0) {
      const updated = await this.db
        .updateTable('job_types')
        .set(changes)
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', jobTypeId)
        .returning('id')
        .executeTakeFirst();
      if (updated === undefined) {
        return undefined;
      }
    }
    if (input.forms !== undefined) {
      if (
        (await this.#jobTypes().select('id').where('id', '=', jobTypeId).executeTakeFirst()) ===
        undefined
      ) {
        return undefined;
      }
      await this.#replaceForms(jobTypeId, input.forms);
    }
    return this.find(jobTypeId);
  }

  async setArchived(jobTypeId: string, archived: boolean): Promise<JobType | undefined> {
    const row = await this.db
      .updateTable('job_types')
      .set({ archived_at: archived ? sql<Date>`coalesce(archived_at, now())` : null })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', jobTypeId)
      .returning('id')
      .executeTakeFirst();
    return row === undefined ? undefined : this.find(jobTypeId);
  }

  async find(jobTypeId: string): Promise<JobType | undefined> {
    return (
      await this.#load(await this.#jobTypes().selectAll().where('id', '=', jobTypeId).execute())
    )[0];
  }

  async findByCode(code: string): Promise<JobType | undefined> {
    return (
      await this.#load(
        await this.#jobTypes().selectAll().where('code', '=', normaliseJobTypeCode(code)).execute(),
      )
    )[0];
  }

  async list(options: { includeArchived?: boolean } = {}): Promise<JobType[]> {
    let select = this.#jobTypes().selectAll();
    if (options.includeArchived !== true) {
      select = select.where('archived_at', 'is', null);
    }
    return this.#load(await select.orderBy(sql`lower(name)`).execute());
  }

  // -------------------------------------------------------------------------
  // The form's side: which job types require it (P07's settings screen)
  // -------------------------------------------------------------------------

  /** The job types a form is attached to, and whether each requires it. */
  async listForForm(formId: string): Promise<{ jobTypeId: string; required: boolean }[]> {
    const rows = await this.db
      .selectFrom('job_type_forms')
      .select(['job_type_id', 'required'])
      .where('tenant_id', '=', this.tenantId)
      .where('form_id', '=', formId)
      .execute();
    return rows.map((row) => ({ jobTypeId: row.job_type_id, required: row.required }));
  }

  /**
   * Makes exactly these job types require the form. Types not listed stop
   * requiring it but keep offering it; a type that did not carry it gains it at
   * the end of its list.
   */
  async setRequiringTypes(formId: string, jobTypeIds: readonly string[]): Promise<void> {
    const wanted = [...new Set(jobTypeIds)];
    await this.db
      .updateTable('job_type_forms')
      .set({ required: false })
      .where('tenant_id', '=', this.tenantId)
      .where('form_id', '=', formId)
      .where('required', '=', true)
      .$if(wanted.length > 0, (query) => query.where('job_type_id', 'not in', wanted))
      .execute();
    if (wanted.length === 0) {
      return;
    }
    await this.db
      .insertInto('job_type_forms')
      .columns(['tenant_id', 'job_type_id', 'form_id', 'required', 'position'])
      .expression((eb) =>
        eb
          .selectFrom('job_types')
          .select([
            'job_types.tenant_id',
            'job_types.id',
            sql<string>`${formId}::uuid`.as('form_id'),
            sql<boolean>`true`.as('required'),
            sql<number>`coalesce((select max(position) + 1 from job_type_forms f where f.tenant_id = job_types.tenant_id and f.job_type_id = job_types.id), 0)`.as(
              'position',
            ),
          ])
          .where('job_types.tenant_id', '=', this.tenantId)
          .where('job_types.id', 'in', wanted),
      )
      .onConflict((conflict) =>
        conflict.columns(['tenant_id', 'job_type_id', 'form_id']).doUpdateSet({ required: true }),
      )
      .execute();
  }

  async #replaceForms(jobTypeId: string, forms: readonly { formId: string; required: boolean }[]) {
    await this.db
      .deleteFrom('job_type_forms')
      .where('tenant_id', '=', this.tenantId)
      .where('job_type_id', '=', jobTypeId)
      .execute();
    const unique = [...new Map(forms.map((form) => [form.formId, form])).values()];
    if (unique.length === 0) {
      return;
    }
    await this.db
      .insertInto('job_type_forms')
      .values(
        unique.map((form, position) => ({
          tenant_id: this.tenantId,
          job_type_id: jobTypeId,
          form_id: form.formId,
          required: form.required,
          position,
        })),
      )
      .execute();
  }

  async #load(rows: Selectable<JobTypesTable>[]): Promise<JobType[]> {
    if (rows.length === 0) {
      return [];
    }
    const forms = await this.db
      .selectFrom('job_type_forms')
      .select(['job_type_id', 'form_id', 'required', 'position'])
      .where('tenant_id', '=', this.tenantId)
      .where(
        'job_type_id',
        'in',
        rows.map((row) => row.id),
      )
      .orderBy('position')
      .execute();
    return rows.map((row) =>
      toJobType(
        row,
        forms
          .filter((form) => form.job_type_id === row.id)
          .map((form) => ({
            formId: form.form_id,
            required: form.required,
            position: form.position,
          })),
      ),
    );
  }
}

function columns(input: Partial<JobTypeInput>) {
  return {
    ...(input.name === undefined ? {} : { name: input.name.trim() }),
    ...(input.code === undefined ? {} : { code: normaliseJobTypeCode(input.code) }),
    ...(input.description === undefined ? {} : { description: blank(input.description) }),
    ...(input.expectedDurationMinutes === undefined
      ? {}
      : { expected_duration_minutes: input.expectedDurationMinutes }),
    ...(input.defaultPriority === undefined ? {} : { default_priority: input.defaultPriority }),
    ...(input.beforePhotos === undefined ? {} : { before_photos: input.beforePhotos }),
    ...(input.afterPhotos === undefined ? {} : { after_photos: input.afterPhotos }),
    ...(input.signatureRequired === undefined
      ? {}
      : { signature_required: input.signatureRequired }),
    ...(input.instructions === undefined ? {} : { instructions: blank(input.instructions) }),
    ...(input.checklist === undefined
      ? {}
      : {
          // As JSON text: pg would send a bare array as a Postgres array literal.
          checklist: sql<ChecklistTemplateItem[]>`${JSON.stringify(
            input.checklist
              .map((item) => ({ id: item.id, label: item.label.trim() }))
              .filter((item) => item.label !== ''),
          )}::jsonb`,
        }),
  };
}

function toJobType(row: Selectable<JobTypesTable>, forms: JobTypeForm[]): JobType {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    name: row.name,
    code: row.code,
    description: row.description,
    expectedDurationMinutes: row.expected_duration_minutes,
    defaultPriority: row.default_priority,
    instructions: row.instructions,
    checklist: row.checklist,
    forms,
    beforePhotos: row.before_photos,
    afterPhotos: row.after_photos,
    signatureRequired: row.signature_required,
    archivedAt: row.archived_at,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
