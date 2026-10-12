import { z } from 'zod';
import { fromUnits, toUnits } from './ledger.js';

/**
 * Egyptian payroll (seventh round; ADR-0010). Integr8 has had no legal
 * review: the figures below are a starting point a company's owner confirms
 * (recording who checked them) before any pay run, and every payslip says the
 * calculation must be checked by the company's accountant.
 *
 * Money is decimal strings and exact arithmetic in ten-thousandths (BigInt),
 * rounded half up to the piastre (0.01) where an amount is paid or owed.
 * Rates are percentages as decimal strings ('22.5' is 22.5%).
 */

export interface TaxBand {
  /** The top of the band, in annual taxable income; null for the last band. */
  upTo: string | null;
  /** Percent. */
  rate: string;
}

export interface TaxTier {
  /** Applies when annual taxable income is above this. */
  above: string;
  bands: TaxBand[];
}

export interface PayrollRules {
  /** Annual, taken off before the bands. */
  personalExemption: string;
  bands: TaxBand[];
  /** High-income tables: the one with the largest `above` below the income applies instead of `bands`. */
  tiers: TaxTier[];
  /** Percent of the insurable wage. */
  siEmployeeRate: string;
  siEmployerRate: string;
  /** Monthly insurable wage limits. */
  siMinWage: string;
  siMaxWage: string;
  /** Percent of gross pay. */
  martyrsFundRate: string;
}

const decimal = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,4})?$/u, 'Use digits with up to four decimal places');
const percent = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,4})?$/u, 'A percentage such as 22.5')
  .refine((value) => toUnits(value) <= 1_000_000n, 'At most 100%');

const bandSchema = z.object({ upTo: decimal.nullable(), rate: percent });

/** Bands rise, and only the last is open-ended. */
const bandsSchema = z
  .array(bandSchema)
  .min(1)
  .max(20)
  .refine((bands) => bands.at(-1)?.upTo === null, 'The last band has no top')
  .refine(
    (bands) =>
      bands.slice(0, -1).every((band, index) => {
        if (band.upTo === null) {
          return false;
        }
        const previous = index === 0 ? null : bands[index - 1]?.upTo;
        return (
          previous === null || previous === undefined || toUnits(band.upTo) > toUnits(previous)
        );
      }),
    'Each band ends above the one before, and only the last has no top',
  );

export const payrollRulesSchema = z.object({
  personalExemption: decimal,
  bands: bandsSchema,
  tiers: z.array(z.object({ above: decimal, bands: bandsSchema })).max(10),
  siEmployeeRate: percent,
  siEmployerRate: percent,
  siMinWage: decimal,
  siMaxWage: decimal,
  martyrsFundRate: percent,
});

/**
 * The 2026 figures as payroll firms describe them (not the official text):
 * income tax under Law 91 of 2005 as amended by Law 7 of 2024, social
 * insurance under Law 148 of 2019 with the January 2026 limits, and the
 * Martyrs' Fund. To be confirmed by the company before use.
 */
export const EGYPT_2026_RULES: PayrollRules = Object.freeze({
  personalExemption: '20000',
  bands: [
    { upTo: '40000', rate: '0' },
    { upTo: '55000', rate: '10' },
    { upTo: '70000', rate: '15' },
    { upTo: '200000', rate: '20' },
    { upTo: '400000', rate: '22.5' },
    { upTo: '1200000', rate: '25' },
    { upTo: null, rate: '27.5' },
  ],
  tiers: [
    {
      above: '600000',
      bands: [
        { upTo: '55000', rate: '10' },
        { upTo: '70000', rate: '15' },
        { upTo: '200000', rate: '20' },
        { upTo: '400000', rate: '22.5' },
        { upTo: '1200000', rate: '25' },
        { upTo: null, rate: '27.5' },
      ],
    },
    {
      above: '700000',
      bands: [
        { upTo: '70000', rate: '15' },
        { upTo: '200000', rate: '20' },
        { upTo: '400000', rate: '22.5' },
        { upTo: '1200000', rate: '25' },
        { upTo: null, rate: '27.5' },
      ],
    },
    {
      above: '800000',
      bands: [
        { upTo: '200000', rate: '20' },
        { upTo: '400000', rate: '22.5' },
        { upTo: '1200000', rate: '25' },
        { upTo: null, rate: '27.5' },
      ],
    },
    {
      above: '900000',
      bands: [
        { upTo: '400000', rate: '22.5' },
        { upTo: '1200000', rate: '25' },
        { upTo: null, rate: '27.5' },
      ],
    },
    {
      above: '1200000',
      bands: [
        { upTo: '1200000', rate: '25' },
        { upTo: null, rate: '27.5' },
      ],
    },
  ],
  siEmployeeRate: '11',
  siEmployerRate: '18.75',
  siMinWage: '2700',
  siMaxWage: '16700',
  martyrsFundRate: '0.05',
});

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/** Ten-thousandths, rounded half up to a multiple of `step` (100 is the piastre). */
function roundTo(units: bigint, step: bigint): bigint {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const rounded = ((absolute + step / 2n) / step) * step;
  return negative ? -rounded : rounded;
}

const PIASTRE = 100n;

/** `amount × rate%`, in ten-thousandths, rounded half up to four places. */
function ofPercent(amount: bigint, rate: string): bigint {
  // amount (×10⁴) × rate (×10⁴) / (100 × 10⁴), half up.
  const product = amount * toUnits(rate);
  const divisor = 1_000_000n;
  return product >= 0n
    ? (product + divisor / 2n) / divisor
    : -((-product + divisor / 2n) / divisor);
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** Tax on an annual taxable income, by the bands that apply to it. */
export function annualIncomeTax(taxable: string, rules: PayrollRules): string {
  const income = toUnits(taxable);
  if (income <= 0n) {
    return '0';
  }
  const tier = [...rules.tiers]
    .filter((candidate) => income > toUnits(candidate.above))
    .sort((left, right) => (toUnits(left.above) < toUnits(right.above) ? 1 : -1))[0];
  const bands = tier?.bands ?? rules.bands;
  let tax = 0n;
  let floor = 0n;
  for (const band of bands) {
    const top = band.upTo === null ? income : min(income, toUnits(band.upTo));
    if (top > floor) {
      tax += ofPercent(top - floor, band.rate);
    }
    if (band.upTo === null || toUnits(band.upTo) >= income) {
      break;
    }
    floor = toUnits(band.upTo);
  }
  return fromUnits(roundTo(tax, PIASTRE));
}

// ---------------------------------------------------------------------------
// A month's pay
// ---------------------------------------------------------------------------

export interface PayInput {
  basic: string;
  /** Fixed monthly allowances, together. */
  allowances: string;
  overtimeHours: string;
  /** Per hour; '0' when overtime is not paid. */
  overtimeRate: string;
  bonus: string;
  /** One-off deductions before tax (a penalty, an advance taken back). */
  deduction: string;
  unpaidDays: string;
  /** Approved expense claims paid through this run: not pay, not taxed. */
  reimbursements: string;
  /** The wage declared for social insurance; basic and allowances when null. */
  insurableWage: string | null;
  /** False for someone outside social insurance (a pensioner, a foreigner exempted). */
  insured: boolean;
}

export interface PayResult {
  overtimePay: string;
  unpaidLeave: string;
  /** Earnings less one-off deductions and unpaid leave; what is taxed and costs the company. */
  gross: string;
  insurableWage: string;
  socialInsuranceEmployee: string;
  socialInsuranceEmployer: string;
  /** Monthly taxable pay: gross less the employee's insurance. */
  taxable: string;
  /** The month's share of the year's tax on twelve such months, less the exemption. */
  incomeTax: string;
  martyrsFund: string;
  reimbursements: string;
  /** What the employee is paid. */
  net: string;
}

/** Days in the month a daily rate is reckoned on, as is customary. */
export const DAYS_IN_PAY_MONTH = 30;

export function calculatePay(input: PayInput, rules: PayrollRules): PayResult {
  const basic = toUnits(input.basic);
  const allowances = toUnits(input.allowances);
  const monthly = basic + allowances;

  const hours = toUnits(input.overtimeHours);
  const overtimePay = roundTo((hours * toUnits(input.overtimeRate)) / 10_000n, PIASTRE);
  const unpaidLeave = roundTo(
    (monthly * toUnits(input.unpaidDays)) / (BigInt(DAYS_IN_PAY_MONTH) * 10_000n),
    PIASTRE,
  );
  const gross = max(
    0n,
    monthly + overtimePay + toUnits(input.bonus) - toUnits(input.deduction) - unpaidLeave,
  );

  const declared = input.insurableWage === null ? monthly : toUnits(input.insurableWage);
  const insurable = input.insured
    ? min(toUnits(rules.siMaxWage), max(toUnits(rules.siMinWage), declared))
    : 0n;
  const siEmployee = roundTo(ofPercent(insurable, rules.siEmployeeRate), PIASTRE);
  const siEmployer = roundTo(ofPercent(insurable, rules.siEmployerRate), PIASTRE);
  const martyrsFund = roundTo(ofPercent(gross, rules.martyrsFundRate), PIASTRE);

  const taxable = max(0n, gross - siEmployee);
  const annualTaxable = max(0n, taxable * 12n - toUnits(rules.personalExemption));
  const incomeTax = roundTo(
    toUnits(annualIncomeTax(fromUnits(annualTaxable), rules)) / 12n,
    PIASTRE,
  );
  const reimbursements = toUnits(input.reimbursements);
  const net = gross - siEmployee - incomeTax - martyrsFund + reimbursements;

  return {
    overtimePay: fromUnits(overtimePay),
    unpaidLeave: fromUnits(unpaidLeave),
    gross: fromUnits(gross),
    insurableWage: fromUnits(insurable),
    socialInsuranceEmployee: fromUnits(siEmployee),
    socialInsuranceEmployer: fromUnits(siEmployer),
    taxable: fromUnits(taxable),
    incomeTax: fromUnits(incomeTax),
    martyrsFund: fromUnits(martyrsFund),
    reimbursements: fromUnits(reimbursements),
    net: fromUnits(net),
  };
}

export const PAY_RUN_STATUSES = ['draft', 'approved'] as const;
export type PayRunStatus = (typeof PAY_RUN_STATUSES)[number];

export const PAY_METHODS = ['bank_transfer', 'cash'] as const;
export const payMethodSchema = z.enum(PAY_METHODS);
export type PayMethod = z.infer<typeof payMethodSchema>;

// ---------------------------------------------------------------------------
// What a draft run proposes
// ---------------------------------------------------------------------------

/** Overtime is paid at 135% of the hourly basic unless the terms say otherwise. */
export const OVERTIME_PREMIUM_PERCENT = '135';

/** The hourly basic times the premium, to the piastre. */
export function defaultOvertimeRate(basic: string, standardHours: string): string {
  const hours = toUnits(standardHours);
  if (hours <= 0n) {
    return '0';
  }
  // basic (×10⁴) / hours (×10⁴) gives the hourly rate in units once scaled.
  const hourly = (toUnits(basic) * 10_000n) / hours;
  return fromUnits(roundTo(ofPercent(hourly, OVERTIME_PREMIUM_PERCENT), PIASTRE));
}

/** Clocked hours beyond the month's standard, to the quarter hour below. */
export function proposedOvertimeHours(clockedHours: string, standardHours: string): string {
  const beyond = toUnits(clockedHours) - toUnits(standardHours);
  if (beyond <= 0n) {
    return '0';
  }
  return fromUnits((beyond / 2_500n) * 2_500n);
}

const dayNumber = (day: string) =>
  Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / 86_400_000;

/**
 * Days of the month before somebody was hired or after they left, unpaid on
 * the thirty-day basis; the whole month when they were not employed at all.
 */
export function daysOutsideEmployment(
  periodStart: string,
  periodEnd: string,
  hireDate: string,
  endDate: string | null,
): number {
  const first = dayNumber(periodStart);
  const last = dayNumber(periodEnd);
  const from = Math.max(first, dayNumber(hireDate));
  const to = endDate === null ? last : Math.min(last, dayNumber(endDate));
  if (to < from) {
    return DAYS_IN_PAY_MONTH;
  }
  const monthDays = last - first + 1;
  const outside = monthDays - (to - from + 1);
  // A whole month employed is thirty days paid, whatever its length.
  return Math.min(DAYS_IN_PAY_MONTH, outside);
}

/** `2026-10-01` and `2026-10-31` for any day of October 2026. */
export function payMonth(day: string): { start: string; end: string } {
  const year = +day.slice(0, 4);
  const month = +day.slice(5, 7);
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start: `${day.slice(0, 7)}-01`, end };
}

/** `PR-2026-10`: a month's run. */
export const formatPayRunReference = (periodStart: string) => `PR-${periodStart.slice(0, 7)}`;
