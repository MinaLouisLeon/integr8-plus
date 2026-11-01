import { z } from 'zod';

/**
 * The general ledger (CRM/ERP plan, phase A1; ADR-0009): a management ledger
 * in the company's currency. The vocabulary here is checked against the
 * database's own check constraints by the schema-invariant suite.
 *
 * Amounts are decimal strings with up to four places. They are added and
 * compared here as integers of ten-thousandths, never as floats.
 */

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export const accountTypeSchema = z.enum(ACCOUNT_TYPES);
export type AccountType = z.infer<typeof accountTypeSchema>;

/** The side an account's balance normally sits on. */
export function normalSide(type: AccountType): 'debit' | 'credit' {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

/** Income and expense close into retained earnings at the year's end; the rest carry forward. */
export const isProfitAndLoss = (type: AccountType) => type === 'income' || type === 'expense';

export const JOURNAL_STATUSES = ['draft', 'posted'] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];

export const JOURNAL_KINDS = ['manual', 'opening', 'automatic', 'reversal', 'closing'] as const;
export const journalKindSchema = z.enum(JOURNAL_KINDS);
export type JournalKind = z.infer<typeof journalKindSchema>;

/** What an automatic journal posts. */
export const JOURNAL_SOURCE_KINDS = [
  'invoice',
  'credit_note',
  'invoice_void',
  'payment',
  'stock',
  // Seventh round (ADR-0010, ADR-0011).
  'expense_claim',
  'expense_payment',
  'payroll_run',
  'assembly',
  // A payment taken back (0064); its source is the receipt.
  'payment_reversal',
] as const;
export const journalSourceKindSchema = z.enum(JOURNAL_SOURCE_KINDS);
export type JournalSourceKind = z.infer<typeof journalSourceKindSchema>;

export const PERIOD_EVENT_KINDS = ['locked', 'unlocked'] as const;
export type PeriodEventKind = (typeof PERIOD_EVENT_KINDS)[number];

/** The accounts the automatic postings use, as the settings name them. */
export const POSTING_ROLES = [
  'receivables',
  'revenueServices',
  'revenueGoods',
  'vatOutput',
  'cash',
  'bank',
  'otherReceipts',
  'inventory',
  'goodsReceived',
  'partsCost',
  'stockAdjustments',
  'openingBalances',
  'retainedEarnings',
  // Seventh round (ADR-0010, ADR-0011).
  'staffClaimsPayable',
  'staffExpenses',
  'salariesExpense',
  'employerInsuranceExpense',
  'salariesPayable',
  'payrollTaxPayable',
  'socialInsurancePayable',
  'martyrsFundPayable',
  'assemblyAbsorbed',
] as const;
export type PostingRole = (typeof POSTING_ROLES)[number];

/** `JV-000123`. */
export const formatJournalReference = (reference: number) =>
  `JV-${String(reference).padStart(6, '0')}`;

/** `JV-000123`, `jv123` or `123` → 123. */
export function parseJournalReference(text: string): number | undefined {
  const match = /^(?:jv-?)?0*(\d{1,9})$/iu.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const value = Number(match[1]);
  return value > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// The default chart
// ---------------------------------------------------------------------------

export interface DefaultAccount {
  code: string;
  type: AccountType;
  name: { en: string; ar: string };
  /** The automatic posting this account serves, if any. */
  role?: PostingRole;
}

/**
 * A starting chart for a field-service company in Egypt, in the company's
 * currency. Every name and code is the company's to change afterwards; nothing
 * here claims to follow the Egyptian Accounting Standards' or the tax
 * authority's numbering.
 */
export const DEFAULT_CHART: readonly DefaultAccount[] = [
  {
    code: '1100',
    type: 'asset',
    name: { en: 'Cash on hand', ar: 'النقدية بالصندوق' },
    role: 'cash',
  },
  {
    code: '1110',
    type: 'asset',
    name: { en: 'Bank accounts', ar: 'الحسابات البنكية' },
    role: 'bank',
  },
  {
    code: '1120',
    type: 'asset',
    name: { en: 'Other receipts clearing', ar: 'حساب وسيط للمقبوضات الأخرى' },
    role: 'otherReceipts',
  },
  {
    code: '1200',
    type: 'asset',
    name: { en: 'Accounts receivable — customers', ar: 'العملاء (المدينون)' },
    role: 'receivables',
  },
  { code: '1300', type: 'asset', name: { en: 'Inventory', ar: 'المخزون' }, role: 'inventory' },
  { code: '1400', type: 'asset', name: { en: 'Prepaid expenses', ar: 'مصروفات مدفوعة مقدمًا' } },
  {
    code: '1410',
    type: 'asset',
    name: { en: 'VAT recoverable (input)', ar: 'ضريبة القيمة المضافة على المشتريات' },
  },
  { code: '1500', type: 'asset', name: { en: 'Vehicles and equipment', ar: 'السيارات والمعدات' } },
  { code: '1590', type: 'asset', name: { en: 'Accumulated depreciation', ar: 'مجمع الإهلاك' } },
  {
    code: '2100',
    type: 'liability',
    name: { en: 'Accounts payable — suppliers', ar: 'الموردون (الدائنون)' },
  },
  {
    code: '2150',
    type: 'liability',
    name: { en: 'Goods received not invoiced', ar: 'بضاعة مستلمة لم تصل فواتيرها' },
    role: 'goodsReceived',
  },
  {
    code: '2200',
    type: 'liability',
    name: { en: 'VAT payable (output)', ar: 'ضريبة القيمة المضافة المستحقة (المخرجات)' },
    role: 'vatOutput',
  },
  {
    code: '2300',
    type: 'liability',
    name: { en: 'Withholding tax payable', ar: 'ضريبة الخصم والإضافة المستحقة' },
  },
  {
    code: '2310',
    type: 'liability',
    name: { en: 'Salary income tax payable', ar: 'ضريبة كسب العمل المستحقة' },
    role: 'payrollTaxPayable',
  },
  {
    code: '2320',
    type: 'liability',
    name: { en: 'Social insurance payable', ar: 'التأمينات الاجتماعية المستحقة' },
    role: 'socialInsurancePayable',
  },
  {
    code: '2330',
    type: 'liability',
    name: { en: 'Martyrs’ Fund payable', ar: 'صندوق الشهداء المستحق' },
    role: 'martyrsFundPayable',
  },
  {
    code: '2400',
    type: 'liability',
    name: { en: 'Salaries payable', ar: 'رواتب مستحقة' },
    role: 'salariesPayable',
  },
  {
    code: '2410',
    type: 'liability',
    name: { en: 'Staff expense claims payable', ar: 'مطالبات مصروفات العاملين المستحقة' },
    role: 'staffClaimsPayable',
  },
  { code: '3100', type: 'equity', name: { en: 'Owner’s capital', ar: 'رأس المال' } },
  {
    code: '3200',
    type: 'equity',
    name: { en: 'Retained earnings', ar: 'الأرباح المحتجزة' },
    role: 'retainedEarnings',
  },
  {
    code: '3900',
    type: 'equity',
    name: { en: 'Opening balances', ar: 'الأرصدة الافتتاحية' },
    role: 'openingBalances',
  },
  {
    code: '4100',
    type: 'income',
    name: { en: 'Service revenue', ar: 'إيرادات الخدمات' },
    role: 'revenueServices',
  },
  {
    code: '4200',
    type: 'income',
    name: { en: 'Sales of parts and goods', ar: 'مبيعات قطع الغيار والبضائع' },
    role: 'revenueGoods',
  },
  { code: '4900', type: 'income', name: { en: 'Other income', ar: 'إيرادات أخرى' } },
  {
    code: '5100',
    type: 'expense',
    name: { en: 'Cost of parts used', ar: 'تكلفة قطع الغيار المستخدمة' },
    role: 'partsCost',
  },
  {
    code: '5200',
    type: 'expense',
    name: { en: 'Stock adjustments', ar: 'تسويات المخزون' },
    role: 'stockAdjustments',
  },
  {
    code: '5300',
    type: 'expense',
    name: { en: 'Assembly labour and overhead absorbed', ar: 'عمالة وتكاليف تجميع محمّلة' },
    role: 'assemblyAbsorbed',
  },
  {
    code: '6100',
    type: 'expense',
    name: { en: 'Salaries and wages', ar: 'الرواتب والأجور' },
    role: 'salariesExpense',
  },
  {
    code: '6110',
    type: 'expense',
    name: { en: 'Employer social insurance', ar: 'حصة صاحب العمل في التأمينات' },
    role: 'employerInsuranceExpense',
  },
  { code: '6200', type: 'expense', name: { en: 'Vehicles and fuel', ar: 'السيارات والوقود' } },
  { code: '6300', type: 'expense', name: { en: 'Rent', ar: 'الإيجار' } },
  { code: '6400', type: 'expense', name: { en: 'Utilities and phone', ar: 'المرافق والاتصالات' } },
  { code: '6500', type: 'expense', name: { en: 'Bank charges', ar: 'مصروفات بنكية' } },
  {
    code: '6900',
    type: 'expense',
    name: { en: 'Other expenses', ar: 'مصروفات أخرى' },
    role: 'staffExpenses',
  },
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const accountCodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$/u, 'Letters, digits, dots and dashes, up to 20');

/** A positive amount with up to four places, as a string. */
export const ledgerAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,16}(\.\d{1,4})?$/u, 'Use digits with up to four decimal places, such as 1250.50')
  .refine((value) => toUnits(value) > 0n, 'Enter an amount above zero');

/** A rate of the company's currency per unit of another, up to ten places. */
export const exchangeRateSchema = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,10})?$/u, 'Use digits with up to ten decimal places, such as 48.75')
  .refine((value) => /[1-9]/u.test(value), 'Enter a rate above zero');

/** `YYYY-MM-01`. */
export const monthStartSchema = z.iso
  .date()
  .refine((value) => value.endsWith('-01'), 'Use the first day of a month');

export const fiscalStartMonthSchema = z.number().int().min(1).max(12);

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/** A signed decimal string as ten-thousandths. `'-12.5'` → `-125000n`. */
export function toUnits(text: string): bigint {
  const trimmed = text.trim();
  const negative = trimmed.startsWith('-');
  const [whole = '0', fraction = ''] = trimmed.replace(/^[-+]/u, '').split('.');
  const units = BigInt(whole || '0') * 10_000n + BigInt((fraction + '0000').slice(0, 4));
  return negative ? -units : units;
}

/** Ten-thousandths back to the shortest decimal string. `-125000n` → `'-12.5'`. */
export function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / 10_000n;
  const fraction = (absolute % 10_000n).toString().padStart(4, '0').replace(/0+$/u, '');
  const text = fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
  return negative && absolute !== 0n ? `-${text}` : text;
}

/** The exact sum of decimal strings. */
export function sumAmounts(values: readonly string[]): string {
  return fromUnits(values.reduce((total, value) => total + toUnits(value), 0n));
}

/** Debits and credits of a journal's lines, and whether they balance. */
export function journalTotals(lines: readonly { debit: string; credit: string }[]): {
  debit: string;
  credit: string;
  balanced: boolean;
} {
  const debit = lines.reduce((total, line) => total + toUnits(line.debit || '0'), 0n);
  const credit = lines.reduce((total, line) => total + toUnits(line.credit || '0'), 0n);
  return {
    debit: fromUnits(debit),
    credit: fromUnits(credit),
    balanced: lines.length >= 2 && debit > 0n && debit === credit,
  };
}

/** `amount × rate` rounded half up to four places: a foreign amount in the company's currency. */
export function convertAmount(amount: string, rate: string): string {
  const parse = (text: string) => {
    const [whole = '0', fraction = ''] = text.trim().split('.');
    return { digits: BigInt(`${whole}${fraction}`), places: fraction.length };
  };
  const left = parse(amount);
  const right = parse(rate);
  const places = left.places + right.places;
  let product = left.digits * right.digits;
  if (places > 4) {
    const divisor = 10n ** BigInt(places - 4);
    product = (product + divisor / 2n) / divisor;
  } else {
    product *= 10n ** BigInt(4 - places);
  }
  return fromUnits(product);
}

/**
 * A balanced journal in another currency, converted line by line at one rate.
 * Rounding can leave the sides apart by a few ten-thousandths; the difference
 * goes on the largest line of the side that needs it, so the result balances.
 */
export function convertLines<T extends { debit: string; credit: string }>(
  lines: readonly T[],
  rate: string,
): (T & { foreignAmount: string })[] {
  const converted = lines.map((line) => ({
    ...line,
    foreignAmount: toUnits(line.debit) > 0n ? line.debit : line.credit,
    debit: toUnits(line.debit) > 0n ? convertAmount(line.debit, rate) : '0',
    credit: toUnits(line.credit) > 0n ? convertAmount(line.credit, rate) : '0',
  }));
  const totals = converted.reduce(
    (sum, line) => ({
      debit: sum.debit + toUnits(line.debit),
      credit: sum.credit + toUnits(line.credit),
    }),
    { debit: 0n, credit: 0n },
  );
  const gap = totals.debit - totals.credit;
  if (gap !== 0n) {
    // Short of credits: raise the largest credit. Short of debits: the largest debit.
    const side = gap > 0n ? 'credit' : 'debit';
    let largest = -1;
    converted.forEach((line, index) => {
      if (
        toUnits(line[side]) > 0n &&
        (largest < 0 || toUnits(line[side]) > toUnits(converted[largest]?.[side] ?? '0'))
      ) {
        largest = index;
      }
    });
    const target = converted[largest];
    if (target !== undefined) {
      target[side] = fromUnits(toUnits(target[side]) + (gap > 0n ? gap : -gap));
    }
  }
  return converted;
}

// ---------------------------------------------------------------------------
// Months and fiscal years
// ---------------------------------------------------------------------------

/** The first day of the month a `YYYY-MM-DD` date is in. */
export const monthOf = (date: string) => `${date.slice(0, 7)}-01`;

/** The first day of the month after this one. */
export function nextMonth(monthStart: string): string {
  const year = Number(monthStart.slice(0, 4));
  const month = Number(monthStart.slice(5, 7));
  return month === 12
    ? `${String(year + 1)}-01-01`
    : `${String(year)}-${String(month + 1).padStart(2, '0')}-01`;
}

/** The last day of the month a date is in. */
export function monthEnd(date: string): string {
  const next = new Date(`${nextMonth(monthOf(date))}T00:00:00Z`);
  next.setUTCDate(0);
  return next.toISOString().slice(0, 10);
}

/** The fiscal year a date falls in, for a year starting in `startMonth` (1–12). */
export function fiscalYearOf(date: string, startMonth: number): { start: string; end: string } {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const startYear = month >= startMonth ? year : year - 1;
  const start = `${String(startYear)}-${String(startMonth).padStart(2, '0')}-01`;
  const endMonthStart =
    startMonth === 1
      ? `${String(startYear)}-12-01`
      : `${String(startYear + 1)}-${String(startMonth - 1).padStart(2, '0')}-01`;
  return { start, end: monthEnd(endMonthStart) };
}

/** The months from `from` to `to` inclusive, as first days. */
export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  for (let month = monthOf(from); month <= monthOf(to); month = nextMonth(month)) {
    months.push(month);
  }
  return months;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** An account's balance on its normal side: positive when it holds what it should. */
export function naturalBalance(type: AccountType, debit: string, credit: string): string {
  const difference = toUnits(debit) - toUnits(credit);
  return fromUnits(normalSide(type) === 'debit' ? difference : -difference);
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export const AGING_BUCKETS = [
  'current',
  'days1to30',
  'days31to60',
  'days61to90',
  'over90',
] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** How late an invoice is on `asOf`: by its due date, or its issue date when it has none. */
export function agingBucket(dueDate: string | null, issueDate: string, asOf: string): AgingBucket {
  const late = daysBetween(dueDate ?? issueDate, asOf);
  if (late <= 0) {
    return 'current';
  }
  if (late <= 30) {
    return 'days1to30';
  }
  if (late <= 60) {
    return 'days31to60';
  }
  return late <= 90 ? 'days61to90' : 'over90';
}

/**
 * One CSV cell. Quoted when it must be; text a spreadsheet would run as a
 * formula (starting `=`, `+`, `-`, `@`, a tab or a return) is prefixed with an
 * apostrophe, while plain numbers, negative ones included, are left alone.
 */
export function csvCell(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/u.test(text) && !/^-?\d+(\.\d+)?$/u.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Rows as CSV with a byte-order mark, so a spreadsheet opens Arabic names as UTF-8. */
export function toCsv(rows: readonly (readonly (string | number | null)[])[]): string {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
