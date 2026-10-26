import { ApiRequestError } from '@integr8/api-client';
import { describe, expect, it } from 'vitest';
import {
  groupByRequirement,
  isUnqualified,
  needsAttention,
  rankPeople,
  sortRecords,
  uncovered,
  unqualifiedDetails,
} from './model.js';

const GAS = 'gas';
const HEIGHTS = 'heights';

function refusal(code = 'visit_unqualified') {
  return new ApiRequestError(409, code, 'Nobody holds Gas Safe.', 'req', [
    {
      field: 'body.qualificationOverride',
      code: 'expired',
      message: 'Ahmed holds it expired: Gas Safe.',
      params: { qualificationTypeId: GAS, qualification: 'Gas Safe', userId: 'ahmed' },
    },
    {
      field: 'body.qualificationOverride',
      code: 'missing',
      message: 'Sara does not hold it: Gas Safe.',
      params: { qualificationTypeId: GAS, qualification: 'Gas Safe', userId: 'sara' },
    },
    {
      field: 'body.qualificationOverride',
      code: 'expires_before_visit',
      message: 'Sara holds it, but it expires before the visit: Heights.',
      params: { qualificationTypeId: HEIGHTS, qualification: 'Working at heights', userId: 'sara' },
    },
  ]);
}

describe('a visit_unqualified refusal', () => {
  it('says who lacks what, grouped by requirement', () => {
    const error = refusal();
    expect(isUnqualified(error)).toBe(true);
    const details = unqualifiedDetails(error);
    expect(details).toHaveLength(3);
    expect(groupByRequirement(details)).toEqual([
      {
        qualificationTypeId: GAS,
        name: 'Gas Safe',
        people: [
          { userId: 'ahmed', status: 'expired' },
          { userId: 'sara', status: 'missing' },
        ],
      },
      {
        qualificationTypeId: HEIGHTS,
        name: 'Working at heights',
        people: [{ userId: 'sara', status: 'expires_before_visit' }],
      },
    ]);
  });

  it('is nothing for any other failure', () => {
    expect(isUnqualified(refusal('visit_double_booked'))).toBe(false);
    expect(unqualifiedDetails(refusal('visit_double_booked'))).toEqual([]);
    expect(unqualifiedDetails(new Error('offline'))).toEqual([]);
  });
});

describe('ranking people for a visit', () => {
  const people = [
    { id: 'ahmed', name: 'Ahmed' },
    { id: 'left', name: 'Former engineer' },
    { id: 'sara', name: 'Sara' },
    { id: 'zain', name: 'Zain' },
  ];
  const eligibility = {
    requirements: [{ qualificationTypeId: GAS }, { qualificationTypeId: HEIGHTS }],
    // The server's order: most met first.
    people: [
      {
        id: 'zain',
        met: 2,
        statuses: [
          { qualificationTypeId: GAS, status: 'valid' as const },
          { qualificationTypeId: HEIGHTS, status: 'valid' as const },
        ],
      },
      {
        id: 'sara',
        met: 1,
        statuses: [
          { qualificationTypeId: GAS, status: 'valid' as const },
          { qualificationTypeId: HEIGHTS, status: 'expires_before_visit' as const },
        ],
      },
      {
        id: 'ahmed',
        met: 0,
        statuses: [
          { qualificationTypeId: GAS, status: 'expired' as const },
          { qualificationTypeId: HEIGHTS, status: 'missing' as const },
        ],
      },
    ],
  };

  it('puts the qualified first and flags the rest with what they lack, hiding nobody', () => {
    const ranked = rankPeople(people, eligibility);
    expect(ranked.map((entry) => entry.person.id)).toEqual(['zain', 'sara', 'ahmed', 'left']);
    expect(ranked.map((entry) => entry.qualified)).toEqual([true, false, false, false]);
    expect(ranked[1]!.problems).toEqual([
      { qualificationTypeId: HEIGHTS, status: 'expires_before_visit' },
    ]);
    expect(ranked[2]!.problems).toEqual([
      { qualificationTypeId: GAS, status: 'expired' },
      { qualificationTypeId: HEIGHTS, status: 'missing' },
    ]);
  });

  it('keeps the order as it was when the job needs nothing', () => {
    const ranked = rankPeople(people, { requirements: [], people: [] });
    expect(ranked.map((entry) => entry.person.id)).toEqual(['ahmed', 'left', 'sara', 'zain']);
    expect(ranked.every((entry) => entry.qualified)).toBe(true);
    expect(rankPeople(people, undefined).every((entry) => entry.qualified)).toBe(true);
  });

  it('finds the requirements nobody chosen holds', () => {
    const requirements = [
      { qualificationTypeId: GAS, name: 'Gas Safe' },
      { qualificationTypeId: HEIGHTS, name: 'Working at heights' },
    ];
    expect(uncovered(requirements, ['ahmed'], eligibility.people)).toEqual(requirements);
    // A helper may join: one qualified person per requirement is enough.
    expect(uncovered(requirements, ['sara', 'ahmed'], eligibility.people)).toEqual([
      requirements[1],
    ]);
    expect(uncovered(requirements, ['zain', 'ahmed'], eligibility.people)).toEqual([]);
    expect(uncovered(requirements, [], eligibility.people)).toEqual([]);
  });
});

describe('people’s records', () => {
  const record = (
    name: string,
    qualification: string,
    state: 'valid' | 'expiring' | 'expired' | 'no_expiry' | 'removed',
    expiresOn: string | null,
  ) => ({ person: { name }, qualificationType: { name: qualification }, state, expiresOn });

  it('sorts by person, or soonest to run out when only the urgent ones are shown', () => {
    const records = [
      record('Sara', 'Gas Safe', 'valid', '2027-05-01'),
      record('Ahmed', 'Heights', 'expiring', '2026-11-10'),
      record('Ahmed', 'Gas Safe', 'expired', '2026-10-01'),
      record('Badr', 'First aid', 'no_expiry', null),
    ];
    expect(
      sortRecords(records, 'en').map(
        (entry) => `${entry.person.name} ${entry.qualificationType.name}`,
      ),
    ).toEqual(['Ahmed Gas Safe', 'Ahmed Heights', 'Badr First aid', 'Sara Gas Safe']);
    expect(sortRecords(records, 'en', true).map((entry) => entry.state)).toEqual([
      'expired',
      'expiring',
      'valid',
      'no_expiry',
    ]);
    expect(records.filter((entry) => needsAttention(entry.state))).toHaveLength(2);
  });
});
