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

/**
 * Makes the database refuse any new job whose title contains `marker`, until
 * the returned function is called.
 *
 * A maintenance plan failing is the case the worker must survive (0063), and
 * the ways it fails in production — a constraint added later, a trigger that
 * refuses — are exactly the ones no repository can be asked to produce. The
 * marker reaches SQL only as a quoted literal (`%L`).
 */
export async function refuseJobsTitled(marker: string): Promise<() => Promise<void>> {
  requireDisposableDatabase();
  const client = await connectAsOwner();
  try {
    await client.query(`select set_config('integr8.test_marker', $1, false)`, [marker]);
    await client.query(`
      do $outer$
      begin
        execute format($f$
          create or replace function test_refuse_job_title() returns trigger
          language plpgsql as $body$
          begin
            if strpos(new.title, %L) > 0 then
              raise exception 'test: this job is refused' using errcode = 'check_violation';
            end if;
            return new;
          end;
          $body$$f$, current_setting('integr8.test_marker'));
      end;
      $outer$`);
    await client.query(`drop trigger if exists test_refuse_job_title on work_orders`);
    await client.query(`create trigger test_refuse_job_title before insert on work_orders
      for each row execute function test_refuse_job_title()`);
  } finally {
    await client.end();
  }
  return async () => {
    const cleanup = await connectAsOwner();
    try {
      await cleanup.query(`drop trigger if exists test_refuse_job_title on work_orders`);
      await cleanup.query(`drop function if exists test_refuse_job_title()`);
    } finally {
      await cleanup.end();
    }
  };
}

/**
 * A made-up company with every main table filled, for a suite that moves one
 * between servers (P41). Returns its id.
 */
export async function makeVolumeCompany(scale = 0.005): Promise<string> {
  const { adminUrl } = requireDisposableDatabase();
  const { generateVolume } = await import('../volume/generate.js');
  const [report] = await generateVolume(adminUrl, { companies: 1, years: 1, scale });
  const client = await connectAsOwner();
  try {
    const row = await client.query<{ id: string }>('select id from tenants where slug = $1', [
      report?.slug,
    ]);
    return row.rows[0]?.id ?? '';
  } finally {
    await client.end();
  }
}

/** One fingerprint per company table: equal fingerprints mean byte-identical rows. */
export async function companyFingerprints(tenantId: string): Promise<Record<string, string>> {
  const client = await connectAsOwner();
  try {
    const { transferTables } = await import('../transfer/tables.js');
    const out: Record<string, string> = {};
    for (const table of await transferTables(client)) {
      const column = table.name === 'tenants' ? 'id' : 'tenant_id';
      const result = await client.query<{ sum: string }>(
        `select md5(coalesce(string_agg(to_jsonb(x)::text, '' order by to_jsonb(x)::text), '')) as sum
           from "${table.name}" x where "${column}" = $1`,
        [tenantId],
      );
      out[table.name] = result.rows[0]?.sum ?? '';
    }
    return out;
  } finally {
    await client.end();
  }
}

/** Purges a company at once, as the scheduled purge would after its cooling-off. */
export async function purgeCompanyNow(tenantId: string): Promise<void> {
  const client = await connectAsOwner();
  try {
    const exported = await client.query<{ id: string }>(
      `insert into tenant_exports (tenant_id, tenant_slug, status, object_key)
       values ($1, 'purged-by-suite', 'ready', 'exports/suite.tar.gz') returning id`,
      [tenantId],
    );
    await client.query(
      `insert into tenant_deletions (tenant_id, tenant_slug, export_id, reason, purge_after)
       values ($1, 'purged-by-suite', $2, 'Purged by a suite', now() - interval '1 minute')`,
      [tenantId, exported.rows[0]?.id],
    );
    await client.query('select purge_tenant($1)', [tenantId]);
  } finally {
    await client.end();
  }
}
