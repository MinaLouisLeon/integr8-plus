import { type DeadlineKind, type DeadlineState, deadlineState } from '@integr8/core';
import type { WorkOrderDetail } from '@integr8/offline';

/**
 * A job's deadlines on the phone (P27), worked out again against the phone's
 * own clock: the job was downloaded a while ago, and a deadline still running
 * then may have passed since. One met, met late or closed stays as the server
 * said.
 */

type Deadlines = NonNullable<WorkOrderDetail['deadlines']>;

export interface LiveDeadline {
  kind: DeadlineKind;
  dueAt: string;
  metAt: string | null;
  state: DeadlineState;
}

const SETTLED: readonly DeadlineState[] = ['met', 'met_late', 'closed'];

export function liveDeadlines(deadlines: Deadlines | null, now: Date): LiveDeadline[] {
  if (deadlines === null) {
    return [];
  }
  const entries: LiveDeadline[] = [];
  for (const kind of ['response', 'completion'] as const) {
    const entry = deadlines[kind];
    if (entry === null) {
      continue;
    }
    entries.push({
      kind,
      dueAt: entry.dueAt,
      metAt: entry.metAt,
      state: SETTLED.includes(entry.state)
        ? entry.state
        : deadlineState({
            dueAt: new Date(entry.dueAt),
            metAt: entry.metAt === null ? null : new Date(entry.metAt),
            closedAt: null,
            warnMinutes: deadlines.warnMinutes,
            now,
          }),
    });
  }
  return entries;
}

/** The deadline a job list should show: the next one open, or the last one missed. */
export function listDeadline(deadlines: Deadlines | null, now: Date): LiveDeadline | undefined {
  const entries = liveDeadlines(deadlines, now);
  return (
    entries.find((entry) => entry.state === 'warning' || entry.state === 'running') ??
    [...entries].reverse().find((entry) => entry.state === 'missed' || entry.state === 'met_late')
  );
}
