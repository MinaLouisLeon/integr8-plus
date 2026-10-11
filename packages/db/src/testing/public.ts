import { connectAsOwner, requireDisposableDatabase } from './harness.js';

/**
 * Test helpers other packages' suites may use — `@integr8/db/testing`.
 *
 * Only what a test outside this package genuinely cannot do through a
 * repository, and every one of them refuses to run unless the database is
 * explicitly marked disposable. Application code has no reason to import this,
 * and the lint rule banning raw database access still applies to everything
 * that does not.
 */

export { requireDisposableDatabase };

/** The template library, as `db:templates` loads it — suites that exercise templates load it first. */
export { syncFormTemplates } from '../seed/templates.js';

/** The tables whose raw rows a suite may read. A closed list, so no name reaches SQL unchecked. */
const READABLE = ['submissions', 'form_versions', 'forms', 'audit_log'] as const;
export type ReadableTable = (typeof READABLE)[number];

/**
 * One row exactly as Postgres holds it, as JSON text.
 *
 * For claims about bytes — "republishing leaves every existing submission
 * byte-identical" — a repository read is not enough: it parses, maps and
 * re-serialises, and would hide a change a mapping happened to paper over.
 */
export async function rowAsText(table: ReadableTable, id: string): Promise<string | undefined> {
  if (!READABLE.includes(table)) {
    throw new Error(`rowAsText cannot read ${String(table)}`);
  }
  requireDisposableDatabase();

  const client = await connectAsOwner();
  try {
    const result = await client.query<{ row: string }>(
      `select row_to_json(t)::text as row from ${table} t where t.id = $1`,
      [id],
    );
    return result.rows[0]?.row;
  } finally {
    await client.end();
  }
}

/**
 * Moves an invitation's expiry into the past, as if a week had gone by.
 *
 * An invitation lasts seven days, and "it expired while the company was being
 * set up" is a real case a suite has to reach without waiting a week. No
 * repository sets an expiry after the fact, deliberately, so this is the one
 * way to do it.
 */
export async function expireInvitation(invitationId: string): Promise<void> {
  requireDisposableDatabase();
  const client = await connectAsOwner();
  try {
    await client.query(
      // Both dates move: the table requires an invitation to expire after it
      // was created, so this is the invitation as it was made eight days ago.
      `update invitations
          set created_at = now() - interval '8 days',
              expires_at = now() - interval '1 day'
        where id = $1`,
      [invitationId],
    );
  } finally {
    await client.end();
  }
}
