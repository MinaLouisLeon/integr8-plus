import { z } from 'zod';
import { addDays } from './finance.js';

/**
 * Skills and certificates (P26), shared by the API, the desktop and the phone.
 *
 * A company keeps a list of qualification types. A skill never expires; a
 * certificate may. People hold them, and a job lists the ones it needs. The rule
 * the board applies: for each requirement, at least one person on a visit holds
 * it, valid on the visit's dates. Nothing is refused when nobody does — the
 * dispatcher gives a reason and goes ahead (product decision, 2026-10-27).
 *
 * Dates are calendar days, `YYYY-MM-DD`, in the company's time zone: a
 * certificate's expiry date is the last day it is valid, whatever the hour.
 */

export const QUALIFICATION_KINDS = ['skill', 'certificate'] as const;
export const qualificationKindSchema = z.enum(QUALIFICATION_KINDS);
export type QualificationKind = z.infer<typeof qualificationKindSchema>;

/** How many days before expiry people are warned, unless the company says otherwise. */
export const DEFAULT_QUALIFICATION_WARNING_DAYS = 30;
/** `tenant_settings_qualification_warning_days_bounds`. */
export const QUALIFICATION_WARNING_DAYS_MIN = 1;
export const QUALIFICATION_WARNING_DAYS_MAX = 365;

/** `work_order_qualification_overrides_reason_length`. */
export const QUALIFICATION_OVERRIDE_REASON_MAX = 500;

/** A calendar day, `YYYY-MM-DD`. */
export const calendarDaySchema = z.iso.date();

/** One qualification a person holds, as far as checking it goes. */
export interface QualificationHolding {
  userId: string;
  qualificationTypeId: string;
  /** Null: no start date recorded. */
  issuedOn: string | null;
  /** The last day it is valid. Null: it does not expire. */
  expiresOn: string | null;
}

export interface QualificationRequirement {
  qualificationTypeId: string;
  name: string;
}

/** The calendar days a visit covers, both ends included. */
export interface DaySpan {
  from: string;
  to: string;
}

/**
 * What one person's record says for one requirement on a visit's days.
 *
 * - `valid`: held, and valid on every day of the visit.
 * - `expires_before_visit`: valid today, but lapses before the visit ends.
 * - `expired`: lapsed already.
 * - `missing`: never held, or not yet valid when the visit starts.
 */
export const HOLDING_STATUSES = ['valid', 'expires_before_visit', 'expired', 'missing'] as const;
export type HoldingStatus = (typeof HOLDING_STATUSES)[number];

/** A requirement nobody on the visit meets, with what each of them holds. */
export interface QualificationGap {
  qualificationTypeId: string;
  name: string;
  people: { userId: string; status: Exclude<HoldingStatus, 'valid'> }[];
}

/** The calendar day an instant falls on in a time zone. */
export function calendarDay(at: Date, timeZone: string): string {
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * The days a visit covers in the company's time zone. Its end is exclusive, so a
 * visit ending at midnight does not reach into the next day.
 */
export function visitDays(visit: { startsAt: Date; endsAt: Date }, timeZone: string): DaySpan {
  const lastMoment = new Date(Math.max(visit.startsAt.getTime(), visit.endsAt.getTime() - 1));
  return { from: calendarDay(visit.startsAt, timeZone), to: calendarDay(lastMoment, timeZone) };
}

/** Whether a record is valid on every day of a span. */
export function coversDays(
  holding: Pick<QualificationHolding, 'issuedOn' | 'expiresOn'>,
  days: DaySpan,
): boolean {
  return (
    (holding.issuedOn === null || holding.issuedOn <= days.from) &&
    (holding.expiresOn === null || holding.expiresOn >= days.to)
  );
}

/**
 * What a person's records of one qualification say for a visit's days. A person
 * may hold several records of the same qualification — renewals — and any one
 * that covers the visit is enough.
 */
export function holdingStatus(
  records: readonly Pick<QualificationHolding, 'issuedOn' | 'expiresOn'>[],
  days: DaySpan,
  today: string,
): HoldingStatus {
  if (records.some((record) => coversDays(record, days))) {
    return 'valid';
  }
  const started = records.filter(
    (record) => record.issuedOn === null || record.issuedOn <= days.from,
  );
  const latest = started
    .map((record) => record.expiresOn)
    .filter((expiresOn): expiresOn is string => expiresOn !== null)
    .sort()
    .at(-1);
  if (latest === undefined) {
    return 'missing';
  }
  return latest < today ? 'expired' : 'expires_before_visit';
}

/**
 * The requirements nobody on a visit meets. A visit with nobody on it has no
 * gaps: there is nobody to check yet, and the board already says so.
 */
export function qualificationGaps(input: {
  requirements: readonly QualificationRequirement[];
  assigneeIds: readonly string[];
  holdings: readonly QualificationHolding[];
  days: DaySpan;
  today: string;
}): QualificationGap[] {
  if (input.assigneeIds.length === 0) {
    return [];
  }
  const gaps: QualificationGap[] = [];
  for (const requirement of input.requirements) {
    const people = input.assigneeIds.map((userId) => ({
      userId,
      status: holdingStatus(
        input.holdings.filter(
          (holding) =>
            holding.userId === userId &&
            holding.qualificationTypeId === requirement.qualificationTypeId,
        ),
        input.days,
        input.today,
      ),
    }));
    if (people.some((person) => person.status === 'valid')) {
      continue;
    }
    gaps.push({
      qualificationTypeId: requirement.qualificationTypeId,
      name: requirement.name,
      people: people.map((person) => ({
        userId: person.userId,
        status: person.status as Exclude<HoldingStatus, 'valid'>,
      })),
    });
  }
  return gaps;
}

/**
 * The gaps a change opens: those after it that were not there before. A gap
 * counts as already there only for the same qualification and the same people:
 * moving a visit already planned without a qualification does not ask for a
 * reason again, but putting someone else on it does, since the reason given
 * may have been about the person.
 */
export function newGaps(
  before: readonly QualificationGap[],
  after: readonly QualificationGap[],
): QualificationGap[] {
  const key = (gap: QualificationGap) =>
    `${gap.qualificationTypeId}:${gap.people
      .map((person) => person.userId)
      .sort()
      .join(',')}`;
  const known = new Set(before.map(key));
  return after.filter((gap) => !known.has(key(gap)));
}

/** Where a certificate stands today, for lists and the phone. */
export type ExpiryState = 'no_expiry' | 'valid' | 'expiring' | 'expired';

export function expiryState(
  expiresOn: string | null,
  today: string,
  warningDays: number,
): ExpiryState {
  if (expiresOn === null) {
    return 'no_expiry';
  }
  if (expiresOn < today) {
    return 'expired';
  }
  return expiresOn <= addDays(today, warningDays) ? 'expiring' : 'valid';
}

/**
 * How many of a job's requirements a person meets on a visit's days: the order
 * a people picker shows them in, best first.
 */
export function requirementsMet(
  userId: string,
  requirements: readonly QualificationRequirement[],
  holdings: readonly QualificationHolding[],
  days: DaySpan,
  today: string,
): { met: number; statuses: { qualificationTypeId: string; status: HoldingStatus }[] } {
  const statuses = requirements.map((requirement) => ({
    qualificationTypeId: requirement.qualificationTypeId,
    status: holdingStatus(
      holdings.filter(
        (holding) =>
          holding.userId === userId &&
          holding.qualificationTypeId === requirement.qualificationTypeId,
      ),
      days,
      today,
    ),
  }));
  return { met: statuses.filter((entry) => entry.status === 'valid').length, statuses };
}
