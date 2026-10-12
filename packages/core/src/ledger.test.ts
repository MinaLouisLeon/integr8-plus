import { describe, expect, it } from 'vitest';
import {
  convertAmount,
  convertLines,
  naturalBalance,
  agingBucket,
  csvCell,
  toCsv,
  DEFAULT_CHART,
  exchangeRateSchema,
  fiscalYearOf,
  formatJournalReference,
  fromUnits,
  journalTotals,
  ledgerAmountSchema,
  monthEnd,
  monthsBetween,
  normalSide,
  parseJournalReference,
  POSTING_ROLES,
  sumAmounts,
  toUnits,
} from './ledger.js';

describe('journal references', () => {
  it('formats and reads them however they are typed', () => {
    expect(formatJournalReference(42)).toBe('JV-000042');
    for (const text of ['JV-000042', 'jv42', ' 42 ', 'JV42']) {
      expect(parseJournalReference(text), text).toBe(42);
    }
    expect(parseJournalReference('INV-000042')).toBeUndefined();
    expect(parseJournalReference('0')).toBeUndefined();
  });
});

describe('the default chart', () => {
  it('has unique codes and one account for every automatic posting', () => {
    const codes = DEFAULT_CHART.map((account) => account.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const role of POSTING_ROLES) {
      expect(
        DEFAULT_CHART.filter((account) => account.role === role),
        role,
      ).toHaveLength(1);
    }
    expect(DEFAULT_CHART.every((account) => account.name.en !== '' && account.name.ar !== '')).toBe(
      true,
    );
  });

  it('puts assets and expenses on the debit side', () => {
    expect(normalSide('asset')).toBe('debit');
    expect(normalSide('expense')).toBe('debit');
    expect(normalSide('liability')).toBe('credit');
    expect(normalSide('income')).toBe('credit');
    expect(normalSide('equity')).toBe('credit');
  });
});

describe('amounts', () => {
  it('add exactly, signed, without a float', () => {
    expect(toUnits('-12.5')).toBe(-125_000n);
    expect(fromUnits(-125_000n)).toBe('-12.5');
    expect(fromUnits(0n)).toBe('0');
    expect(sumAmounts(['0.1', '0.2'])).toBe('0.3');
    expect(sumAmounts(['9999999999999999.9999', '0.0001'])).toBe('10000000000000000');
    expect(sumAmounts(['100', '-100.0001'])).toBe('-0.0001');
  });

  it('balance a journal only when debits equal credits on two lines or more', () => {
    expect(
      journalTotals([
        { debit: '114', credit: '' },
        { debit: '', credit: '100' },
        { debit: '', credit: '14' },
      ]),
    ).toEqual({ debit: '114', credit: '114', balanced: true });
    expect(journalTotals([{ debit: '1', credit: '' }]).balanced).toBe(false);
    expect(
      journalTotals([
        { debit: '0.1', credit: '' },
        { debit: '0.2', credit: '' },
        { debit: '', credit: '0.3001' },
      ]).balanced,
    ).toBe(false);
  });

  it('accept only positive amounts and rates', () => {
    expect(ledgerAmountSchema.safeParse('0').success).toBe(false);
    expect(ledgerAmountSchema.safeParse('0.0001').success).toBe(true);
    expect(ledgerAmountSchema.safeParse('-1').success).toBe(false);
    expect(exchangeRateSchema.safeParse('0.0000').success).toBe(false);
    expect(exchangeRateSchema.safeParse('48.7512345678').success).toBe(true);
  });

  it('convert a foreign amount at a typed rate, rounded half up to four places', () => {
    expect(convertAmount('100', '48.75')).toBe('4875');
    expect(convertAmount('0.01', '48.12345')).toBe('0.4812');
    expect(convertAmount('0.03', '0.005')).toBe('0.0002');
  });

  it('converts a journal line by line and keeps it balanced', () => {
    // Thirds at a rate that rounds each line its own way.
    const lines = convertLines(
      [
        { debit: '100', credit: '0' },
        { debit: '0', credit: '33.3333' },
        { debit: '0', credit: '33.3333' },
        { debit: '0', credit: '33.3334' },
      ],
      '1.23456',
    );
    expect(lines.map((line) => [line.debit, line.credit, line.foreignAmount])).toEqual([
      // 123.456, raised by the ten-thousandth the credits rounded up.
      ['123.4561', '0', '100'],
      ['0', '41.152', '33.3333'],
      ['0', '41.152', '33.3333'],
      ['0', '41.1521', '33.3334'],
    ]);
    const twoWay = convertLines(
      [
        { debit: '0.0001', credit: '0' },
        { debit: '0.0001', credit: '0' },
        { debit: '0', credit: '0.0002' },
      ],
      '0.5',
    );
    expect(twoWay.map((line) => [line.debit, line.credit])).toEqual([
      ['0.0001', '0'],
      ['0.0001', '0'],
      ['0', '0.0002'],
    ]);
  });
});

describe('months and fiscal years', () => {
  it('know the last day of a month, leap years included', () => {
    expect(monthEnd('2028-02-10')).toBe('2028-02-29');
    expect(monthEnd('2026-12-01')).toBe('2026-12-31');
  });

  it('find the fiscal year a day is in, for any start month', () => {
    expect(fiscalYearOf('2026-10-12', 1)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(fiscalYearOf('2026-10-12', 7)).toEqual({ start: '2026-07-01', end: '2027-06-30' });
    expect(fiscalYearOf('2026-03-31', 7)).toEqual({ start: '2025-07-01', end: '2026-06-30' });
  });

  it('list the months between two days', () => {
    expect(monthsBetween('2026-11-15', '2027-02-01')).toEqual([
      '2026-11-01',
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
    ]);
  });
});

describe('reports', () => {
  it('reads a balance on the account’s normal side', () => {
    expect(naturalBalance('asset', '150', '50')).toBe('100');
    expect(naturalBalance('income', '50', '150')).toBe('100');
    expect(naturalBalance('liability', '200', '50.5')).toBe('-149.5');
  });

  it('ages an invoice from its due date, or its issue date without one', () => {
    expect(agingBucket('2026-10-12', '2026-09-01', '2026-10-12')).toBe('current');
    expect(agingBucket('2026-10-11', '2026-09-01', '2026-10-12')).toBe('days1to30');
    expect(agingBucket('2026-09-12', '2026-09-01', '2026-10-12')).toBe('days1to30');
    expect(agingBucket('2026-09-11', '2026-09-01', '2026-10-12')).toBe('days31to60');
    expect(agingBucket('2026-07-14', '2026-07-01', '2026-10-12')).toBe('days61to90');
    expect(agingBucket(null, '2026-07-13', '2026-10-12')).toBe('over90');
  });

  it('writes CSV a spreadsheet will not run', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-12.5')).toBe('-12.5');
    expect(csvCell('@SUM')).toBe("'@SUM");
    expect(csvCell(null)).toBe('');
    expect(
      toCsv([
        ['code', 'name'],
        ['1100', 'Cash, petty'],
      ]),
    ).toBe('\uFEFFcode,name\r\n1100,"Cash, petty"\r\n');
  });
});
