import { describe, expect, it } from 'vitest';
import { addDays } from './finance.js';
import {
  calendarDay,
  expiryState,
  holdingStatus,
  newGaps,
  qualificationGaps,
  type QualificationHolding,
  requirementsMet,
  visitDays,
} from './qualifications.js';

const electrical = { qualificationTypeId: 'elec', name: 'Electrical inspection' };
const gas = { qualificationTypeId: 'gas', name: 'Gas safe' };

const holding = (overrides: Partial<QualificationHolding> = {}): QualificationHolding => ({
  userId: 'ahmed',
  qualificationTypeId: 'elec',
  issuedOn: '2025-01-01',
  expiresOn: '2026-12-31',
  ...overrides,
});

const days = { from: '2026-11-02', to: '2026-11-02' };
const today = '2026-10-27';

describe('calendar days', () => {
  it('reads the day in the company time zone', () => {
    const lateEvening = new Date('2026-11-01T22:30:00Z');
    expect(calendarDay(lateEvening, 'UTC')).toBe('2026-11-01');
    expect(calendarDay(lateEvening, 'Africa/Cairo')).toBe('2026-11-02');
  });

  it('does not count a visit ending at midnight as reaching the next day', () => {
    expect(
      visitDays(
        { startsAt: new Date('2026-11-02T20:00:00Z'), endsAt: new Date('2026-11-03T00:00:00Z') },
        'UTC',
      ),
    ).toEqual({ from: '2026-11-02', to: '2026-11-02' });
  });

  it('adds days across a month end', () => {
    expect(addDays('2026-10-27', 30)).toBe('2026-11-26');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('a holding on a visit', () => {
  it('is valid through its expiry day', () => {
    expect(holdingStatus([holding({ expiresOn: '2026-11-02' })], days, today)).toBe('valid');
  });

  it('expires before the visit when valid today but lapsing first', () => {
    expect(holdingStatus([holding({ expiresOn: '2026-11-01' })], days, today)).toBe(
      'expires_before_visit',
    );
  });

  it('is expired when it lapsed already', () => {
    expect(holdingStatus([holding({ expiresOn: '2026-10-01' })], days, today)).toBe('expired');
  });

  it('counts a renewal: any record covering the visit is enough', () => {
    expect(
      holdingStatus(
        [
          holding({ expiresOn: '2026-10-01' }),
          holding({ issuedOn: '2026-10-02', expiresOn: null }),
        ],
        days,
        today,
      ),
    ).toBe('valid');
  });

  it('is missing when nothing is held, or nothing has started by the visit', () => {
    expect(holdingStatus([], days, today)).toBe('missing');
    expect(holdingStatus([holding({ issuedOn: '2026-11-10' })], days, today)).toBe('missing');
  });

  it('needs a multi-day visit covered to its last day', () => {
    const week = { from: '2026-11-02', to: '2026-11-06' };
    expect(holdingStatus([holding({ expiresOn: '2026-11-04' })], week, today)).toBe(
      'expires_before_visit',
    );
  });
});

describe('gaps', () => {
  it('needs only one qualified person on the visit', () => {
    expect(
      qualificationGaps({
        requirements: [electrical],
        assigneeIds: ['ahmed', 'sara'],
        holdings: [holding()],
        days,
        today,
      }),
    ).toEqual([]);
  });

  it('names each requirement nobody meets, with what each person holds', () => {
    expect(
      qualificationGaps({
        requirements: [electrical, gas],
        assigneeIds: ['ahmed', 'sara'],
        holdings: [
          holding({ expiresOn: '2026-10-01' }),
          holding({ userId: 'sara', qualificationTypeId: 'gas' }),
        ],
        days,
        today,
      }),
    ).toEqual([
      {
        qualificationTypeId: 'elec',
        name: 'Electrical inspection',
        people: [
          { userId: 'ahmed', status: 'expired' },
          { userId: 'sara', status: 'missing' },
        ],
      },
    ]);
  });

  it('has nothing to check on a visit with nobody on it', () => {
    expect(
      qualificationGaps({ requirements: [electrical], assigneeIds: [], holdings: [], days, today }),
    ).toEqual([]);
  });

  it('asks again only for gaps a change opens', () => {
    const elecGap = { qualificationTypeId: 'elec', name: 'E', people: [] };
    const gasGap = { qualificationTypeId: 'gas', name: 'G', people: [] };
    expect(newGaps([elecGap], [elecGap])).toEqual([]);
    expect(newGaps([elecGap], [elecGap, gasGap])).toEqual([gasGap]);
  });
});

describe('expiry state', () => {
  it('warns within the warning period and not before', () => {
    expect(expiryState(null, today, 30)).toBe('no_expiry');
    expect(expiryState('2026-11-26', today, 30)).toBe('expiring');
    expect(expiryState('2026-11-27', today, 30)).toBe('valid');
    expect(expiryState('2026-10-26', today, 30)).toBe('expired');
    expect(expiryState('2026-10-27', today, 30)).toBe('expiring');
  });
});

describe('ranking people', () => {
  it('counts the requirements a person meets', () => {
    const result = requirementsMet('ahmed', [electrical, gas], [holding()], days, today);
    expect(result.met).toBe(1);
    expect(result.statuses).toEqual([
      { qualificationTypeId: 'elec', status: 'valid' },
      { qualificationTypeId: 'gas', status: 'missing' },
    ]);
  });
});
