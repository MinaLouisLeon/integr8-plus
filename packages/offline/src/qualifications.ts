import type { PullPage } from './api-types.js';
import type { SqlConnection } from './sql.js';

/**
 * The engineer's own skills and certificates on the phone (P26).
 *
 * They come whole with the first page of every pull, and the phone keeps the
 * last answer, so "My qualifications" opens with no signal. Read only: the
 * office records them.
 */

export type MyQualifications = NonNullable<PullPage['myQualifications']>;
export type MyQualification = MyQualifications['items'][number];

export interface LocalQualifications {
  items: MyQualification[];
  /** Today in the company's time zone when the server last said, which `state` was judged on. */
  today: string | null;
  warningDays: number | null;
  /** When the phone last heard, as the server's time. Null: never. */
  receivedAt: string | null;
}

const ORDER: Record<MyQualification['state'], number> = {
  expired: 0,
  expiring: 1,
  valid: 2,
  no_expiry: 3,
  removed: 4,
};

/** Expired first, then expiring, then the rest by name: what needs doing first. */
export function sortQualifications(items: readonly MyQualification[]): MyQualification[] {
  return [...items].sort(
    (a, b) =>
      ORDER[a.state] - ORDER[b.state] ||
      (a.expiresOn ?? '9999').localeCompare(b.expiresOn ?? '9999') ||
      a.qualificationType.name.localeCompare(b.qualificationType.name),
  );
}

export async function myQualifications(sql: SqlConnection): Promise<LocalQualifications> {
  const row = await sql.get<{ value: string }>(
    `select value from meta where key = 'my_qualifications'`,
  );
  if (row === undefined) {
    return { items: [], today: null, warningDays: null, receivedAt: null };
  }
  const stored = JSON.parse(row.value) as { body: MyQualifications; at: string };
  return {
    items: sortQualifications(stored.body.items),
    today: stored.body.today,
    warningDays: stored.body.settings.warningDays,
    receivedAt: stored.at,
  };
}

/** Keeps what the server last said. A server from before P26 says nothing, and nothing changes. */
export async function saveMyQualifications(
  sql: SqlConnection,
  body: MyQualifications,
  at: string,
): Promise<void> {
  await sql.run(
    `insert into meta (key, value) values ('my_qualifications', ?)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify({ body, at })],
  );
}
