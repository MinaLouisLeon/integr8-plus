import { toUserId, type UserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { HrEmployeesTable } from '../schema.js';
import { toDayString } from './crm-leads.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Employee profiles (0036; ADR-0010): linked to a member, or standing alone
 * for someone who never signs in. Ended, never deleted. The sealed columns
 * arrive as ciphertext from the API, which alone holds the key; this
 * repository stores and returns them untouched.
 */

/** A sealed field: ciphertext and the last four characters in clear. */
export interface SealedField {
  sealed: string;
  last4: string;
}

export interface Employee {
  id: string;
  userId: UserId | null;
  employeeNumber: string | null;
  fullName: string;
  jobTitle: string | null;
  department: string | null;
  phone: string | null;
  /** `YYYY-MM-DD`. */
  hireDate: string;
  endDate: string | null;
  endReason: string | null;
  nationalId: SealedField | null;
  insuranceNumber: SealedField | null;
  bankName: string | null;
  bankAccount: SealedField | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  version: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
}

/** What may be written. A sealed field is `null` to clear it. */
export interface EmployeeInput {
  userId?: string | null;
  employeeNumber?: string | null;
  fullName?: string;
  jobTitle?: string | null;
  department?: string | null;
  phone?: string | null;
  hireDate?: string;
  endDate?: string | null;
  endReason?: string | null;
  nationalId?: SealedField | null;
  insuranceNumber?: SealedField | null;
  bankName?: string | null;
  bankAccount?: SealedField | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
}

export type EmployeeRefusal = 'number_taken' | 'member_taken';

export interface EmployeeQuery {
  /** Words of the name, the employee number, title or department. */
  q?: string | undefined;
  status?: 'active' | 'ended' | undefined;
  department?: string | undefined;
  after?: { name: string; id: string } | undefined;
  limit: number;
}

function sealed(value: string | null, last4: string | null): SealedField | null {
  return value === null || last4 === null ? null : { sealed: value, last4 };
}

function toEmployee(row: Selectable<HrEmployeesTable>): Employee {
  return {
    id: row.id,
    userId: row.user_id === null ? null : toUserId(row.user_id),
    employeeNumber: row.employee_number,
    fullName: row.full_name,
    jobTitle: row.job_title,
    department: row.department,
    phone: row.phone,
    hireDate: toDayString(row.hire_date) ?? '',
    endDate: toDayString(row.end_date),
    endReason: row.end_reason,
    nationalId: sealed(row.national_id_sealed, row.national_id_last4),
    insuranceNumber: sealed(row.insurance_number_sealed, row.insurance_number_last4),
    bankName: row.bank_name,
    bankAccount: sealed(row.bank_account_sealed, row.bank_account_last4),
    emergencyContactName: row.emergency_contact_name,
    emergencyContactPhone: row.emergency_contact_phone,
    version: row.version,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The columns an input writes; only the keys it names. */
function columns(input: EmployeeInput): Partial<Record<keyof HrEmployeesTable, unknown>> {
  const out: Partial<Record<keyof HrEmployeesTable, unknown>> = {};
  const plain: [keyof EmployeeInput, keyof HrEmployeesTable][] = [
    ['userId', 'user_id'],
    ['employeeNumber', 'employee_number'],
    ['fullName', 'full_name'],
    ['jobTitle', 'job_title'],
    ['department', 'department'],
    ['phone', 'phone'],
    ['hireDate', 'hire_date'],
    ['endDate', 'end_date'],
    ['endReason', 'end_reason'],
    ['bankName', 'bank_name'],
    ['emergencyContactName', 'emergency_contact_name'],
    ['emergencyContactPhone', 'emergency_contact_phone'],
  ];
  for (const [key, column] of plain) {
    if (input[key] !== undefined) {
      out[column] = input[key];
    }
  }
  const sealedColumns: [
    'nationalId' | 'insuranceNumber' | 'bankAccount',
    keyof HrEmployeesTable,
    keyof HrEmployeesTable,
  ][] = [
    ['nationalId', 'national_id_sealed', 'national_id_last4'],
    ['insuranceNumber', 'insurance_number_sealed', 'insurance_number_last4'],
    ['bankAccount', 'bank_account_sealed', 'bank_account_last4'],
  ];
  for (const [key, value, last4] of sealedColumns) {
    const field = input[key];
    if (field !== undefined) {
      out[value] = field?.sealed ?? null;
      out[last4] = field?.last4 ?? null;
    }
  }
  return out;
}

export class HrEmployeesRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async find(id: string): Promise<Employee | undefined> {
    const row = await this.db
      .selectFrom('hr_employees')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toEmployee(row);
  }

  async findMany(ids: readonly string[]): Promise<Employee[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('hr_employees')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', 'in', [...new Set(ids)])
      .execute();
    return rows.map(toEmployee);
  }

  async findByUser(userId: UserId | string): Promise<Employee | undefined> {
    const row = await this.db
      .selectFrom('hr_employees')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('user_id', '=', toUserId(userId))
      .executeTakeFirst();
    return row === undefined ? undefined : toEmployee(row);
  }

  async lock(id: string): Promise<Employee | undefined> {
    const row = await this.db
      .selectFrom('hr_employees')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : toEmployee(row);
  }

  /** By name, then id; ended employees only when asked. */
  async list(
    query: EmployeeQuery,
  ): Promise<{ items: Employee[]; next?: { name: string; id: string } }> {
    let select = this.db
      .selectFrom('hr_employees')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (query.status === 'active') {
      select = select.where('end_date', 'is', null);
    } else if (query.status === 'ended') {
      select = select.where('end_date', 'is not', null);
    }
    if (query.department !== undefined) {
      select = select.where('department', '=', query.department);
    }
    if (query.q !== undefined && query.q.trim() !== '') {
      const words = `%${query.q.trim().replace(/[\\%_]/gu, (match) => `\\${match}`)}%`;
      select = select.where((eb) =>
        eb.or([
          eb('full_name', 'ilike', words),
          eb('employee_number', 'ilike', words),
          eb('job_title', 'ilike', words),
          eb('department', 'ilike', words),
        ]),
      );
    }
    if (query.after !== undefined) {
      const { name, id } = query.after;
      select = select.where(sql<boolean>`(lower(full_name), id) > (lower(${name}), ${id}::uuid)`);
    }
    const rows = await select
      .orderBy(sql`lower(full_name)`)
      .orderBy('id')
      .limit(query.limit + 1)
      .execute();
    const items = rows.slice(0, query.limit).map(toEmployee);
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > query.limit && last !== undefined
        ? { next: { name: last.fullName, id: last.id } }
        : {}),
    };
  }

  /** The departments in use, for a filter and a picker. */
  async departments(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('hr_employees')
      .select('department')
      .distinct()
      .where('tenant_id', '=', this.tenantId)
      .where('department', 'is not', null)
      .orderBy('department')
      .execute();
    return rows.flatMap((row) => (row.department === null ? [] : [row.department]));
  }

  /** Checked before writing, so a refusal leaves the transaction usable. */
  async #clash(input: EmployeeInput, exceptId?: string): Promise<EmployeeRefusal | undefined> {
    if (input.employeeNumber !== undefined && input.employeeNumber !== null) {
      let numbered = this.db
        .selectFrom('hr_employees')
        .select('id')
        .where('tenant_id', '=', this.tenantId)
        .where(sql<boolean>`lower(employee_number) = lower(${input.employeeNumber})`);
      if (exceptId !== undefined) {
        numbered = numbered.where('id', '<>', exceptId);
      }
      if ((await numbered.executeTakeFirst()) !== undefined) {
        return 'number_taken';
      }
    }
    if (input.userId !== undefined && input.userId !== null) {
      let linked = this.db
        .selectFrom('hr_employees')
        .select('id')
        .where('tenant_id', '=', this.tenantId)
        .where('user_id', '=', toUserId(input.userId));
      if (exceptId !== undefined) {
        linked = linked.where('id', '<>', exceptId);
      }
      if ((await linked.executeTakeFirst()) !== undefined) {
        return 'member_taken';
      }
    }
    return undefined;
  }

  /**
   * `id` may be chosen by the caller: the API seals the sensitive fields to
   * the employee's id, so it needs the id before the row exists.
   */
  async create(
    input: EmployeeInput & { fullName: string; hireDate: string; id?: string },
    by: UserId | string,
  ): Promise<Employee | EmployeeRefusal> {
    const clash = await this.#clash(input);
    if (clash !== undefined) {
      return clash;
    }
    const row = await this.db
      .insertInto('hr_employees')
      .values({
        ...(columns(input) as Record<string, never>),
        ...(input.id === undefined ? {} : { id: input.id }),
        tenant_id: this.tenantId,
        full_name: input.fullName,
        hire_date: input.hireDate,
        created_by: toUserId(by),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toEmployee(row);
  }

  async update(
    id: string,
    expectedVersion: number,
    input: EmployeeInput,
  ): Promise<Employee | EmployeeRefusal | 'version_conflict'> {
    const clash = await this.#clash(input, id);
    if (clash !== undefined) {
      return clash;
    }
    const row = await this.db
      .updateTable('hr_employees')
      .set({
        ...(columns(input) as Record<string, never>),
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? 'version_conflict' : toEmployee(row);
  }
}
