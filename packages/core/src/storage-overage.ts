/**
 * Storage over a plan's allowance, as a month's invoice line (P16, Low 2).
 *
 * A plan whose overage policy is `allow` (Standard, Enterprise when capped)
 * keeps taking uploads past its allowance, and the nightly sampler records how
 * far over the company was on each day (`tenant_storage_samples.overage_bytes`).
 * Integr8 invoices companies itself (`BILLING_PROVIDER=none`), so somebody
 * needs one number per company per month to put on the invoice.
 *
 * That number is the month's **average** overage: the bytes over the line on
 * each day, added up, divided by the days in the month. It is a GB-month, the
 * unit storage is sold in (and Cloudflare bills us in): 10 GB over for half of
 * a 30-day month is 5 GB-months. A day with no sample counts as zero, so a
 * month in progress shows what has accrued so far, and the figure on the last
 * day is the one to invoice. The peak is shown beside it, because "how far
 * over did they go" is the question the company will ask.
 */

/** A month, `YYYY-MM`. */
export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/u;

/** One day's sample, as far as overage is concerned. */
export interface OverageDay {
  /** `YYYY-MM-DD`. */
  day: string;
  /** Bytes over the allowance that day. Null when the plan was uncapped. */
  overageBytes: number | null;
}

export interface MonthlyOverage {
  /** `YYYY-MM`. */
  month: string;
  daysInMonth: number;
  /** Days in the month with a sample over the allowance. */
  daysOver: number;
  /** The most the company was over on any day of the month. */
  peakBytes: number;
  /** The month's daily overage, summed, over the days in the month: a byte-month. */
  averageBytes: number;
}

/** The month an instant falls in, in UTC (the sampler's day is the database's `current_date`). */
export function utcMonthOf(instant: Date): string {
  return instant.toISOString().slice(0, 7);
}

/** The first and last day of a month, `YYYY-MM-DD`, and how many days it has. */
export function monthBounds(month: string): { first: string; last: string; days: number } {
  if (!MONTH_PATTERN.test(month)) {
    throw new RangeError(`Not a month: ${month}`);
  }
  const [year, number] = month.split('-').map(Number) as [number, number];
  // Day 0 of the next month is the last day of this one.
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(days).padStart(2, '0')}`, days };
}

/** The month before, `YYYY-MM`. */
export function previousMonth(month: string): string {
  const { first } = monthBounds(month);
  const date = new Date(`${first}T00:00:00Z`);
  date.setUTCDate(0);
  return utcMonthOf(date);
}

/** What a month's samples add up to. Days outside the month are ignored. */
export function monthlyOverage(samples: readonly OverageDay[], month: string): MonthlyOverage {
  const { days } = monthBounds(month);
  let total = 0;
  let peak = 0;
  let daysOver = 0;
  for (const sample of samples) {
    const over = sample.overageBytes ?? 0;
    if (!sample.day.startsWith(`${month}-`) || over <= 0) {
      continue;
    }
    total += over;
    peak = Math.max(peak, over);
    daysOver += 1;
  }
  return {
    month,
    daysInMonth: days,
    daysOver,
    peakBytes: peak,
    averageBytes: Math.round(total / days),
  };
}
