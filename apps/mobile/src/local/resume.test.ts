import type { LocalDatabase } from '@integr8/offline';
import { openTestDatabase } from '@integr8/offline/testing';
import { describe, expect, it } from 'vitest';
import { resumeHref, savedRoute, saveRoute, worthResuming } from './resume';

describe('returning to where the engineer was', () => {
  it('links back to the screen with what it was opened with', () => {
    expect(resumeHref({ pathname: '/forms/0192-abc', params: { id: '0192-abc', page: '3' } })).toBe(
      '/forms/0192-abc?page=3',
    );
    expect(resumeHref({ pathname: '/jobs/complete/j1', params: { id: 'j1' } })).toBe(
      '/jobs/complete/j1',
    );
  });

  it('never returns to the way in', () => {
    expect(worthResuming('/sign-in')).toBe(false);
    expect(worthResuming('/home')).toBe(false);
    expect(worthResuming('/jobs/j1')).toBe(true);
  });

  it('survives the launch screen passing through, and is forgotten by going home or with time', async () => {
    const { db } = (await openTestDatabase()) as { db: LocalDatabase };
    const at = new Date('2026-09-15T10:00:00.000Z');
    await saveRoute(db, '/forms/f1', { id: 'f1', page: '2' }, at);
    // Launching again shows '/' first, while the saved screen is being read.
    await saveRoute(db, '/', {}, at);
    expect(await savedRoute(db, at)).toMatchObject({ pathname: '/forms/f1' });
    expect(await savedRoute(db, new Date('2026-09-16T10:00:00.000Z'))).toBeUndefined();
    await saveRoute(db, '/home', {}, at);
    expect(await savedRoute(db, at)).toBeUndefined();
  });
});
