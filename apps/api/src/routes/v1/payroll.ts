import {
  calculatePay,
  daysOutsideEmployment,
  defaultOvertimeRate,
  EGYPT_2026_RULES,
  formatPayRunReference,
  fromUnits,
  holds,
  PAY_RUN_STATUSES,
  payMethodSchema,
  payMonth,
  type PayrollRules,
  payrollRulesSchema,
  type Principal,
  proposedOvertimeHours,
  toCsv,
  toUnits,
} from '@integr8/core';
import {
  type Employee,
  type PayLine,
  type PayLineInputs,
  type PayLineResults,
  type PayRun,
  type PayRunTotals,
  emptyPayRunTotals,
  type PayrollCandidate,
  type PayrollRuleSet,
  type PayTerms,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { hrKey, openField } from '../../hr/sealed-fields.js';
import { crmAudit as audit, versionConflict } from './crm-shared.js';
import { type People, peopleOf, personBody, personSchema } from './operations.js';
import { companyToday } from './sales-quotes.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * Egyptian payroll (seventh round; ADR-0010).
 *
 * Rule sets hold a year's tax bands, social insurance rates and limits and
 * the Martyrs' Fund rate from a month on; Integr8 offers the 2026 figures and
 * an owner confirms a set, saying who checked it, before any run uses it.
 * Pay terms are dated per employee. A month's run proposes each employee's
 * line — terms in force, overtime from clocked hours beyond the month's
 * standard, unpaid days outside employment, claims waiting for payroll — and
 * the person preparing it adds bonuses, deductions and unpaid leave.
 * Somebody else approves it; then it never changes, pays the claims it
 * carries and posts one journal. Payslips, the social insurance report and
 * the bank transfer list come from an approved run (the report from a draft
 * too, to check it). The figures must be checked by the company's accountant.
 */

const TAGS = ['payroll'];
const PAYROLL = 'payroll' as const;

/** Every screen and payslip carries it (ADR-0010). */
export const PAYROLL_DISCLAIMER =
  'Integr8 calculates pay from the rule set your company confirmed. The figures must be checked by your accountant; Integr8 files nothing with the Tax Authority or NOSI.';

const amountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,16}(\.\d{1,4})?$/u, 'Use digits with up to four decimal places, such as 1250.50');
const hoursSchema = z
  .string()
  .trim()
  .regex(/^\d{1,4}(\.\d{1,2})?$/u, 'Hours, such as 12.5');
const monthStart = z.iso.date().refine((day) => day.endsWith('-01'), 'The first of a month');
const versionBody = z.object({ expectedVersion: z.number().int().positive() });

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const ruleSetSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  effectiveFrom: z.iso.date(),
  rules: payrollRulesSchema,
  confirmed: z.object({ by: personSchema, at: z.iso.datetime(), note: z.string() }).nullable(),
  createdAt: z.iso.datetime(),
  version: z.number().int(),
  can: z.object({ edit: z.boolean(), confirm: z.boolean(), remove: z.boolean() }),
});

const payTermsSchema = z.object({
  id: z.uuid(),
  employeeId: z.uuid(),
  effectiveFrom: z.iso.date(),
  basic: z.string(),
  allowances: z.string(),
  insured: z.boolean(),
  insurableWage: z.string().nullable(),
  standardHours: z.string(),
  overtimeRate: z.string().nullable(),
  payMethod: payMethodSchema,
  version: z.number().int(),
});

const totalsSchema = z.object({
  employees: z.number().int(),
  gross: z.string(),
  socialInsuranceEmployee: z.string(),
  socialInsuranceEmployer: z.string(),
  incomeTax: z.string(),
  martyrsFund: z.string(),
  reimbursements: z.string(),
  net: z.string(),
});

const runSummarySchema = z.object({
  id: z.uuid(),
  reference: z.string(),
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  currency: z.string(),
  status: z.enum(PAY_RUN_STATUSES),
  payDate: z.iso.date().nullable(),
  note: z.string().nullable(),
  preparedBy: personSchema,
  preparedAt: z.iso.datetime(),
  approvedBy: personSchema.nullable(),
  approvedAt: z.iso.datetime().nullable(),
  totals: totalsSchema,
  version: z.number().int(),
});

const lineSchema = z.object({
  id: z.uuid(),
  employee: z.object({ id: z.uuid(), name: z.string() }),
  basic: z.string(),
  allowances: z.string(),
  clockedHours: z.string(),
  overtimeHours: z.string(),
  overtimeRate: z.string(),
  bonus: z.string(),
  deduction: z.string(),
  unpaidDays: z.string(),
  reimbursements: z.string(),
  declaredInsurableWage: z.string().nullable(),
  insured: z.boolean(),
  payMethod: payMethodSchema,
  note: z.string().nullable(),
  overtimePay: z.string(),
  unpaidLeave: z.string(),
  gross: z.string(),
  insurableWage: z.string(),
  socialInsuranceEmployee: z.string(),
  socialInsuranceEmployer: z.string(),
  taxable: z.string(),
  incomeTax: z.string(),
  martyrsFund: z.string(),
  net: z.string(),
  version: z.number().int(),
});

const runDetailSchema = runSummarySchema.extend({
  ruleSet: z.object({ id: z.uuid(), name: z.string(), effectiveFrom: z.iso.date() }),
  lines: z.array(lineSchema),
  /** Employed in the month but without pay terms in force, so not in the run. */
  withoutTerms: z.array(z.object({ id: z.uuid(), name: z.string() })),
  disclaimer: z.string(),
  can: z.object({
    edit: z.boolean(),
    approve: z.boolean(),
    discard: z.boolean(),
    exportBankFile: z.boolean(),
  }),
});

const payslipSchema = z.object({
  run: z.object({
    id: z.uuid(),
    reference: z.string(),
    periodStart: z.iso.date(),
    periodEnd: z.iso.date(),
    payDate: z.iso.date().nullable(),
    currency: z.string(),
  }),
  employee: z.object({
    id: z.uuid(),
    name: z.string(),
    employeeNumber: z.string().nullable(),
    jobTitle: z.string().nullable(),
    department: z.string().nullable(),
    hireDate: z.iso.date(),
  }),
  line: lineSchema,
  disclaimer: z.string(),
});

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function ruleSetBody(set: PayrollRuleSet, principal: Principal, people: People) {
  const unconfirmed = set.confirmedAt === null;
  return {
    id: set.id,
    name: set.name,
    effectiveFrom: set.effectiveFrom,
    rules: set.rules,
    confirmed:
      set.confirmedBy === null || set.confirmedAt === null
        ? null
        : {
            by: personBody(set.confirmedBy, people),
            at: iso(set.confirmedAt),
            note: set.confirmationNote ?? '',
          },
    createdAt: iso(set.createdAt),
    version: set.version,
    can: {
      edit: unconfirmed && holds(principal, 'payroll.run'),
      confirm: unconfirmed && principal.role === 'owner',
      // Only an unconfirmed set may go, and no run can use one.
      remove: unconfirmed && holds(principal, 'payroll.run'),
    },
  };
}

function termsBody(terms: PayTerms) {
  return {
    id: terms.id,
    employeeId: terms.employeeId,
    effectiveFrom: terms.effectiveFrom,
    basic: terms.basic,
    allowances: terms.allowances,
    insured: terms.insured,
    insurableWage: terms.insurableWage,
    standardHours: terms.standardHours,
    overtimeRate: terms.overtimeRate,
    payMethod: terms.payMethod,
    version: terms.version,
  };
}

function runSummaryBody(run: PayRun, totals: PayRunTotals, people: People) {
  return {
    id: run.id,
    reference: formatPayRunReference(run.periodStart),
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    currency: run.currency,
    status: run.status,
    payDate: run.payDate,
    note: run.note,
    preparedBy: personBody(run.preparedBy, people),
    preparedAt: iso(run.preparedAt),
    approvedBy: run.approvedBy === null ? null : personBody(run.approvedBy, people),
    approvedAt: isoOrNull(run.approvedAt),
    totals,
    version: run.version,
  };
}

function lineBody(line: PayLine) {
  return {
    id: line.id,
    employee: { id: line.employeeId, name: line.employeeName },
    basic: line.basic,
    allowances: line.allowances,
    clockedHours: line.clockedHours,
    overtimeHours: line.overtimeHours,
    overtimeRate: line.overtimeRate,
    bonus: line.bonus,
    deduction: line.deduction,
    unpaidDays: line.unpaidDays,
    reimbursements: line.reimbursements,
    declaredInsurableWage: line.declaredInsurableWage,
    insured: line.insured,
    payMethod: line.payMethod,
    note: line.note,
    overtimePay: line.overtimePay,
    unpaidLeave: line.unpaidLeave,
    gross: line.gross,
    insurableWage: line.insurableWage,
    socialInsuranceEmployee: line.socialInsuranceEmployee,
    socialInsuranceEmployer: line.socialInsuranceEmployer,
    taxable: line.taxable,
    incomeTax: line.incomeTax,
    martyrsFund: line.martyrsFund,
    net: line.net,
    version: line.version,
  };
}

// ---------------------------------------------------------------------------
// The calculation
// ---------------------------------------------------------------------------

/** What the calculation makes of a line's inputs, under a rule set. */
export function calculateLine(inputs: PayLineInputs, rules: PayrollRules): PayLineResults {
  const pay = calculatePay(
    {
      basic: inputs.basic,
      allowances: inputs.allowances,
      overtimeHours: inputs.overtimeHours,
      overtimeRate: inputs.overtimeRate,
      bonus: inputs.bonus,
      deduction: inputs.deduction,
      unpaidDays: inputs.unpaidDays,
      reimbursements: inputs.reimbursements,
      insurableWage: inputs.declaredInsurableWage,
      insured: inputs.insured,
    },
    rules,
  );
  return {
    overtimePay: pay.overtimePay,
    unpaidLeave: pay.unpaidLeave,
    gross: pay.gross,
    insurableWage: pay.insurableWage,
    socialInsuranceEmployee: pay.socialInsuranceEmployee,
    socialInsuranceEmployer: pay.socialInsuranceEmployer,
    taxable: pay.taxable,
    incomeTax: pay.incomeTax,
    martyrsFund: pay.martyrsFund,
    net: pay.net,
  };
}

const sum = (values: readonly string[]) =>
  fromUnits(values.reduce((total, value) => total + toUnits(value), 0n));

/** Claims waiting for payroll, by the member who claimed them. */
async function waitingClaims(tx: TenantTransaction, userIds: readonly string[]) {
  const claims = await tx.hrExpenses.awaitingPayroll(userIds);
  const byUser = new Map<string, typeof claims>();
  for (const claim of claims) {
    byUser.set(claim.claimantId, [...(byUser.get(claim.claimantId) ?? []), claim]);
  }
  return byUser;
}

/**
 * Every employee's line for the month, proposed afresh from terms, clocked
 * hours and waiting claims. What the preparer typed for the run — overtime
 * hours, bonus, deduction, unpaid days, a note — is kept for anyone already
 * in it.
 */
async function proposeLines(
  tx: TenantTransaction,
  run: PayRun,
  rules: PayrollRules,
  kept: readonly PayLine[] = [],
): Promise<{
  lines: (PayLineInputs & PayLineResults & { employeeId: string })[];
  withoutTerms: PayrollCandidate[];
}> {
  const candidates = await tx.hrPayroll.candidates(run.periodStart, run.periodEnd);
  const userIds = candidates.flatMap((candidate) =>
    candidate.userId === null ? [] : [candidate.userId],
  );
  const [hours, claims] = await Promise.all([
    tx.hrPayroll.clockedHours(run.periodStart, run.periodEnd, userIds),
    waitingClaims(tx, userIds),
  ]);
  const previous = new Map(kept.map((line) => [line.employeeId, line]));
  const lines: (PayLineInputs & PayLineResults & { employeeId: string })[] = [];
  const withoutTerms: PayrollCandidate[] = [];
  for (const candidate of candidates) {
    const terms = candidate.terms;
    if (terms === null) {
      withoutTerms.push(candidate);
      continue;
    }
    const before = previous.get(candidate.employeeId);
    const clocked = candidate.userId === null ? '0' : (hours.get(candidate.userId) ?? '0');
    const inputs: PayLineInputs = {
      basic: terms.basic,
      allowances: terms.allowances,
      clockedHours: clocked,
      overtimeHours: before?.overtimeHours ?? proposedOvertimeHours(clocked, terms.standardHours),
      overtimeRate: terms.overtimeRate ?? defaultOvertimeRate(terms.basic, terms.standardHours),
      bonus: before?.bonus ?? '0',
      deduction: before?.deduction ?? '0',
      unpaidDays:
        before?.unpaidDays ??
        String(
          daysOutsideEmployment(
            run.periodStart,
            run.periodEnd,
            candidate.hireDate,
            candidate.endDate,
          ),
        ),
      reimbursements:
        candidate.userId === null
          ? '0'
          : sum((claims.get(candidate.userId) ?? []).map((claim) => claim.amount)),
      declaredInsurableWage: terms.insurableWage,
      insured: terms.insured,
      payMethod: terms.payMethod,
      note: before?.note ?? null,
    };
    lines.push({ employeeId: candidate.employeeId, ...inputs, ...calculateLine(inputs, rules) });
  }
  return { lines, withoutTerms };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function readRun(tx: TenantTransaction, runId: string, lock = false): Promise<PayRun> {
  const run = lock ? await tx.hrPayroll.lockRun(runId) : await tx.hrPayroll.run(runId);
  if (run === undefined) {
    throw notFound('No such pay run.');
  }
  return run;
}

async function ruleSetOf(tx: TenantTransaction, run: PayRun): Promise<PayrollRuleSet> {
  const set = await tx.hrPayroll.ruleSet(run.ruleSetId);
  if (set === undefined) {
    throw notFound('No such rule set.');
  }
  return set;
}

async function runDetail(
  tx: TenantTransaction,
  principal: Principal,
  run: PayRun,
  context: RequestContext,
) {
  const [people, lines, totals, set] = await Promise.all([
    peopleOf(tx),
    tx.hrPayroll.lines(run.id),
    tx.hrPayroll.totals([run.id]),
    ruleSetOf(tx, run),
  ]);
  const withoutTerms =
    run.status === 'draft'
      ? (await tx.hrPayroll.candidates(run.periodStart, run.periodEnd))
          .filter((candidate) => candidate.terms === null)
          .map((candidate) => ({ id: candidate.employeeId, name: candidate.fullName }))
      : [];
  const draft = run.status === 'draft';
  return {
    ...runSummaryBody(run, totals.get(run.id) ?? emptyPayRunTotals(), people),
    ruleSet: { id: set.id, name: set.name, effectiveFrom: set.effectiveFrom },
    lines: lines.map(lineBody),
    withoutTerms,
    disclaimer: PAYROLL_DISCLAIMER,
    can: {
      edit: draft && holds(principal, 'payroll.run'),
      approve:
        draft &&
        holds(principal, 'payroll.approve') &&
        run.preparedBy !== principal.userId &&
        lines.length > 0,
      discard: draft && holds(principal, 'payroll.run'),
      exportBankFile:
        !draft && holds(principal, 'hr.sensitive') && context.config.HR_DATA_KEY !== undefined,
    },
  };
}

function keyOrRefuse(context: RequestContext): Buffer {
  const value = context.config.HR_DATA_KEY;
  if (value === undefined) {
    throw new ApiError(
      503,
      'hr_key_missing',
      'Bank and insurance numbers cannot be read until HR_DATA_KEY is set on the server.',
    );
  }
  return hrKey(value);
}

// ---------------------------------------------------------------------------
// Rule sets
// ---------------------------------------------------------------------------

const ruleSetParams = z.object({ ruleSetId: z.uuid() });

export const listRuleSetsRoute = defineRoute({
  method: 'get',
  path: '/v1/payroll/rule-sets',
  operationId: 'listPayrollRuleSets',
  summary: 'Payroll rule sets, latest first, and the figures Integr8 offers',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.run',
  feature: PAYROLL,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The rule sets.',
      schema: z.object({
        items: z.array(ruleSetSchema),
        /** The 2026 figures, from payroll firms' guides; to be checked before use. */
        seed: z.object({
          name: z.string(),
          effectiveFrom: z.iso.date(),
          rules: payrollRulesSchema,
        }),
        disclaimer: z.string(),
      }),
    },
  },
  handler: async (_request, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const [sets, people] = await Promise.all([tx.hrPayroll.ruleSets(), peopleOf(tx)]);
      return {
        items: sets.map((set) => ruleSetBody(set, principal, people)),
        seed: { name: 'Egypt 2026', effectiveFrom: '2026-01-01', rules: EGYPT_2026_RULES },
        disclaimer: PAYROLL_DISCLAIMER,
      };
    });
    return { status: 200, body };
  },
});

export const createRuleSetRoute = defineRoute({
  method: 'post',
  path: '/v1/payroll/rule-sets',
  operationId: 'createPayrollRuleSet',
  summary: 'Add a rule set from a month on',
  description:
    'The 2026 figures when `rules` is left out. An owner confirms it before any run uses it. 409 `month_taken` when a set already starts that month.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.run',
  feature: PAYROLL,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    name: z.string().trim().min(1).max(200),
    effectiveFrom: monthStart,
    rules: payrollRulesSchema.optional(),
  }),
  responses: {
    201: { description: 'The rule set.', schema: ruleSetSchema },
    409: { description: 'A set already starts that month.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const created = await withTenant(principal.tenantId, async (tx) => {
      const set = await tx.hrPayroll.createRuleSet(
        {
          name: body.name,
          effectiveFrom: body.effectiveFrom,
          rules: body.rules ?? EGYPT_2026_RULES,
        },
        principal.userId,
      );
      if (set === 'month_taken') {
        throw conflict('month_taken', 'A rule set already starts that month.');
      }
      await audit(tx, context, 'payroll.rule_set_created', 'payroll_rule_set', set.id, {
        effectiveFrom: set.effectiveFrom,
      });
      return ruleSetBody(set, principal, await peopleOf(tx));
    });
    return { status: 201, body: created };
  },
});

async function unconfirmedSet(tx: TenantTransaction, id: string): Promise<PayrollRuleSet> {
  const set = await tx.hrPayroll.ruleSet(id);
  if (set === undefined) {
    throw notFound('No such rule set.');
  }
  if (set.confirmedAt !== null) {
    throw conflict(
      'confirmed',
      'A confirmed rule set does not change; add a new one from a later month.',
    );
  }
  return set;
}

export const updateRuleSetRoute = defineRoute({
  method: 'patch',
  path: '/v1/payroll/rule-sets/:ruleSetId',
  operationId: 'updatePayrollRuleSet',
  summary: 'Change a rule set before it is confirmed',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.run',
  feature: PAYROLL,
  params: ruleSetParams,
  query: noSchema,
  body: versionBody.extend({
    name: z.string().trim().min(1).max(200).optional(),
    effectiveFrom: monthStart.optional(),
    rules: payrollRulesSchema.optional(),
  }),
  responses: {
    200: { description: 'The rule set.', schema: ruleSetSchema },
    404: { description: 'No such rule set.' },
    409: { description: 'Confirmed already, the month is taken, or changed elsewhere.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const updated = await withTenant(principal.tenantId, async (tx) => {
      await unconfirmedSet(tx, params.ruleSetId);
      const set = await tx.hrPayroll.updateRuleSet(params.ruleSetId, body.expectedVersion, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.effectiveFrom === undefined ? {} : { effectiveFrom: body.effectiveFrom }),
        ...(body.rules === undefined ? {} : { rules: body.rules }),
      });
      if (set === 'month_taken') {
        throw conflict('month_taken', 'A rule set already starts that month.');
      }
      if (set === 'version_conflict') {
        throw versionConflict();
      }
      await audit(tx, context, 'payroll.rule_set_updated', 'payroll_rule_set', set.id);
      return ruleSetBody(set, principal, await peopleOf(tx));
    });
    return { status: 200, body: updated };
  },
});

export const confirmRuleSetRoute = defineRoute({
  method: 'post',
  path: '/v1/payroll/rule-sets/:ruleSetId/confirm',
  operationId: 'confirmPayrollRuleSet',
  summary: 'Confirm a rule set, saying who checked it',
  description:
    'The owner only (403 `owner_only`). A confirmed set never changes again, and runs from its month on may use it.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.approve',
  feature: PAYROLL,
  params: ruleSetParams,
  query: noSchema,
  body: versionBody.extend({ note: z.string().trim().min(1).max(1000) }),
  responses: {
    200: { description: 'The rule set.', schema: ruleSetSchema },
    403: { description: 'Only the owner confirms.' },
    404: { description: 'No such rule set.' },
    409: { description: 'Confirmed already, or changed elsewhere.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    if (principal.role !== 'owner') {
      throw new ApiError(403, 'owner_only', 'Only the owner confirms the figures payroll uses.');
    }
    const confirmed = await withTenant(principal.tenantId, async (tx) => {
      await unconfirmedSet(tx, params.ruleSetId);
      const set = await tx.hrPayroll.confirmRuleSet(
        params.ruleSetId,
        body.expectedVersion,
        principal.userId,
        body.note,
      );
      if (set === undefined) {
        throw versionConflict();
      }
      await audit(tx, context, 'payroll.rule_set_confirmed', 'payroll_rule_set', set.id, {
        note: body.note,
      });
      return ruleSetBody(set, principal, await peopleOf(tx));
    });
    return { status: 200, body: confirmed };
  },
});

export const removeRuleSetRoute = defineRoute({
  method: 'delete',
  path: '/v1/payroll/rule-sets/:ruleSetId',
  operationId: 'removePayrollRuleSet',
  summary: 'Remove a rule set nobody confirmed',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.run',
  feature: PAYROLL,
  params: ruleSetParams,
  query: noSchema,
  body: noSchema,
  responses: {
    204: { description: 'Removed.' },
    404: { description: 'No such rule set.' },
    409: { description: 'Confirmed: it stays.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    await withTenant(principal.tenantId, async (tx) => {
      await unconfirmedSet(tx, params.ruleSetId);
      await tx.hrPayroll.removeRuleSet(params.ruleSetId);
      await audit(tx, context, 'payroll.rule_set_removed', 'payroll_rule_set', params.ruleSetId);
    });
    return { status: 204, body: undefined };
  },
});

// ---------------------------------------------------------------------------
// Pay terms
// ---------------------------------------------------------------------------

const termsBodySchema = z.object({
  effectiveFrom: z.iso.date(),
  basic: amountSchema,
  allowances: amountSchema.default('0'),
  insured: z.boolean().default(true),
  insurableWage: amountSchema.nullable().default(null),
  standardHours: hoursSchema.default('208'),
  overtimeRate: amountSchema.nullable().default(null),
  payMethod: payMethodSchema.default('bank_transfer'),
});

async function employeeOrMissing(tx: TenantTransaction, id: string): Promise<Employee> {
  const employee = await tx.hrEmployees.find(id);
  if (employee === undefined) {
    throw notFound('No such employee.');
  }
  return employee;
}

export const listPayTermsRoute = defineRoute({
  method: 'get',
  path: '/v1/hr/employees/:employeeId/pay-terms',
  operationId: 'listPayTerms',
  summary: 'An employee’s pay terms, latest first',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.run',
  feature: PAYROLL,
  params: z.object({ employeeId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The terms.', schema: z.object({ items: z.array(payTermsSchema) }) },
    404: { description: 'No such employee.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      await employeeOrMissing(tx, params.employeeId);
      return { items: (await tx.hrPayroll.terms(params.employeeId)).map(termsBody) };
    });
    return { status: 200, body };
  },
});

export const addPayTermsRoute = defineRoute({
  method: 'post',
  path: '/v1/hr/employees/:employeeId/pay-terms',
  operationId: 'addPayTerms',
  summary: 'Set an employee’s pay from a date on',
  description:
    'Overtime is paid at 135% of the hourly basic (basic over the standard hours) when no rate is given. 409 `date_taken` when terms already start that day.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.run',
  feature: PAYROLL,
  idempotent: true,
  params: z.object({ employeeId: z.uuid() }),
  query: noSchema,
  body: termsBodySchema,
  responses: {
    201: { description: 'The terms.', schema: payTermsSchema },
    404: { description: 'No such employee.' },
    409: { description: 'Terms already start that day.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const created = await withTenant(principal.tenantId, async (tx) => {
      await employeeOrMissing(tx, params.employeeId);
      const terms = await tx.hrPayroll.addTerms(params.employeeId, body, principal.userId);
      if (terms === 'date_taken') {
        throw conflict('date_taken', 'Terms already start that day; change those instead.');
      }
      await audit(tx, context, 'payroll.terms_added', 'hr_employee', params.employeeId, {
        effectiveFrom: terms.effectiveFrom,
      });
      return termsBody(terms);
    });
    return { status: 201, body: created };
  },
});

const termsParams = z.object({ termsId: z.uuid() });

export const updatePayTermsRoute = defineRoute({
  method: 'patch',
  path: '/v1/payroll/pay-terms/:termsId',
  operationId: 'updatePayTerms',
  summary: 'Correct pay terms',
  description: 'Runs already made keep the figures they used.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.run',
  feature: PAYROLL,
  params: termsParams,
  query: noSchema,
  body: termsBodySchema.extend(versionBody.shape),
  responses: {
    200: { description: 'The terms.', schema: payTermsSchema },
    404: { description: 'No such terms.' },
    409: { description: 'Terms already start that day, or changed elsewhere.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const updated = await withTenant(principal.tenantId, async (tx) => {
      const current = await tx.hrPayroll.termsById(params.termsId);
      if (current === undefined) {
        throw notFound('No such pay terms.');
      }
      const { expectedVersion, ...input } = body;
      const terms = await tx.hrPayroll.updateTerms(params.termsId, expectedVersion, input);
      if (terms === 'date_taken') {
        throw conflict('date_taken', 'Terms already start that day; change those instead.');
      }
      if (terms === 'version_conflict') {
        throw versionConflict();
      }
      await audit(tx, context, 'payroll.terms_updated', 'hr_employee', terms.employeeId, {
        effectiveFrom: terms.effectiveFrom,
      });
      return termsBody(terms);
    });
    return { status: 200, body: updated };
  },
});

export const removePayTermsRoute = defineRoute({
  method: 'delete',
  path: '/v1/payroll/pay-terms/:termsId',
  operationId: 'removePayTerms',
  summary: 'Remove pay terms entered by mistake',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.run',
  feature: PAYROLL,
  params: termsParams,
  query: noSchema,
  body: noSchema,
  responses: { 204: { description: 'Removed.' }, 404: { description: 'No such terms.' } },
  handler: async ({ params }, context) => {
    const { principal } = context;
    await withTenant(principal.tenantId, async (tx) => {
      const current = await tx.hrPayroll.termsById(params.termsId);
      if (current === undefined) {
        throw notFound('No such pay terms.');
      }
      await tx.hrPayroll.removeTerms(params.termsId);
      await audit(tx, context, 'payroll.terms_removed', 'hr_employee', current.employeeId, {
        effectiveFrom: current.effectiveFrom,
      });
    });
    return { status: 204, body: undefined };
  },
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

const runParams = z.object({ runId: z.uuid() });

export const listPayRunsRoute = defineRoute({
  method: 'get',
  path: '/v1/payroll/runs',
  operationId: 'listPayRuns',
  summary: 'Pay runs, latest month first',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.run',
  feature: PAYROLL,
  params: noSchema,
  query: z.object({
    before: monthStart.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(24),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page.',
      schema: z.object({
        items: z.array(runSummarySchema),
        next: z.iso.date().nullable(),
        disclaimer: z.string(),
      }),
    },
  },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const [page, people] = await Promise.all([
        tx.hrPayroll.runs({ before: query.before, limit: query.limit }),
        peopleOf(tx),
      ]);
      return {
        items: page.items.map((run) => runSummaryBody(run, run.totals, people)),
        next: page.next ?? null,
        disclaimer: PAYROLL_DISCLAIMER,
      };
    });
    return { status: 200, body };
  },
});

export const createPayRunRoute = defineRoute({
  method: 'post',
  path: '/v1/payroll/runs',
  operationId: 'createPayRun',
  summary: 'Prepare a month’s pay run',
  description:
    'Proposes a line for everyone employed in the month who has pay terms. Needs a confirmed rule set in force (422 `no_confirmed_rules`, or `rules_not_confirmed` when the latest set waits for the owner). No later than next month (422 `month_in_future`); one run a month (409 `month_taken`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.run',
  feature: PAYROLL,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u, 'A month, such as 2026-10'),
  }),
  responses: {
    201: { description: 'The draft.', schema: runDetailSchema },
    409: { description: 'The month has a run.' },
    422: { description: 'No confirmed rule set in force, or too far ahead.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const { start, end } = payMonth(`${body.month}-01`);
      if (start > addMonth(await companyToday(tx))) {
        throw unprocessable(
          'month_in_future',
          'A run is prepared no earlier than the month before.',
        );
      }
      const { confirmed, latest } = await tx.hrPayroll.ruleSetFor(start);
      if (confirmed === undefined) {
        throw unprocessable(
          latest === undefined ? 'no_confirmed_rules' : 'rules_not_confirmed',
          latest === undefined
            ? 'Add a payroll rule set in force for this month, and have the owner confirm it.'
            : 'The owner confirms the rule set before payroll can use it.',
        );
      }
      const currency = (await tx.settings.get()).currency;
      const run = await tx.hrPayroll.createRun(
        { periodStart: start, periodEnd: end, ruleSetId: confirmed.id, currency },
        principal.userId,
      );
      if (run === 'month_taken') {
        throw conflict('month_taken', 'This month already has a pay run.');
      }
      const { lines } = await proposeLines(tx, run, confirmed.rules);
      await tx.hrPayroll.replaceLines(run.id, lines);
      await audit(tx, context, 'payroll.run_prepared', 'payroll_run', run.id, {
        month: body.month,
      });
      return runDetail(tx, principal, run, context);
    });
    return { status: 201, body: detail };
  },
});

/** The first of next month: a run may be prepared a month ahead, no further. */
function addMonth(today: string): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return `${String(next.year)}-${String(next.month).padStart(2, '0')}-01`;
}

export const getPayRunRoute = defineRoute({
  method: 'get',
  path: '/v1/payroll/runs/:runId',
  operationId: 'getPayRun',
  summary: 'A pay run with its lines',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.run',
  feature: PAYROLL,
  params: runParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The run.', schema: runDetailSchema },
    404: { description: 'No such run.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) =>
      runDetail(tx, principal, await readRun(tx, params.runId), context),
    );
    return { status: 200, body: detail };
  },
});

async function draftOrRefuse(tx: TenantTransaction, runId: string): Promise<PayRun> {
  const run = await readRun(tx, runId, true);
  if (run.status !== 'draft') {
    throw conflict('run_approved', 'An approved pay run does not change; correct it next month.');
  }
  return run;
}

export const updatePayRunRoute = defineRoute({
  method: 'patch',
  path: '/v1/payroll/runs/:runId',
  operationId: 'updatePayRun',
  summary: 'Set a draft’s pay date or note',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.run',
  feature: PAYROLL,
  params: runParams,
  query: noSchema,
  body: versionBody.extend({
    payDate: z.iso.date().nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  }),
  responses: {
    200: { description: 'The run.', schema: runDetailSchema },
    404: { description: 'No such run.' },
    409: { description: 'Approved, or changed elsewhere.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      await draftOrRefuse(tx, params.runId);
      const run = await tx.hrPayroll.touchRun(
        params.runId,
        body.expectedVersion,
        principal.userId,
        {
          ...(body.payDate === undefined ? {} : { payDate: body.payDate }),
          ...(body.note === undefined ? {} : { note: body.note === '' ? null : body.note }),
        },
      );
      if (run === undefined) {
        throw versionConflict();
      }
      return runDetail(tx, principal, run, context);
    });
    return { status: 200, body: detail };
  },
});

export const recalculatePayRunRoute = defineRoute({
  method: 'post',
  path: '/v1/payroll/runs/:runId/recalculate',
  operationId: 'recalculatePayRun',
  summary: 'Recalculate a draft from today’s terms, hours and claims',
  description:
    'Keeps what was typed for the run (overtime hours, bonus, deduction, unpaid days, note) for anyone already in it, and uses the confirmed rule set now in force for the month.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.run',
  feature: PAYROLL,
  params: runParams,
  query: noSchema,
  body: versionBody,
  responses: {
    200: { description: 'The run.', schema: runDetailSchema },
    404: { description: 'No such run.' },
    409: { description: 'Approved, or changed elsewhere.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const current = await draftOrRefuse(tx, params.runId);
      const { confirmed } = await tx.hrPayroll.ruleSetFor(current.periodStart);
      const set = confirmed ?? (await ruleSetOf(tx, current));
      const run = await tx.hrPayroll.touchRun(
        params.runId,
        body.expectedVersion,
        principal.userId,
        {
          ruleSetId: set.id,
        },
      );
      if (run === undefined) {
        throw versionConflict();
      }
      const { lines } = await proposeLines(tx, run, set.rules, await tx.hrPayroll.lines(run.id));
      await tx.hrPayroll.replaceLines(run.id, lines);
      await audit(tx, context, 'payroll.run_recalculated', 'payroll_run', run.id);
      return runDetail(tx, principal, run, context);
    });
    return { status: 200, body: detail };
  },
});

export const updatePayLineRoute = defineRoute({
  method: 'patch',
  path: '/v1/payroll/runs/:runId/lines/:lineId',
  operationId: 'updatePayLine',
  summary: 'Type a line’s overtime, bonus, deduction or unpaid days',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.run',
  feature: PAYROLL,
  params: z.object({ runId: z.uuid(), lineId: z.uuid() }),
  query: noSchema,
  body: z.object({
    expectedRunVersion: z.number().int().positive(),
    expectedVersion: z.number().int().positive(),
    overtimeHours: hoursSchema.optional(),
    bonus: amountSchema.optional(),
    deduction: amountSchema.optional(),
    unpaidDays: z
      .string()
      .trim()
      .regex(/^\d{1,2}(\.\d{1,2})?$/u)
      .refine((value) => Number(value) <= 30, 'At most 30 days')
      .optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  }),
  responses: {
    200: { description: 'The run.', schema: runDetailSchema },
    404: { description: 'No such run or line.' },
    409: { description: 'Approved, or changed elsewhere.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const current = await draftOrRefuse(tx, params.runId);
      const line = await tx.hrPayroll.line(params.lineId);
      if (line?.runId !== current.id) {
        throw notFound('No such line in this run.');
      }
      const run = await tx.hrPayroll.touchRun(
        current.id,
        body.expectedRunVersion,
        principal.userId,
      );
      if (run === undefined) {
        throw versionConflict();
      }
      const inputs: PayLineInputs = {
        basic: line.basic,
        allowances: line.allowances,
        clockedHours: line.clockedHours,
        overtimeHours: body.overtimeHours ?? line.overtimeHours,
        overtimeRate: line.overtimeRate,
        bonus: body.bonus ?? line.bonus,
        deduction: body.deduction ?? line.deduction,
        unpaidDays: body.unpaidDays ?? line.unpaidDays,
        reimbursements: line.reimbursements,
        declaredInsurableWage: line.declaredInsurableWage,
        insured: line.insured,
        payMethod: line.payMethod,
        note: body.note === undefined ? line.note : body.note === '' ? null : body.note,
      };
      const set = await ruleSetOf(tx, run);
      const updated = await tx.hrPayroll.updateLine(line.id, body.expectedVersion, {
        ...inputs,
        ...calculateLine(inputs, set.rules),
      });
      if (updated === undefined) {
        throw versionConflict();
      }
      return runDetail(tx, principal, run, context);
    });
    return { status: 200, body: detail };
  },
});

export const approvePayRunRoute = defineRoute({
  method: 'post',
  path: '/v1/payroll/runs/:runId/approve',
  operationId: 'approvePayRun',
  summary: 'Approve a pay run somebody else prepared',
  description:
    'Final: the run never changes after, pays the expense claims it carries and posts to the ledger when it is set up. Refused for whoever last prepared it (409 `self_approval`), an empty run (409 `empty_run`), a line paying less than nothing (409 `negative_net`), and when claims waiting for payroll changed since it was calculated (409 `run_out_of_date`: recalculate).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.approve',
  feature: PAYROLL,
  params: runParams,
  query: noSchema,
  body: versionBody,
  responses: {
    200: { description: 'The run.', schema: runDetailSchema },
    404: { description: 'No such run.' },
    409: { description: 'Not approvable now.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const run = await draftOrRefuse(tx, params.runId);
      if (run.version !== body.expectedVersion) {
        throw versionConflict();
      }
      if (run.preparedBy === principal.userId) {
        throw conflict(
          'self_approval',
          'Somebody other than whoever prepared the run approves it.',
        );
      }
      const lines = await tx.hrPayroll.lines(run.id);
      if (lines.length === 0) {
        throw conflict('empty_run', 'Nobody is paid in this run.');
      }
      if (lines.some((line) => toUnits(line.net) < 0n)) {
        throw conflict(
          'negative_net',
          'A line pays less than nothing; reduce its deductions or carry them to next month.',
        );
      }
      // The claims each line pays back are the ones still waiting now.
      const employees = await tx.hrEmployees.findMany(lines.map((line) => line.employeeId));
      const userOf = new Map(employees.map((employee) => [employee.id, employee.userId]));
      const userIds = employees.flatMap((employee) =>
        employee.userId === null ? [] : [employee.userId],
      );
      const claims = await waitingClaims(tx, userIds);
      const paying: string[] = [];
      for (const line of lines) {
        const userId = userOf.get(line.employeeId) ?? null;
        const waiting = userId === null ? [] : (claims.get(userId) ?? []);
        if (toUnits(sum(waiting.map((claim) => claim.amount))) !== toUnits(line.reimbursements)) {
          throw conflict(
            'run_out_of_date',
            'Expense claims changed since this run was calculated. Recalculate it, check it, then approve.',
          );
        }
        paying.push(...waiting.map((claim) => claim.id));
      }
      const approved = await tx.hrPayroll.approveRun(
        run.id,
        body.expectedVersion,
        principal.userId,
      );
      if (approved === undefined) {
        throw versionConflict();
      }
      await tx.hrExpenses.paidThroughPayroll(paying, approved.id);
      await audit(tx, context, 'payroll.run_approved', 'payroll_run', approved.id, {
        month: approved.periodStart.slice(0, 7),
        claimsPaid: paying.length,
      });
      return runDetail(tx, principal, approved, context);
    });
    return { status: 200, body: detail };
  },
});

export const discardPayRunRoute = defineRoute({
  method: 'delete',
  path: '/v1/payroll/runs/:runId',
  operationId: 'discardPayRun',
  summary: 'Discard a draft pay run',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.run',
  feature: PAYROLL,
  params: runParams,
  query: noSchema,
  body: noSchema,
  responses: {
    204: { description: 'Discarded.' },
    404: { description: 'No such run.' },
    409: { description: 'Approved: it stays.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    await withTenant(principal.tenantId, async (tx) => {
      const run = await draftOrRefuse(tx, params.runId);
      await tx.hrPayroll.discardRun(run.id);
      await audit(tx, context, 'payroll.run_discarded', 'payroll_run', run.id, {
        month: run.periodStart.slice(0, 7),
      });
    });
    return { status: 204, body: undefined };
  },
});

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

function payslipBody(run: PayRun, employee: Employee, line: PayLine) {
  return {
    run: {
      id: run.id,
      reference: formatPayRunReference(run.periodStart),
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      payDate: run.payDate,
      currency: run.currency,
    },
    employee: {
      id: employee.id,
      name: employee.fullName,
      employeeNumber: employee.employeeNumber,
      jobTitle: employee.jobTitle,
      department: employee.department,
      hireDate: employee.hireDate,
    },
    line: lineBody(line),
    disclaimer: PAYROLL_DISCLAIMER,
  };
}

export const runPayslipsRoute = defineRoute({
  method: 'get',
  path: '/v1/payroll/runs/:runId/payslips',
  operationId: 'getPayRunPayslips',
  summary: 'Every payslip of an approved run, to print',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.run',
  feature: PAYROLL,
  params: runParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The payslips.', schema: z.object({ items: z.array(payslipSchema) }) },
    404: { description: 'No such run.' },
    409: { description: 'Still a draft.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const run = await readRun(tx, params.runId);
      if (run.status !== 'approved') {
        throw conflict('run_not_approved', 'Payslips come from an approved run.');
      }
      const lines = await tx.hrPayroll.lines(run.id);
      const employees = new Map(
        (await tx.hrEmployees.findMany(lines.map((line) => line.employeeId))).map((employee) => [
          employee.id,
          employee,
        ]),
      );
      return {
        items: lines.flatMap((line) => {
          const employee = employees.get(line.employeeId);
          return employee === undefined ? [] : [payslipBody(run, employee, line)];
        }),
      };
    });
    return { status: 200, body };
  },
});

export const myPayslipsRoute = defineRoute({
  method: 'get',
  path: '/v1/hr/me/payslips',
  operationId: 'listMyPayslips',
  summary: 'My own payslips, latest first',
  description: 'Every member reads their own, from approved runs. Empty without a profile.',
  tags: TAGS,
  security: 'authenticated',
  feature: PAYROLL,
  params: noSchema,
  query: z.object({ limit: z.coerce.number().int().min(1).max(60).default(24) }),
  body: noSchema,
  responses: {
    200: { description: 'The payslips.', schema: z.object({ items: z.array(payslipSchema) }) },
  },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const employee = await tx.hrEmployees.findByUser(principal.userId);
      if (employee === undefined) {
        return { items: [] };
      }
      const slips = await tx.hrPayroll.payslipsOf(employee.id, query.limit);
      return { items: slips.map(({ run, line }) => payslipBody(run, employee, line)) };
    });
    return { status: 200, body };
  },
});

function csvResponse(body: string, filename: string) {
  return {
    status: 200 as const,
    body,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  };
}

export const insuranceReportRoute = defineRoute({
  method: 'get',
  path: '/v1/payroll/runs/:runId/insurance.csv',
  operationId: 'getPayRunInsuranceReport',
  summary: 'The month’s social insurance contributions, as CSV',
  description:
    'Each insured employee’s insurance number, insurable wage and both shares, with a total. The full insurance number needs HR_DATA_KEY on the server (503 `hr_key_missing`). Audited.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.run',
  feature: PAYROLL,
  params: runParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'CSV.', schema: z.string(), contentType: 'text/csv' },
    404: { description: 'No such run.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    if (!holds(principal, 'hr.sensitive')) {
      throw forbidden('Insurance numbers are for owners and HR managers.');
    }
    const key = keyOrRefuse(context);
    const csv = await withTenant(principal.tenantId, async (tx) => {
      const run = await readRun(tx, params.runId);
      const lines = (await tx.hrPayroll.lines(run.id)).filter((line) => line.insured);
      const employees = new Map(
        (await tx.hrEmployees.findMany(lines.map((line) => line.employeeId))).map((employee) => [
          employee.id,
          employee,
        ]),
      );
      const rows: (string | number | null)[][] = [
        [
          'Employee',
          'Employee number',
          'Insurance number',
          'Insurable wage',
          'Employee share',
          'Employer share',
          'Total',
        ],
      ];
      for (const line of lines) {
        const employee = employees.get(line.employeeId);
        const sealed = employee?.insuranceNumber;
        rows.push([
          line.employeeName,
          employee?.employeeNumber ?? null,
          sealed === null || sealed === undefined
            ? null
            : openField(sealed.sealed, key, {
                tenantId: principal.tenantId,
                employeeId: line.employeeId,
                field: 'insuranceNumber',
              }),
          line.insurableWage,
          line.socialInsuranceEmployee,
          line.socialInsuranceEmployer,
          sum([line.socialInsuranceEmployee, line.socialInsuranceEmployer]),
        ]);
      }
      rows.push([
        'Total',
        null,
        null,
        sum(lines.map((line) => line.insurableWage)),
        sum(lines.map((line) => line.socialInsuranceEmployee)),
        sum(lines.map((line) => line.socialInsuranceEmployer)),
        sum(lines.flatMap((line) => [line.socialInsuranceEmployee, line.socialInsuranceEmployer])),
      ]);
      await audit(tx, context, 'payroll.insurance_report_exported', 'payroll_run', run.id, {
        employees: lines.length,
      });
      return { body: toCsv(rows), reference: formatPayRunReference(run.periodStart) };
    });
    return csvResponse(csv.body, `${csv.reference}-insurance.csv`);
  },
});

export const bankFileRoute = defineRoute({
  method: 'get',
  path: '/v1/payroll/runs/:runId/bank.csv',
  operationId: 'getPayRunBankFile',
  summary: 'The bank transfer list of an approved run, as CSV',
  description:
    'One row per employee paid by bank transfer: name, bank, account number and net pay, with the run’s reference. Needs HR_DATA_KEY on the server (503 `hr_key_missing`). Audited.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'payroll.run',
  feature: PAYROLL,
  params: runParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'CSV.', schema: z.string(), contentType: 'text/csv' },
    404: { description: 'No such run.' },
    409: { description: 'Still a draft.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    if (!holds(principal, 'hr.sensitive')) {
      throw forbidden('Bank details are for owners and HR managers.');
    }
    const key = keyOrRefuse(context);
    const csv = await withTenant(principal.tenantId, async (tx) => {
      const run = await readRun(tx, params.runId);
      if (run.status !== 'approved') {
        throw conflict('run_not_approved', 'The bank list comes from an approved run.');
      }
      const reference = formatPayRunReference(run.periodStart);
      const lines = (await tx.hrPayroll.lines(run.id)).filter(
        (line) => line.payMethod === 'bank_transfer' && toUnits(line.net) > 0n,
      );
      const employees = new Map(
        (await tx.hrEmployees.findMany(lines.map((line) => line.employeeId))).map((employee) => [
          employee.id,
          employee,
        ]),
      );
      const rows: (string | number | null)[][] = [
        ['Employee', 'Employee number', 'Bank', 'Account', 'Amount', 'Currency', 'Reference'],
      ];
      let missing = 0;
      for (const line of lines) {
        const employee = employees.get(line.employeeId);
        const sealed = employee?.bankAccount;
        if (sealed === null || sealed === undefined) {
          missing += 1;
        }
        rows.push([
          line.employeeName,
          employee?.employeeNumber ?? null,
          employee?.bankName ?? null,
          sealed === null || sealed === undefined
            ? null
            : openField(sealed.sealed, key, {
                tenantId: principal.tenantId,
                employeeId: line.employeeId,
                field: 'bankAccount',
              }),
          line.net,
          run.currency,
          reference,
        ]);
      }
      await audit(tx, context, 'payroll.bank_file_exported', 'payroll_run', run.id, {
        rows: lines.length,
        withoutAccount: missing,
      });
      return { body: toCsv(rows), reference };
    });
    return csvResponse(csv.body, `${csv.reference}-bank.csv`);
  },
});

export const payrollRoutes = [
  listRuleSetsRoute,
  createRuleSetRoute,
  updateRuleSetRoute,
  confirmRuleSetRoute,
  removeRuleSetRoute,
  listPayTermsRoute,
  addPayTermsRoute,
  updatePayTermsRoute,
  removePayTermsRoute,
  listPayRunsRoute,
  createPayRunRoute,
  getPayRunRoute,
  updatePayRunRoute,
  recalculatePayRunRoute,
  updatePayLineRoute,
  approvePayRunRoute,
  discardPayRunRoute,
  runPayslipsRoute,
  myPayslipsRoute,
  insuranceReportRoute,
  bankFileRoute,
];
