import type { SqlConnection } from './sql.js';
import { UNSENT_FORM_VERSION_IDS, UNSENT_SITE_IDS, UNSENT_WORK_ORDER_IDS } from './unsent.js';

/**
 * What the phone keeps, and what goes first when it keeps too much.
 *
 * - **Open jobs, always.** They are the work.
 * - **Closed jobs for 30 days after they close.** Long enough to look back at
 *   last month's visit to the same boiler; short enough that three years of
 *   history does not fill the phone.
 * - **Customers, sites and forms while a kept job needs them.**
 * - **Downloaded files up to 500 MB,** least recently opened out first.
 * - **Unsent work, never.** A draft, a file waiting to upload, and anything they
 *   point at stay however old they are. Evicting them would be losing work, not
 *   saving space.
 *
 * Eviction runs inside the download's transaction and after the app starts.
 * It deletes rows here and returns the paths of files to delete, which the
 * caller removes from disk once the transaction has committed — a file deleted
 * before a rollback would leave a row pointing at nothing.
 */

export interface RetentionPolicy {
  closedJobDays: number;
  downloadedFileBytes: number;
}

export const RETENTION: RetentionPolicy = Object.freeze({
  closedJobDays: 30,
  downloadedFileBytes: 500 * 1024 * 1024,
});

export interface EvictionOutcome {
  workOrders: number;
  customers: number;
  sites: number;
  forms: number;
  formVersions: number;
  /** Files whose rows are gone; delete these from disk after the commit. */
  filePaths: string[];
}

/** The forms a kept job lists, read from the job as downloaded. */
const FORMS_OF_KEPT_JOBS = `select json_extract(listed.value, '$.formId')
  from work_orders, json_each(work_orders.data, '$.forms') as listed`;

export async function evict(
  sql: SqlConnection,
  now: Date,
  policy: RetentionPolicy = RETENTION,
): Promise<EvictionOutcome> {
  const cutoff = new Date(now.getTime() - policy.closedJobDays * 24 * 60 * 60 * 1000).toISOString();

  const workOrders = await sql.run(
    `delete from work_orders
     where closed_at is not null and closed_at < ?
       and id not in (${UNSENT_WORK_ORDER_IDS})`,
    [cutoff],
  );

  const customers = await sql.run(
    `delete from customers
     where id not in (select customer_id from work_orders)
       and id not in (select owner_id from files where owner_kind = 'customer' and state = 'pending_upload')
       and id not in (select customer_id from sites where id in (${UNSENT_SITE_IDS}))`,
  );

  const sites = await sql.run(
    `delete from sites where customer_id not in (select id from customers)`,
  );

  const formVersions = await sql.run(
    `delete from form_versions
     where id not in (${UNSENT_FORM_VERSION_IDS})
       and id not in (
         select live_version_id from forms
         where live_version_id is not null and id in (${FORMS_OF_KEPT_JOBS})
       )`,
  );

  const forms = await sql.run(
    `delete from forms
     where id not in (select form_id from form_versions)
       and id not in (${FORMS_OF_KEPT_JOBS})`,
  );

  const orphaned = await sql.all<{ id: string; local_path: string }>(
    `select id, local_path from files
     where state = 'downloaded' and (
          (owner_kind = 'work_order' and owner_id not in (select id from work_orders))
       or (owner_kind = 'customer' and owner_id not in (select id from customers))
       or (owner_kind = 'site' and owner_id not in (select id from sites))
       or (owner_kind = 'draft' and owner_id not in (select id from drafts))
     )`,
  );
  const orphanedIds = new Set(orphaned.map((file) => file.id));

  const downloaded = await sql.all<{ id: string; local_path: string; byte_size: number }>(
    `select id, local_path, byte_size from files
     where state = 'downloaded'
     order by coalesce(last_opened_at, created_at) desc, id`,
  );
  const overBudget: { id: string; local_path: string }[] = [];
  let kept = 0;
  let full = false;
  for (const file of downloaded) {
    if (orphanedIds.has(file.id)) {
      continue;
    }
    // Once a file does not fit, everything opened longer ago goes too, even a
    // small file that would: "least recently opened first" is the rule a person
    // can predict.
    full ||= kept + file.byte_size > policy.downloadedFileBytes;
    if (full) {
      overBudget.push(file);
    } else {
      kept += file.byte_size;
    }
  }

  const evictedFiles = [...orphaned, ...overBudget];
  if (evictedFiles.length > 0) {
    await sql.run(
      `delete from files where state = 'downloaded' and id in (select value from json_each(?))`,
      [JSON.stringify(evictedFiles.map((file) => file.id))],
    );
  }

  return {
    workOrders: workOrders.changes,
    customers: customers.changes,
    sites: sites.changes,
    forms: forms.changes,
    formVersions: formVersions.changes,
    filePaths: evictedFiles.map((file) => file.local_path),
  };
}
