import {
  type PayMethod,
  type PayrollRules,
  type PayRunStatus,
  toUserId,
  type UserId,
} from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type {
  HrPayrollLinesTable,
  HrPayrollRuleSetsTable,
  HrPayrollRunsTable,
  HrPayTermsTable,
} from '../schema.js';
import { toDayString, trimDecimal } from './crm-leads.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Egyptian payroll (0038; ADR-0010): dated rule sets the owner confirms,
 * dated pay terms per employee, and a month's pay run whose lines hold what
 * went in and what came out. The calculation is the API's (calculatePay in
 * @integr8/core); this repository stores its results. The database's guards
 * keep a confirmed set and an approved run as they are.
 */

export interface PayrollRuleSet {
  id: string;
  name: string;
  /** `YYYY-MM-01`. */
  effectiveFrom: string;
  rules: PayrollRules;
  confirmedBy: UserId | null;
  confirmedAt: Date | null;
  confirmationNote: string | null;
  createdBy: UserId;
  createdAt: Date;
  version: number;
}

export interface PayTerms {
  id: string;
  employeeId: string;
  /** `YYYY-MM-DD`. */
  effectiveFrom: string;
  basic: string;
  allowances: string;
  insured: boolean;
  insurableWage: string | null;
  standardHours: string;
  /** Null: 135% of the hourly basic. */
  overtimeRate: string | null;
  payMethod: PayMethod;
  version: number;
}

export interface PayTermsInput {
  effectiveFrom: string;
  basic: string;
  allowances: string;
  insured: boolean;
  insurableWage: string | null;
  standardHours: string;
  overtimeRate: string | null;
  payMethod: PayMethod;
}

export interface PayRun {
  id: string;
  /** `YYYY-MM-01`. */
  periodStart: string;
  periodEnd: string;
  ruleSetId: string;
  currency: string;
  status: PayRunStatus;
  payDate: string | null;
  note: string | null;
  preparedBy: UserId;
  preparedAt: Date;
  approvedBy: UserId | null;
  approvedAt: Date | null;
  version: number;
}

export interface PayRunTotals {
  employees: number;
  gross: string;
  socialInsuranceEmployee: string;
  socialInsuranceEmployer: string;
  incomeTax: string;
  martyrsFund: string;
  reimbursements: string;
  net: string;
}

/** What a line is calculated from. */
export interface PayLineInputs {
  basic: string;
  allowances: string;
  clockedHours: string;
  overtimeHours: string;
  overtimeRate: string;
  bonus: string;
  deduction: string;
  unpaidDays: string;
  reimbursements: string;
  declaredInsurableWage: string | null;
  insured: boolean;
  payMethod: PayMethod;
  note: string | null;
}

/** What the calculation made of them. */
export interface PayLineResults {
  overtimePay: string;
  unpaidLeave: string;
  gross: string;
  insurableWage: string;
  socialInsuranceEmployee: string;
  socialInsuranceEmployer: string;
  taxable: string;
  incomeTax: string;
  martyrsFund: string;
  net: string;
}

export interface PayLine extends PayLineInputs, PayLineResults {
  id: string;
  runId: string;
  employeeId: string;
  /** For ordering and display; the employee's name now. */
  employeeName: string;
  version: number;
}

/** Somebody employed for at least a day of a month, with their terms then. */
export interface PayrollCandidate {
  employeeId: string;
  userId: UserId | null;
  fullName: string;
  hireDate: string;
  endDate: string | null;
  terms: PayTerms | null;
}

const decimal = (value: string) => trimDecimal(value);

function toRuleSet(row: Selectable<HrPayrollRuleSetsTable>): PayrollRuleSet {
  return {
    id: row.id,
    name: row.name,
    effectiveFrom: toDayString(row.effective_from) ?? '',
    rules: row.rules,
    confirmedBy: row.confirmed_by === null ? null : toUserId(row.confirmed_by),
    confirmedAt: row.confirmed_at,
    confirmationNote: row.confirmation_note,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    version: row.version,
  };
}

function toTerms(row: Selectable<HrPayTermsTable>): PayTerms {
  return {
    id: row.id,
    employeeId: row.employee_id,
    effectiveFrom: toDayString(row.effective_from) ?? '',
    basic: decimal(row.basic),
    allowances: decimal(row.allowances),
    insured: row.insured,
    insurableWage: row.insurable_wage === null ? null : decimal(row.insurable_wage),
    standardHours: decimal(row.standard_hours),
    overtimeRate: row.overtime_rate === null ? null : decimal(row.overtime_rate),
    payMethod: row.pay_method,
    version: row.version,
  };
}

function toRun(row: Selectable<HrPayrollRunsTable>): PayRun {
  return {
    id: row.id,
    periodStart: toDayString(row.period_start) ?? '',
    periodEnd: toDayString(row.period_end) ?? '',
    ruleSetId: row.rule_set_id,
    currency: row.currency,
    status: row.status,
    payDate: toDayString(row.pay_date),
    note: row.note,
    preparedBy: toUserId(row.prepared_by),
    preparedAt: row.prepared_at,
    approvedBy: row.approved_by === null ? null : toUserId(row.approved_by),
    approvedAt: row.approved_at,
    version: row.version,
  };
}

function toLine(row: Selectable<HrPayrollLinesTable> & { full_name: string }): PayLine {
  return {
    id: row.id,
    runId: row.run_id,
    employeeId: row.employee_id,
    employeeName: row.full_name,
    basic: decimal(row.basic),
    allowances: decimal(row.allowances),
    clockedHours: decimal(row.clocked_hours),
    overtimeHours: decimal(row.overtime_hours),
    overtimeRate: decimal(row.overtime_rate),
    bonus: decimal(row.bonus),
    deduction: decimal(row.deduction),
    unpaidDays: decimal(row.unpaid_days),
    reimbursements: decimal(row.reimbursements),
    declaredInsurableWage:
      row.declared_insurable_wage === null ? null : decimal(row.declared_insurable_wage),
    insured: row.insured,
    payMethod: row.pay_method,
    note: row.note,
    overtimePay: decimal(row.overtime_pay),
    unpaidLeave: decimal(row.unpaid_leave),
    gross: decimal(row.gross),
    insurableWage: decimal(row.insurable_wage),
    socialInsuranceEmployee: decimal(row.si_employee),
    socialInsuranceEmployer: decimal(row.si_employer),
    taxable: decimal(row.taxable),
    incomeTax: decimal(row.income_tax),
    martyrsFund: decimal(row.martyrs_fund),
    net: decimal(row.net),
    version: row.version,
  };
}

function lineColumns(line: PayLineInputs & PayLineResults) {
  return {
    basic: line.basic,
    allowances: line.allowances,
    clocked_hours: line.clockedHours,
    overtime_hours: line.overtimeHours,
    overtime_rate: line.overtimeRate,
    bonus: line.bonus,
    deduction: line.deduction,
    unpaid_days: line.unpaidDays,
    reimbursements: line.reimbursements,
    declared_insurable_wage: line.declaredInsurableWage,
    insured: line.insured,
    pay_method: line.payMethod,
    note: line.note,
    overtime_pay: line.overtimePay,
    unpaid_leave: line.unpaidLeave,
    gross: line.gross,
    insurable_wage: line.insurableWage,
    si_employee: line.socialInsuranceEmployee,
    si_employer: line.socialInsuranceEmployer,
    taxable: line.taxable,
    income_tax: line.incomeTax,
    martyrs_fund: line.martyrsFund,
    net: line.net,
  };
}

export class HrPayrollRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  // -------------------------------------------------------------------------
  // Rule sets
  // -------------------------------------------------------------------------

  /** Latest first. */
  async ruleSets(): Promise<PayrollRuleSet[]> {
    const rows = await this.db
      .selectFrom('hr_payroll_rule_sets')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .orderBy('effective_from', 'desc')
      .execute();
    return rows.map(toRuleSet);
  }

  async ruleSet(id: string): Promise<PayrollRuleSet | undefined> {
    const row = await this.db
      .selectFrom('hr_payroll_rule_sets')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRuleSet(row);
  }

  /** The confirmed set in force for a month, if any; and the latest set at all, confirmed or not. */
  async ruleSetFor(
    periodStart: string,
  ): Promise<{ confirmed?: PayrollRuleSet; latest?: PayrollRuleSet }> {
    const rows = await this.db
      .selectFrom('hr_payroll_rule_sets')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('effective_from', '<=', periodStart)
      .orderBy('effective_from', 'desc')
      .execute();
    const sets = rows.map(toRuleSet);
    const confirmed = sets.find((set) => set.confirmedAt !== null);
    const latest = sets[0];
    return {
      ...(confirmed === undefined ? {} : { confirmed }),
      ...(latest === undefined ? {} : { latest }),
    };
  }

  async #monthTaken(effectiveFrom: string, exceptId?: string): Promise<boolean> {
    let select = this.db
      .selectFrom('hr_payroll_rule_sets')
      .select('id')
      .where('tenant_id', '=', this.tenantId)
      .where('effective_from', '=', effectiveFrom);
    if (exceptId !== undefined) {
      select = select.where('id', '<>', exceptId);
    }
    return (await select.executeTakeFirst()) !== undefined;
  }

  async createRuleSet(
    input: { name: string; effectiveFrom: string; rules: PayrollRules },
    by: UserId | string,
  ): Promise<PayrollRuleSet | 'month_taken'> {
    if (await this.#monthTaken(input.effectiveFrom)) {
      return 'month_taken';
    }
    const row = await this.db
      .insertInto('hr_payroll_rule_sets')
      .values({
        tenant_id: this.tenantId,
        name: input.name,
        effective_from: input.effectiveFrom,
        rules: input.rules,
        created_by: toUserId(by),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRuleSet(row);
  }

  /** Only while unconfirmed; the caller checks, the guard insists. */
  async updateRuleSet(
    id: string,
    expectedVersion: number,
    input: { name?: string; effectiveFrom?: string; rules?: PayrollRules },
  ): Promise<PayrollRuleSet | 'month_taken' | 'version_conflict'> {
    if (input.effectiveFrom !== undefined && (await this.#monthTaken(input.effectiveFrom, id))) {
      return 'month_taken';
    }
    const row = await this.db
      .updateTable('hr_payroll_rule_sets')
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.effectiveFrom === undefined ? {} : { effective_from: input.effectiveFrom }),
        ...(input.rules === undefined ? {} : { rules: input.rules }),
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? 'version_conflict' : toRuleSet(row);
  }

  async confirmRuleSet(
    id: string,
    expectedVersion: number,
    by: UserId | string,
    note: string,
  ): Promise<PayrollRuleSet | undefined> {
    const row = await this.db
      .updateTable('hr_payroll_rule_sets')
      .set({
        confirmed_by: toUserId(by),
        confirmed_at: sql<Date>`now()`,
        confirmation_note: note,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .where('confirmed_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toRuleSet(row);
  }

  /** An unconfirmed set only. */
  async removeRuleSet(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('hr_payroll_rule_sets')
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('confirmed_at', 'is', null)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  // -------------------------------------------------------------------------
  // Pay terms
  // -------------------------------------------------------------------------

  /** An employee's terms, latest first. */
  async terms(employeeId: string): Promise<PayTerms[]> {
    const rows = await this.db
      .selectFrom('hr_pay_terms')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('employee_id', '=', employeeId)
      .orderBy('effective_from', 'desc')
      .execute();
    return rows.map(toTerms);
  }

  async termsById(id: string): Promise<PayTerms | undefined> {
    const row = await this.db
      .selectFrom('hr_pay_terms')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toTerms(row);
  }

  async #dateTaken(employeeId: string, effectiveFrom: string, exceptId?: string) {
    let select = this.db
      .selectFrom('hr_pay_terms')
      .select('id')
      .where('tenant_id', '=', this.tenantId)
      .where('employee_id', '=', employeeId)
      .where('effective_from', '=', effectiveFrom);
    if (exceptId !== undefined) {
      select = select.where('id', '<>', exceptId);
    }
    return (await select.executeTakeFirst()) !== undefined;
  }

  async addTerms(
    employeeId: string,
    input: PayTermsInput,
    by: UserId | string,
  ): Promise<PayTerms | 'date_taken'> {
    if (await this.#dateTaken(employeeId, input.effectiveFrom)) {
      return 'date_taken';
    }
    const row = await this.db
      .insertInto('hr_pay_terms')
      .values({
        tenant_id: this.tenantId,
        employee_id: employeeId,
        effective_from: input.effectiveFrom,
        basic: input.basic,
        allowances: input.allowances,
        insured: input.insured,
        insurable_wage: input.insurableWage,
        standard_hours: input.standardHours,
        overtime_rate: input.overtimeRate,
        pay_method: input.payMethod,
        created_by: toUserId(by),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTerms(row);
  }

  async updateTerms(
    id: string,
    expectedVersion: number,
    input: PayTermsInput,
  ): Promise<PayTerms | 'date_taken' | 'version_conflict'> {
    const current = await this.termsById(id);
    if (current === undefined) {
      return 'version_conflict';
    }
    if (await this.#dateTaken(current.employeeId, input.effectiveFrom, id)) {
      return 'date_taken';
    }
    const row = await this.db
      .updateTable('hr_pay_terms')
      .set({
        effective_from: input.effectiveFrom,
        basic: input.basic,
        allowances: input.allowances,
        insured: input.insured,
        insurable_wage: input.insurableWage,
        standard_hours: input.standardHours,
        overtime_rate: input.overtimeRate,
        pay_method: input.payMethod,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? 'version_conflict' : toTerms(row);
  }

  /** Runs keep their own copy, so terms may go. */
  async removeTerms(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('hr_pay_terms')
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  // -------------------------------------------------------------------------
  // What a run is made from
  // -------------------------------------------------------------------------

  /** Everybody employed for a day of the month, with the terms in force on its last day. */
  async candidates(periodStart: string, periodEnd: string): Promise<PayrollCandidate[]> {
    const employees = await this.db
      .selectFrom('hr_employees')
      .select(['id', 'user_id', 'full_name', 'hire_date', 'end_date'])
      .where('tenant_id', '=', this.tenantId)
      .where('hire_date', '<=', periodEnd)
      .where((eb) => eb.or([eb('end_date', 'is', null), eb('end_date', '>=', periodStart)]))
      .orderBy(sql`lower(full_name)`)
      .orderBy('id')
      .execute();
    if (employees.length === 0) {
      return [];
    }
    const terms = await this.db
      .selectFrom('hr_pay_terms')
      .selectAll()
      .distinctOn('employee_id')
      .where('tenant_id', '=', this.tenantId)
      .where(
        'employee_id',
        'in',
        employees.map((employee) => employee.id),
      )
      .where('effective_from', '<=', periodEnd)
      .orderBy('employee_id')
      .orderBy('effective_from', 'desc')
      .execute();
    const byEmployee = new Map(terms.map((row) => [row.employee_id, toTerms(row)]));
    return employees.map((employee) => ({
      employeeId: employee.id,
      userId: employee.user_id === null ? null : toUserId(employee.user_id),
      fullName: employee.full_name,
      hireDate: toDayString(employee.hire_date) ?? '',
      endDate: toDayString(employee.end_date),
      terms: byEmployee.get(employee.id) ?? null,
    }));
  }

  /**
   * Hours clocked by each member on shifts that started in the month, in the
   * company's time zone; a shift still open counts nothing.
   */
  async clockedHours(
    periodStart: string,
    periodEnd: string,
    userIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (userIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('shifts')
      .select([
        'user_id',
        sql<string>`round(sum(extract(epoch from (ended_at - started_at))) / 3600, 2)::text`.as(
          'hours',
        ),
      ])
      .where('tenant_id', '=', this.tenantId)
      .where('ended_at', 'is not', null)
      .where(
        'user_id',
        'in',
        userIds.map((id) => toUserId(id)),
      )
      .where(
        sql<boolean>`(started_at at time zone erp_ledger_timezone(${this.tenantId}::uuid))::date
          between ${periodStart}::date and ${periodEnd}::date`,
      )
      .groupBy('user_id')
      .execute();
    return new Map(rows.map((row) => [row.user_id, trimDecimal(row.hours)]));
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  /** Latest month first. */
  async runs(query: { before?: string | undefined; limit: number }): Promise<{
    items: (PayRun & { totals: PayRunTotals })[];
    next?: string;
  }> {
    let select = this.db
      .selectFrom('hr_payroll_runs')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (query.before !== undefined) {
      select = select.where('period_start', '<', query.before);
    }
    const rows = await select
      .orderBy('period_start', 'desc')
      .limit(query.limit + 1)
      .execute();
    const runs = rows.slice(0, query.limit).map(toRun);
    const totals = await this.totals(runs.map((run) => run.id));
    const last = runs.at(-1);
    return {
      items: runs.map((run) => ({ ...run, totals: totals.get(run.id) ?? emptyTotals() })),
      ...(rows.length > query.limit && last !== undefined ? { next: last.periodStart } : {}),
    };
  }

  async totals(runIds: readonly string[]): Promise<Map<string, PayRunTotals>> {
    if (runIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('hr_payroll_lines')
      .select([
        'run_id',
        sql<number>`count(*)::int`.as('employees'),
        sql<string>`sum(gross)::text`.as('gross'),
        sql<string>`sum(si_employee)::text`.as('si_employee'),
        sql<string>`sum(si_employer)::text`.as('si_employer'),
        sql<string>`sum(income_tax)::text`.as('income_tax'),
        sql<string>`sum(martyrs_fund)::text`.as('martyrs_fund'),
        sql<string>`sum(reimbursements)::text`.as('reimbursements'),
        sql<string>`sum(net)::text`.as('net'),
      ])
      .where('tenant_id', '=', this.tenantId)
      .where('run_id', 'in', [...new Set(runIds)])
      .groupBy('run_id')
      .execute();
    return new Map(
      rows.map((row) => [
        row.run_id,
        {
          employees: row.employees,
          gross: decimal(row.gross),
          socialInsuranceEmployee: decimal(row.si_employee),
          socialInsuranceEmployer: decimal(row.si_employer),
          incomeTax: decimal(row.income_tax),
          martyrsFund: decimal(row.martyrs_fund),
          reimbursements: decimal(row.reimbursements),
          net: decimal(row.net),
        },
      ]),
    );
  }

  async run(id: string): Promise<PayRun | undefined> {
    const row = await this.db
      .selectFrom('hr_payroll_runs')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRun(row);
  }

  /** The run of the month starting on this day, if there is one. */
  async runFor(periodStart: string): Promise<PayRun | undefined> {
    const row = await this.db
      .selectFrom('hr_payroll_runs')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('period_start', '=', periodStart)
      .executeTakeFirst();
    return row === undefined ? undefined : toRun(row);
  }

  async lockRun(id: string): Promise<PayRun | undefined> {
    const row = await this.db
      .selectFrom('hr_payroll_runs')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : toRun(row);
  }

  async createRun(
    input: { periodStart: string; periodEnd: string; ruleSetId: string; currency: string },
    by: UserId | string,
  ): Promise<PayRun | 'month_taken'> {
    const taken = await this.db
      .selectFrom('hr_payroll_runs')
      .select('id')
      .where('tenant_id', '=', this.tenantId)
      .where('period_start', '=', input.periodStart)
      .executeTakeFirst();
    if (taken !== undefined) {
      return 'month_taken';
    }
    const row = await this.db
      .insertInto('hr_payroll_runs')
      .values({
        tenant_id: this.tenantId,
        period_start: input.periodStart,
        period_end: input.periodEnd,
        rule_set_id: input.ruleSetId,
        currency: input.currency,
        prepared_by: toUserId(by),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRun(row);
  }

  /** A draft's run-level details; whoever changes it prepared it. */
  async touchRun(
    id: string,
    expectedVersion: number,
    by: UserId | string,
    input: { ruleSetId?: string; payDate?: string | null; note?: string | null } = {},
  ): Promise<PayRun | undefined> {
    const row = await this.db
      .updateTable('hr_payroll_runs')
      .set({
        ...(input.ruleSetId === undefined ? {} : { rule_set_id: input.ruleSetId }),
        ...(input.payDate === undefined ? {} : { pay_date: input.payDate }),
        ...(input.note === undefined ? {} : { note: input.note }),
        prepared_by: toUserId(by),
        prepared_at: sql<Date>`now()`,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toRun(row);
  }

  async approveRun(
    id: string,
    expectedVersion: number,
    by: UserId | string,
  ): Promise<PayRun | undefined> {
    const row = await this.db
      .updateTable('hr_payroll_runs')
      .set({
        status: 'approved',
        approved_by: toUserId(by),
        approved_at: sql<Date>`now()`,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toRun(row);
  }

  /** A draft only; its lines go with it. */
  async discardRun(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('hr_payroll_runs')
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('status', '=', 'draft')
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  // -------------------------------------------------------------------------
  // Lines
  // -------------------------------------------------------------------------

  async lines(runId: string): Promise<PayLine[]> {
    const rows = await this.db
      .selectFrom('hr_payroll_lines as l')
      .innerJoin('hr_employees as e', (join) =>
        join.onRef('e.tenant_id', '=', 'l.tenant_id').onRef('e.id', '=', 'l.employee_id'),
      )
      .selectAll('l')
      .select('e.full_name')
      .where('l.tenant_id', '=', this.tenantId)
      .where('l.run_id', '=', runId)
      .orderBy(sql`lower(e.full_name)`)
      .orderBy('l.id')
      .execute();
    return rows.map(toLine);
  }

  async line(id: string): Promise<PayLine | undefined> {
    const row = await this.db
      .selectFrom('hr_payroll_lines as l')
      .innerJoin('hr_employees as e', (join) =>
        join.onRef('e.tenant_id', '=', 'l.tenant_id').onRef('e.id', '=', 'l.employee_id'),
      )
      .selectAll('l')
      .select('e.full_name')
      .where('l.tenant_id', '=', this.tenantId)
      .where('l.id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toLine(row);
  }

  /** An employee's lines in approved runs, latest first: their payslips. */
  async payslipsOf(employeeId: string, limit: number): Promise<{ run: PayRun; line: PayLine }[]> {
    const rows = await this.db
      .selectFrom('hr_payroll_lines as l')
      .innerJoin('hr_payroll_runs as r', (join) =>
        join.onRef('r.tenant_id', '=', 'l.tenant_id').onRef('r.id', '=', 'l.run_id'),
      )
      .innerJoin('hr_employees as e', (join) =>
        join.onRef('e.tenant_id', '=', 'l.tenant_id').onRef('e.id', '=', 'l.employee_id'),
      )
      .selectAll('l')
      .select(['e.full_name', 'r.period_start'])
      .where('l.tenant_id', '=', this.tenantId)
      .where('l.employee_id', '=', employeeId)
      .where('r.status', '=', 'approved')
      .orderBy('r.period_start', 'desc')
      .limit(limit)
      .execute();
    const runs = new Map(
      (await Promise.all([...new Set(rows.map((row) => row.run_id))].map((id) => this.run(id))))
        .filter((run): run is PayRun => run !== undefined)
        .map((run) => [run.id, run]),
    );
    return rows.flatMap((row) => {
      const run = runs.get(row.run_id);
      return run === undefined ? [] : [{ run, line: toLine(row) }];
    });
  }

  /** A draft's lines, all at once: recalculating replaces every one. */
  async replaceLines(
    runId: string,
    lines: (PayLineInputs & PayLineResults & { employeeId: string })[],
  ): Promise<void> {
    await this.db
      .deleteFrom('hr_payroll_lines')
      .where('tenant_id', '=', this.tenantId)
      .where('run_id', '=', runId)
      .execute();
    if (lines.length === 0) {
      return;
    }
    await this.db
      .insertInto('hr_payroll_lines')
      .values(
        lines.map((line) => ({
          tenant_id: this.tenantId,
          run_id: runId,
          employee_id: line.employeeId,
          ...lineColumns(line),
        })),
      )
      .execute();
  }

  async updateLine(
    id: string,
    expectedVersion: number,
    line: PayLineInputs & PayLineResults,
  ): Promise<PayLine | undefined> {
    const row = await this.db
      .updateTable('hr_payroll_lines')
      .set({ ...lineColumns(line), version: sql<number>`version + 1` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .returning('id')
      .executeTakeFirst();
    return row === undefined ? undefined : this.line(row.id);
  }
}

export function emptyTotals(): PayRunTotals {
  return {
    employees: 0,
    gross: '0',
    socialInsuranceEmployee: '0',
    socialInsuranceEmployer: '0',
    incomeTax: '0',
    martyrsFund: '0',
    reimbursements: '0',
    net: '0',
  };
}
