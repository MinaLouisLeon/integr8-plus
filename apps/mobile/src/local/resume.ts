import type { LocalDatabase } from '@integr8/offline';

/**
 * Where the engineer was (P14). A phone killed in a pocket, or an app closed
 * from the switcher, opens again on the same screen — the same job, the same
 * form, the same page — not on the job list.
 *
 * Kept in the phone's encrypted database, so it goes with everything else when
 * the phone is wiped, and forgotten after a while: yesterday's job is not where
 * anybody expects to land in the morning.
 */

const KEY = 'resume_route';
export const RESUME_WITHIN_MS = 12 * 60 * 60_000;

export interface SavedRoute {
  pathname: string;
  params: Record<string, string>;
  savedAt: string;
}

const PASSING_THROUGH = ['/', '/sign-in'];

/** Screens that are worth returning to: anything but the way in. Going home forgets the last one. */
export function worthResuming(pathname: string): boolean {
  return !['/', '/sign-in', '/home'].includes(pathname);
}

export async function saveRoute(
  db: LocalDatabase,
  pathname: string,
  params: Record<string, string>,
  now = new Date(),
): Promise<void> {
  // The launch screen and signing in pass through on the way to where the engineer
  // was; recording them would forget it before it could be read.
  if (PASSING_THROUGH.includes(pathname)) {
    return;
  }
  const value: SavedRoute | null = worthResuming(pathname)
    ? { pathname, params, savedAt: now.toISOString() }
    : null;
  await db.write(['meta'], (sql) =>
    value === null
      ? sql.run('delete from meta where key = ?', [KEY])
      : sql.run(
          `insert into meta (key, value) values (?, ?)
           on conflict (key) do update set value = excluded.value`,
          [KEY, JSON.stringify(value)],
        ),
  );
}

export async function savedRoute(
  db: LocalDatabase,
  now = new Date(),
): Promise<SavedRoute | undefined> {
  const row = await db.read((sql) =>
    sql.get<{ value: string }>('select value from meta where key = ?', [KEY]),
  );
  if (row === undefined) {
    return undefined;
  }
  const saved = JSON.parse(row.value) as SavedRoute;
  return now.getTime() - new Date(saved.savedAt).getTime() <= RESUME_WITHIN_MS &&
    worthResuming(saved.pathname)
    ? saved
    : undefined;
}

/**
 * The link back to a saved screen: its path, and as a query whatever else it
 * was opened with (a form's page), leaving out what the path already says.
 */
export function resumeHref(saved: Pick<SavedRoute, 'pathname' | 'params'>): string {
  const segments = new Set(saved.pathname.split('/').map((segment) => decodeURIComponent(segment)));
  const query = Object.entries(saved.params)
    .filter(([, value]) => !segments.has(value))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return query === '' ? saved.pathname : `${saved.pathname}?${query}`;
}
