import type { WorkOrderState } from '@integr8/core';
import { describe, expect, it } from 'vitest';
import type { Timesheet } from './api.js';
import { summarizeTimesheet } from './timesheets.js';

const SAM = { id: '00000000-0000-4000-8000-000000000501', name: 'Sam Carter' };
const ALEX = { id: '00000000-0000-4000-8000-000000000502', name: 'Alex Moore' };
const JOB = '00000000-0000-4000-8000-000000000521';
const window = {
  from: new Date(2026, 8, 14),
  to: new Date(2026, 8, 21),
};
const at = (day: number, hours: number, minutes = 0) =>
  new Date(2026, 8, 14 + day, hours, minutes).toISOString();
const move = (
  actor: { id: string },
  fromState: WorkOrderState,
  toState: WorkOrderState,
  occurredAt: string,
) => ({
  workOrderId: JOB,
  fromState,
  toState,
  actorId: actor.id,
  occurredAt,
  recordedAt: occurredAt,
});

function sheet(changes: Timesheet['changes'], crew: string[]): Timesheet {
  return {
    people: [SAM, ALEX],
    shifts: [],
    changes,
    workOrders: [{ id: JOB, referenceLabel: 'WO-000521', title: 'Boiler swap', state: 'complete' }],
    crews: crew.map((userId) => ({ workOrderId: JOB, userId })),
    truncated: false,
  };
}

describe('a timesheet', () => {
  it('counts a crew’s job for everyone on it, whoever tapped each step', () => {
    const people = summarizeTimesheet(
      sheet(
        [
          move(SAM, 'dispatched', 'travelling', at(0, 8)),
          move(SAM, 'travelling', 'on_site', at(0, 8, 30)),
          move(ALEX, 'on_site', 'in_progress', at(0, 8, 40)),
          move(ALEX, 'in_progress', 'complete', at(0, 11, 40)),
        ],
        [SAM.id, ALEX.id],
      ),
      window,
      new Date(2026, 8, 18),
    );
    expect(people.map((person) => [person.person.name, person.totals])).toEqual([
      [
        'Alex Moore',
        { shiftMs: 0, travelMs: 30 * 60_000, onSiteMs: 10 * 60_000, workMs: 3 * 3_600_000 },
      ],
      [
        'Sam Carter',
        { shiftMs: 0, travelMs: 30 * 60_000, onSiteMs: 10 * 60_000, workMs: 3 * 3_600_000 },
      ],
    ]);
  });

  it('counts a job already under way from the start of the week, not from before it', () => {
    const [sam] = summarizeTimesheet(
      sheet(
        [
          // Started on Friday afternoon, finished just after midnight on Monday: only Monday's hour counts.
          move(SAM, 'on_site', 'in_progress', at(-3, 15)),
          move(SAM, 'in_progress', 'complete', at(0, 1)),
        ],
        [SAM.id],
      ),
      window,
      new Date(2026, 8, 18),
    );
    expect(sam?.totals.workMs).toBe(60 * 60_000);
    expect(sam?.days[0]?.day).toEqual(window.from);
  });
});
