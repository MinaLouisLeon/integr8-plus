import { describe, expect, it } from 'vitest';
import type { JobListItem } from './queries';
import { sectionJobs } from './queries';
import { wipeLocalData } from './wipe';

describe('wiping the phone', () => {
  it('closes the database, forgets the key, then deletes the database and the files', async () => {
    const order: string[] = [];
    const outcome = await wipeLocalData({
      closeDatabase: () => Promise.resolve(void order.push('close')),
      forgetKey: () => Promise.resolve(void order.push('key')),
      deleteDatabase: () => Promise.resolve(void order.push('database')),
      deleteFiles: () => Promise.resolve(void order.push('files')),
    });
    expect(order).toEqual(['close', 'key', 'database', 'files']);
    expect(outcome.failures).toEqual([]);
  });

  it('carries on past a failed step and reports it, so the photos are not left behind', async () => {
    const order: string[] = [];
    const outcome = await wipeLocalData({
      closeDatabase: () => Promise.reject(new Error('already closed')),
      forgetKey: () => Promise.resolve(void order.push('key')),
      deleteDatabase: () => Promise.reject(new Error('file locked')),
      deleteFiles: () => Promise.resolve(void order.push('files')),
    });
    expect(order).toEqual(['key', 'files']);
    expect(outcome.failures.map((failure) => failure.step)).toEqual([
      'closeDatabase',
      'deleteDatabase',
    ]);
  });
});

describe('the job list’s sections', () => {
  const item = (id: string, dueFrom: string | null, dueBy: string | null): JobListItem => ({
    id,
    referenceLabel: id,
    title: id,
    state: 'dispatched',
    priority: 'normal',
    customerName: '',
    siteName: '',
    siteAddress: '',
    dueFrom,
    dueBy,
    closedAt: null,
    hazards: false,
  });

  it('splits open jobs into overdue, today, upcoming and unscheduled by the phone’s day', () => {
    const now = new Date(2026, 8, 14, 10, 0);
    const at = (day: number, hour: number) => new Date(2026, 8, day, hour, 0).toISOString();
    const sections = sectionJobs(
      [
        item('late', null, at(14, 9)),
        item('this-afternoon', null, at(14, 17)),
        item('window-starts-today', at(14, 16), at(16, 17)),
        item('tomorrow', null, at(15, 9)),
        item('someday', null, null),
      ],
      now,
    );
    expect({
      overdue: sections.overdue.map((job) => job.id),
      today: sections.today.map((job) => job.id),
      upcoming: sections.upcoming.map((job) => job.id),
      unscheduled: sections.unscheduled.map((job) => job.id),
    }).toEqual({
      overdue: ['late'],
      today: ['this-afternoon', 'window-starts-today'],
      upcoming: ['tomorrow'],
      unscheduled: ['someday'],
    });
  });
});
