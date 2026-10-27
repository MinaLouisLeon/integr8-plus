import { describe, expect, it } from 'vitest';
import { listDeadline, liveDeadlines } from './job-terms';

const deadlines = (response: { dueAt: string; metAt?: string | null; state?: string } | null) => ({
  priority: 'urgent' as const,
  clock: 'always' as const,
  warnMinutes: 30,
  response:
    response === null
      ? null
      : {
          dueAt: response.dueAt,
          metAt: response.metAt ?? null,
          state: (response.state ?? 'running') as 'running',
          missedAt: null,
        },
  completion: {
    dueAt: '2026-11-02T18:00:00.000Z',
    metAt: null,
    state: 'running' as const,
    missedAt: null,
  },
});

describe('a job’s deadlines on the phone', () => {
  const at = (time: string) => new Date(`2026-11-02T${time}:00.000Z`);

  it('works a running deadline out again against the phone’s clock', () => {
    const due = deadlines({ dueAt: '2026-11-02T12:00:00.000Z' });
    expect(liveDeadlines(due, at('10:00')).map((entry) => entry.state)).toEqual([
      'running',
      'running',
    ]);
    expect(liveDeadlines(due, at('11:45'))[0]?.state).toBe('warning');
    expect(liveDeadlines(due, at('12:30'))[0]?.state).toBe('missed');
  });

  it('keeps one the server already settled', () => {
    const met = deadlines({
      dueAt: '2026-11-02T12:00:00.000Z',
      metAt: '2026-11-02T11:00:00.000Z',
      state: 'met',
    });
    expect(liveDeadlines(met, at('13:00'))[0]?.state).toBe('met');
  });

  it('shows the next open one in a list, or else the last one missed', () => {
    expect(listDeadline(deadlines({ dueAt: '2026-11-02T12:00:00.000Z' }), at('10:00'))?.kind).toBe(
      'response',
    );
    expect(
      listDeadline(
        deadlines({
          dueAt: '2026-11-02T12:00:00.000Z',
          metAt: '2026-11-02T11:00:00.000Z',
          state: 'met',
        }),
        at('13:00'),
      )?.kind,
    ).toBe('completion');
    expect(listDeadline(null, at('10:00'))).toBeUndefined();
  });
});
