import { ApiRequestError } from '@integr8/api-client';

/**
 * Skills and certificates (P26), kept apart from React so they can be tested
 * on their own: reading a `visit_unqualified` refusal, ranking people for a
 * visit, and sorting people's records.
 */

/** Why someone on a visit does not count for a requirement. */
export type HoldingProblem = 'missing' | 'expired' | 'expires_before_visit';
export type HoldingStatus = 'valid' | HoldingProblem;

const PROBLEMS: readonly string[] = ['missing', 'expired', 'expires_before_visit'];

/** One person × requirement the server named when it refused a visit. */
export interface UnqualifiedDetail {
  userId: string;
  qualificationTypeId: string;
  qualification: string;
  status: HoldingProblem;
}

/** The refusal a dispatcher answers with a reason: nobody on the visit holds what the job needs. */
export function isUnqualified(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.code === 'visit_unqualified';
}

/** Who lacks what, from a `visit_unqualified` refusal; nothing for any other failure. */
export function unqualifiedDetails(error: unknown): UnqualifiedDetail[] {
  if (!isUnqualified(error)) {
    return [];
  }
  return error.details.flatMap((detail) => {
    const params = detail.params ?? {};
    if (!PROBLEMS.includes(detail.code) || params.qualificationTypeId === undefined) {
      return [];
    }
    return [
      {
        userId: params.userId ?? '',
        qualificationTypeId: params.qualificationTypeId,
        qualification: params.qualification ?? '',
        status: detail.code as HoldingProblem,
      },
    ];
  });
}

/** The details grouped by requirement, in the order the server named them. */
export function groupByRequirement(details: readonly UnqualifiedDetail[]): {
  qualificationTypeId: string;
  name: string;
  people: { userId: string; status: HoldingProblem }[];
}[] {
  const groups = new Map<
    string,
    {
      qualificationTypeId: string;
      name: string;
      people: { userId: string; status: HoldingProblem }[];
    }
  >();
  for (const detail of details) {
    const group = groups.get(detail.qualificationTypeId) ?? {
      qualificationTypeId: detail.qualificationTypeId,
      name: detail.qualification,
      people: [],
    };
    group.people.push({ userId: detail.userId, status: detail.status });
    groups.set(detail.qualificationTypeId, group);
  }
  return [...groups.values()];
}

/** What `GET /v1/work-orders/:id/eligibility` says about one person. */
export interface Eligible {
  id: string;
  met: number;
  statuses: readonly { qualificationTypeId: string; status: HoldingStatus }[];
}

export interface Ranked<P> {
  person: P;
  /** Holds every requirement, valid on the visit's days. True when the job needs nothing. */
  qualified: boolean;
  /** The requirements this person does not meet, and why. */
  problems: { qualificationTypeId: string; status: HoldingProblem }[];
}

/**
 * People for a visit's picker, best first: those holding everything the job
 * needs, then those holding most, in the server's order. Nobody is hidden —
 * going ahead with a reason is allowed — but those short of something are
 * last and say what they lack. People the server did not rank (no longer in
 * the company) come at the very end, as they were.
 */
export function rankPeople<P extends { id: string }>(
  people: readonly P[],
  eligibility: { requirements: readonly unknown[]; people: readonly Eligible[] } | undefined,
): Ranked<P>[] {
  if (eligibility === undefined || eligibility.requirements.length === 0) {
    return people.map((person) => ({ person, qualified: true, problems: [] }));
  }
  const required = eligibility.requirements.length;
  const order = new Map(eligibility.people.map((entry, index) => [entry.id, index]));
  const byId = new Map(eligibility.people.map((entry) => [entry.id, entry]));
  const ranked = people.map((person, index) => {
    const entry = byId.get(person.id);
    const problems = (entry?.statuses ?? []).flatMap((status) =>
      status.status === 'valid'
        ? []
        : [{ qualificationTypeId: status.qualificationTypeId, status: status.status }],
    );
    return {
      person,
      qualified: entry !== undefined && entry.met >= required,
      problems,
      rank: order.get(person.id) ?? eligibility.people.length + index,
    };
  });
  return ranked
    .sort((a, b) => Number(b.qualified) - Number(a.qualified) || a.rank - b.rank)
    .map(({ person, qualified, problems }) => ({ person, qualified, problems }));
}

/**
 * The requirements nobody chosen holds for the visit's days: what the server
 * will refuse without a reason. Empty when the job needs nothing.
 */
export function uncovered<R extends { qualificationTypeId: string }>(
  requirements: readonly R[],
  chosen: readonly string[],
  eligibility: readonly Eligible[],
): R[] {
  if (chosen.length === 0) {
    return [];
  }
  const holds = (userId: string, typeId: string) =>
    eligibility
      .find((entry) => entry.id === userId)
      ?.statuses.some(
        (status) => status.qualificationTypeId === typeId && status.status === 'valid',
      ) ?? false;
  return requirements.filter(
    (requirement) => !chosen.some((userId) => holds(userId, requirement.qualificationTypeId)),
  );
}

export type RecordState = 'no_expiry' | 'valid' | 'expiring' | 'expired' | 'removed';

/** Where a record needs attention first: expired, then expiring, then the rest. */
const STATE_ORDER: Record<RecordState, number> = {
  expired: 0,
  expiring: 1,
  valid: 2,
  no_expiry: 3,
  removed: 4,
};

/** Records for the "expiring soon and expired" view: the ones somebody must act on. */
export function needsAttention(state: RecordState): boolean {
  return state === 'expired' || state === 'expiring';
}

/**
 * Records in reading order: by person, then by qualification; or, when
 * `urgent`, the soonest to run out first.
 */
export function sortRecords<
  R extends {
    person: { name: string };
    qualificationType: { name: string };
    expiresOn: string | null;
    state: RecordState;
  },
>(records: readonly R[], locale: string, urgent = false): R[] {
  return [...records].sort((a, b) => {
    if (urgent) {
      return (
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        (a.expiresOn ?? '9999').localeCompare(b.expiresOn ?? '9999') ||
        a.person.name.localeCompare(b.person.name, locale)
      );
    }
    return (
      a.person.name.localeCompare(b.person.name, locale) ||
      a.qualificationType.name.localeCompare(b.qualificationType.name, locale) ||
      STATE_ORDER[a.state] - STATE_ORDER[b.state]
    );
  });
}

/** `2026-11-02` as the reader writes a date; a calendar day has no time zone. */
export function formatDay(day: string, locale: string): string {
  const [year, month, date] = day.split('-').map(Number);
  if (year === undefined || month === undefined || date === undefined) {
    return day;
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, date)),
  );
}
