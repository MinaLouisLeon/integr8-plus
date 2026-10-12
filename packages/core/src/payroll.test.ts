import { describe, expect, it } from 'vitest';
import {
  annualIncomeTax,
  calculatePay,
  daysOutsideEmployment,
  defaultOvertimeRate,
  payMonth,
  proposedOvertimeHours,
  EGYPT_2026_RULES,
  type PayInput,
  payrollRulesSchema,
} from './payroll.js';

const rules = EGYPT_2026_RULES;

const base: PayInput = {
  basic: '10000',
  allowances: '2000',
  overtimeHours: '0',
  overtimeRate: '0',
  bonus: '0',
  deduction: '0',
  unpaidDays: '0',
  reimbursements: '0',
  insurableWage: null,
  insured: true,
};

describe('income tax', () => {
  it('works band by band below the high-income tiers', () => {
    expect(annualIncomeTax('0', rules)).toBe('0');
    expect(annualIncomeTax('40000', rules)).toBe('0');
    // 15,000 at 10%.
    expect(annualIncomeTax('55000', rules)).toBe('1500');
    // 1,500 + 2,250 + 38,160 at 20%.
    expect(annualIncomeTax('108160', rules)).toBe('11382');
  });

  it('drops the lower bands above 600,000, in steps', () => {
    // 55,000 at 10%, 15,000 at 15%, 130,000 at 20%, 200,000 at 22.5%, 250,000 at 25%.
    expect(annualIncomeTax('650000', rules)).toBe('141250');
    // Above 1,200,000: 25% up to it, 27.5% beyond.
    expect(annualIncomeTax('1500000', rules)).toBe('382500');
  });
});

describe('a month’s pay', () => {
  it('takes insurance, tax and the Martyrs’ Fund, exactly', () => {
    expect(calculatePay(base, rules)).toEqual({
      overtimePay: '0',
      unpaidLeave: '0',
      gross: '12000',
      insurableWage: '12000',
      socialInsuranceEmployee: '1320',
      socialInsuranceEmployer: '2250',
      taxable: '10680',
      // 11,382 a year, a twelfth of it.
      incomeTax: '948.5',
      martyrsFund: '6',
      reimbursements: '0',
      net: '9725.5',
    });
  });

  it('insures within the limits, or not at all', () => {
    expect(calculatePay({ ...base, basic: '30000' }, rules).insurableWage).toBe('16700');
    expect(calculatePay({ ...base, basic: '1500', allowances: '0' }, rules).insurableWage).toBe(
      '2700',
    );
    expect(calculatePay({ ...base, insurableWage: '8000' }, rules).socialInsuranceEmployee).toBe(
      '880',
    );
    const uninsured = calculatePay({ ...base, insured: false }, rules);
    expect(uninsured).toMatchObject({ socialInsuranceEmployee: '0', socialInsuranceEmployer: '0' });
  });

  it('adds overtime and bonuses, takes unpaid leave and deductions, and pays claims back untaxed', () => {
    const month = calculatePay(
      {
        ...base,
        overtimeHours: '10.5',
        overtimeRate: '75',
        bonus: '500',
        deduction: '200',
        unpaidDays: '2',
        reimbursements: '350.25',
      },
      rules,
    );
    // 12,000 / 30 × 2 = 800 of unpaid leave; 787.5 of overtime.
    expect(month).toMatchObject({ overtimePay: '787.5', unpaidLeave: '800', gross: '12287.5' });
    expect(month.reimbursements).toBe('350.25');
    const withoutClaims = calculatePay(
      {
        ...base,
        overtimeHours: '10.5',
        overtimeRate: '75',
        bonus: '500',
        deduction: '200',
        unpaidDays: '2',
      },
      rules,
    );
    expect(withoutClaims.incomeTax).toBe(month.incomeTax);
  });

  it('balances: what it costs equals what is paid and owed', () => {
    const month = calculatePay({ ...base, bonus: '1234.56', reimbursements: '99.99' }, rules);
    const units = (value: string) => Math.round(Number(value) * 100);
    // Integer piastres, so the sum is exact.
    expect(units(month.gross) + units(month.reimbursements)).toBe(
      units(month.net) +
        units(month.socialInsuranceEmployee) +
        units(month.incomeTax) +
        units(month.martyrsFund),
    );
  });
});

describe('a rule set', () => {
  it('accepts the seeded figures, and refuses bands that do not rise or end open', () => {
    expect(payrollRulesSchema.safeParse(rules).success).toBe(true);
    expect(
      payrollRulesSchema.safeParse({
        ...rules,
        bands: [
          { upTo: '50000', rate: '0' },
          { upTo: '40000', rate: '10' },
          { upTo: null, rate: '20' },
        ],
      }).success,
    ).toBe(false);
    expect(
      payrollRulesSchema.safeParse({ ...rules, bands: [{ upTo: '40000', rate: '0' }] }).success,
    ).toBe(false);
    expect(payrollRulesSchema.safeParse({ ...rules, siEmployeeRate: '120' }).success).toBe(false);
  });
});

describe('what a draft proposes', () => {
  it('pays overtime at 135% of the hourly basic, beyond the standard hours', () => {
    // 10,400 over 208 hours is 50 an hour.
    expect(defaultOvertimeRate('10400', '208')).toBe('67.5');
    expect(proposedOvertimeHours('219.4', '208')).toBe('11.25');
    expect(proposedOvertimeHours('200', '208')).toBe('0');
  });

  it('leaves unpaid the days before hiring and after leaving', () => {
    expect(daysOutsideEmployment('2026-10-01', '2026-10-31', '2020-01-01', null)).toBe(0);
    expect(daysOutsideEmployment('2026-10-01', '2026-10-31', '2026-10-17', null)).toBe(16);
    expect(daysOutsideEmployment('2026-02-01', '2026-02-28', '2025-01-01', '2026-02-14')).toBe(14);
    expect(daysOutsideEmployment('2026-10-01', '2026-10-31', '2026-11-02', null)).toBe(30);
    expect(payMonth('2026-02-11')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });
});
