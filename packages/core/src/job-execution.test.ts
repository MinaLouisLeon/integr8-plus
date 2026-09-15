import { describe, expect, it } from 'vitest';
import { canComplete, completionMissing, jobTimes, shiftDurationMs } from './job-execution.js';

const facts = (overrides: Partial<Parameters<typeof completionMissing>[0]> = {}) => ({
  forms: [
    { formId: 'a', title: 'Gas safety', required: true, submitted: false },
    { formId: 'b', title: 'Notes', required: false, submitted: false },
    { formId: 'c', title: 'Risk assessment', required: true, submitted: true },
  ],
  photos: { before: { needed: 2, taken: 1 }, after: { needed: 1, taken: 3 } },
  signoff: { required: true, recorded: false },
  ...overrides,
});

describe('what a job still needs before it can be completed', () => {
  it('lists required forms not submitted, photos still to take and a missing sign-off', () => {
    const missing = completionMissing(facts());
    expect(missing).toEqual({
      forms: [{ formId: 'a', title: 'Gas safety' }],
      beforePhotos: 1,
      afterPhotos: 0,
      signoff: true,
    });
    expect(canComplete(missing)).toBe(false);
  });

  it('allows completion once nothing is missing', () => {
    const missing = completionMissing(
      facts({
        forms: [{ formId: 'a', title: 'Gas safety', required: true, submitted: true }],
        photos: { before: { needed: 0, taken: 0 }, after: { needed: 2, taken: 2 } },
        signoff: { required: false, recorded: false },
      }),
    );
    expect(canComplete(missing)).toBe(true);
  });
});

describe('time on a job, from its history', () => {
  const at = (time: string) => `2026-09-15T${time}:00.000Z`;
  const changes = [
    { fromState: 'on_site', toState: 'in_progress', occurredAt: at('09:10') },
    { fromState: 'scheduled', toState: 'dispatched', occurredAt: at('07:00') },
    { fromState: 'dispatched', toState: 'travelling', occurredAt: at('08:30') },
    { fromState: 'travelling', toState: 'on_site', occurredAt: at('09:00') },
    { fromState: 'in_progress', toState: 'awaiting_parts', occurredAt: at('10:00') },
    { fromState: 'awaiting_parts', toState: 'in_progress', occurredAt: at('10:30') },
  ] as const;

  it('adds up travel, arrival, work and waiting, whatever order the history arrives in', () => {
    const times = jobTimes(changes);
    expect(times.travelMs).toBe(30 * 60_000);
    expect(times.onSiteMs).toBe(10 * 60_000);
    expect(times.workMs).toBe(50 * 60_000);
    expect(times.waitingMs).toBe(30 * 60_000);
    expect(times.arrivedAt?.toISOString()).toBe(at('09:00'));
    expect(times.startedAt?.toISOString()).toBe(at('09:10'));
    expect(times.completedAt).toBeUndefined();
  });

  it('counts the stretch in progress up to now, when asked', () => {
    const times = jobTimes(changes, new Date(at('11:00')));
    expect(times.workMs).toBe(80 * 60_000);
  });

  it('records completion and stops counting there', () => {
    const times = jobTimes(
      [...changes, { fromState: 'in_progress', toState: 'complete', occurredAt: at('11:15') }],
      new Date(at('12:00')),
    );
    expect(times.workMs).toBe(95 * 60_000);
    expect(times.completedAt?.toISOString()).toBe(at('11:15'));
  });
});

describe('shifts', () => {
  it('last until they end, or until now while open', () => {
    const now = new Date('2026-09-15T17:00:00.000Z');
    expect(shiftDurationMs({ startedAt: '2026-09-15T08:00:00.000Z', endedAt: null }, now)).toBe(
      9 * 3_600_000,
    );
    expect(
      shiftDurationMs(
        { startedAt: '2026-09-15T08:00:00.000Z', endedAt: '2026-09-15T16:30:00.000Z' },
        now,
      ),
    ).toBe(8.5 * 3_600_000);
  });
});
