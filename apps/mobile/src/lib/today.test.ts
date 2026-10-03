import type { JobListItem } from '@integr8/offline';
import { describe, expect, it } from 'vitest';
import { navigationLinks } from './navigation';
import { dayJobs, hoursAndMinutes, jobSteps, nextJob } from './today';

const now = new Date('2026-09-15T08:00:00');

let counter = 0;
function job(overrides: Partial<JobListItem>): JobListItem {
  counter += 1;
  return {
    id: `job-${String(counter)}`,
    referenceLabel: `WO-${String(counter).padStart(6, '0')}`,
    title: 'Boiler service',
    state: 'dispatched',
    priority: 'normal',
    customerName: 'Mrs Patel',
    siteName: 'Home',
    siteAddress: '1 High Street',
    dueFrom: null,
    dueBy: null,
    closedAt: null,
    hazards: false,
    ...overrides,
  };
}

describe('the engineer’s day', () => {
  it('puts the job they are on first, whatever its date', () => {
    const first = job({ dueBy: '2026-09-15T09:00:00' });
    const onSite = job({ state: 'on_site', dueBy: '2026-09-18T09:00:00' });
    expect(nextJob([first, onSite], now)?.id).toBe(onSite.id);
  });

  it('otherwise the first of the day that is theirs to start', () => {
    const overdueScheduled = job({ state: 'scheduled', dueBy: '2026-09-14T17:00:00' });
    const today = job({ dueFrom: '2026-09-15T10:00:00', dueBy: '2026-09-15T12:00:00' });
    const tomorrow = job({ dueBy: '2026-09-16T12:00:00' });
    expect(dayJobs([overdueScheduled, today, tomorrow], now).map((item) => item.id)).toEqual([
      overdueScheduled.id,
      today.id,
    ]);
    expect(nextJob([overdueScheduled, today, tomorrow], now)?.id).toBe(today.id);
    expect(nextJob([tomorrow], now)).toBeUndefined();
  });

  it('offers only the engineer’s own steps, the usual one first', () => {
    expect(jobSteps('dispatched')).toEqual({ primary: 'travelling', others: ['on_site'] });
    expect(jobSteps('travelling')).toEqual({ primary: 'on_site', others: ['dispatched'] });
    expect(jobSteps('in_progress')).toEqual({ primary: 'complete', others: ['awaiting_parts'] });
    // Reviewing and rescheduling are the office's.
    expect(jobSteps('complete')).toEqual({ primary: undefined, others: [] });
    expect(jobSteps('scheduled')).toEqual({ primary: undefined, others: [] });
  });

  it('rounds spans down to the minute', () => {
    expect(hoursAndMinutes(2 * 3_600_000 + 5 * 60_000 + 59_000)).toEqual({ hours: 2, minutes: 5 });
    expect(hoursAndMinutes(-1)).toEqual({ hours: 0, minutes: 0 });
  });
});

describe('directions', () => {
  it('uses coordinates when the site has them, the address when not', () => {
    const at = { label: 'Unit 4', address: '4 Mill Lane, Leeds', location: null };
    expect(navigationLinks('android', at)[0]).toBe(
      'google.navigation:q=4%20Mill%20Lane%2C%20Leeds&mode=d',
    );
    const pinned = { ...at, location: { latitude: 53.8, longitude: -1.55 } };
    expect(navigationLinks('ios', pinned)).toEqual([
      'comgooglemaps://?daddr=53.8,-1.55&directionsmode=driving',
      'maps://?daddr=53.8,-1.55&dirflg=d',
      'https://maps.apple.com/?daddr=53.8,-1.55&dirflg=d',
    ]);
    expect(navigationLinks('android', pinned)[1]).toBe('geo:53.8,-1.55?q=53.8,-1.55(Unit%204)');
  });
});
