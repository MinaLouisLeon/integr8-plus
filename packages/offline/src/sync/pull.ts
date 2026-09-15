import type { PullPage, SyncSubmission, WorkOrderDetail } from '../api-types.js';
import type { LocalDatabase } from '../database.js';
import { evict, type EvictionOutcome, type RetentionPolicy } from '../eviction.js';
import { identity } from '../queries.js';
import { upsertCustomer, upsertForm, upsertSite, upsertWorkOrder } from '../snapshot.js';
import type { SqlConnection } from '../sql.js';
import { UNSENT_WORK_ORDER_IDS } from '../unsent.js';
import {
  clockOffset,
  type DeviceClock,
  measureOffset,
  saveClockOffset,
  serverNow,
} from './clock.js';
import { type Actor, applyToJob, type LocalChange } from './overlay.js';
import type { SyncApi } from './transport.js';

/**
 * Bringing the phone up to date with the server (P12).
 *
 * Pages are fetched until the server says there are no more, and each is written
 * in its own transaction, so a pull that loses signal half-way keeps what it has
 * and resumes from the same cursor next time — the cursor only moves once the
 * last page is in.
 *
 * Whatever the server says, the engineer's own unsent changes stay on screen:
 * each job written from a pull has the outbox's pending changes applied on top.
 */

export class IdentityChangedError extends Error {
  constructor() {
    super('The phone holds another person’s or another company’s work.');
    this.name = 'IdentityChangedError';
  }
}

export interface PullOutcome {
  pages: number;
  workOrders: number;
  removed: number;
  reset: boolean;
  evicted: EvictionOutcome;
}

const PULL_TABLES = [
  'meta',
  'customers',
  'sites',
  'work_orders',
  'forms',
  'form_versions',
  'submissions',
  'files',
] as const;

/**
 * Re-applies the job's unsent changes to what the server sent. Only changes
 * still on their way: one in conflict or refused is not going to happen as it
 * stands, so the screen shows the server's version, with the change listed apart
 * for the engineer to decide.
 */
async function withPendingChanges(
  sql: SqlConnection,
  detail: WorkOrderDetail,
  actor: Actor,
): Promise<WorkOrderDetail> {
  const pending = await sql.all<{ kind: string; payload: string; recorded_at: string }>(
    `select kind, payload, recorded_at from outbox
     where state = 'pending'
       and kind in ('work_order.transition', 'work_order.checklist', 'work_order.comment', 'site.access')
       and (work_order_id = ? or (kind = 'site.access' and entity_id = ?))
     order by seq`,
    [detail.workOrder.id, detail.site.id],
  );
  return pending.reduce(
    (current, change) =>
      applyToJob(
        current,
        { kind: change.kind, payload: JSON.parse(change.payload) as unknown } as LocalChange,
        actor,
        change.recorded_at,
      ),
    detail,
  );
}

async function writeSubmission(sql: SqlConnection, submission: SyncSubmission, at: string) {
  const unsent = await sql.get<{ n: number }>(
    `select count(*) as n from outbox where entity_id = ? and state <> 'done'`,
    [submission.id],
  );
  if ((unsent?.n ?? 0) > 0) {
    // The engineer's changes are based on what the phone last had; replacing that
    // base now would let their next change quietly overwrite someone else's.
    return;
  }
  await sql.run(
    `insert into submissions (id, form_id, form_version_id, work_order_id, status, answers,
                              server_revision, server_answers, submitted_by, submitted_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (id) do update set
       status = excluded.status, answers = excluded.answers, server_revision = excluded.server_revision,
       server_answers = excluded.server_answers, submitted_by = excluded.submitted_by,
       submitted_at = excluded.submitted_at, updated_at = excluded.updated_at`,
    [
      submission.id,
      submission.formId,
      submission.formVersionId,
      submission.workOrderId,
      submission.status,
      JSON.stringify(submission.answers),
      submission.revision,
      JSON.stringify(submission.answers),
      submission.submittedBy.id,
      submission.submittedAt,
      at,
    ],
  );
}

async function applyPage(
  sql: SqlConnection,
  page: PullPage,
  seen: Set<string>,
  at: string,
): Promise<number> {
  const me = await identity(sql);
  const actor: Actor = { id: me?.userId ?? '', name: me?.displayName ?? '' };

  for (const customer of page.customers) {
    await upsertCustomer(sql, customer, at);
    for (const site of customer.sites) {
      await upsertSite(sql, site, at);
    }
  }
  for (const detail of page.workOrders) {
    seen.add(detail.workOrder.id);
    await upsertWorkOrder(sql, await withPendingChanges(sql, detail, actor), at);
  }
  for (const form of page.forms) {
    await upsertForm(sql, form, at);
  }
  for (const submission of page.submissions) {
    await writeSubmission(sql, submission, at);
  }

  let removed = 0;
  if (page.removedWorkOrderIds.length > 0) {
    removed += (
      await sql.run(
        `delete from work_orders
         where id in (select value from json_each(?)) and id not in (${UNSENT_WORK_ORDER_IDS})`,
        [JSON.stringify(page.removedWorkOrderIds)],
      )
    ).changes;
  }
  return removed;
}

export async function pullChanges(
  db: LocalDatabase,
  api: SyncApi,
  clock: DeviceClock,
  policy: RetentionPolicy,
): Promise<PullOutcome> {
  const outcome: PullOutcome = {
    pages: 0,
    workOrders: 0,
    removed: 0,
    reset: false,
    evicted: { workOrders: 0, customers: 0, sites: 0, forms: 0, formVersions: 0, filePaths: [] },
  };

  const stored = await db.read(async (sql) => {
    const row = await sql.get<{ value: string }>(
      `select value from meta where key = 'sync_cursor'`,
    );
    return { cursor: row?.value, identity: await identity(sql) };
  });

  // The first pull, and any pull from the start, also checks whose phone this is.
  if (stored.cursor === undefined || stored.identity === undefined) {
    const me = await api.me();
    if (
      stored.identity !== undefined &&
      (stored.identity.tenantId !== me.tenantId || stored.identity.userId !== me.userId)
    ) {
      throw new IdentityChangedError();
    }
    await db.write(['meta'], async (sql) => {
      for (const [key, value] of Object.entries({
        tenant_id: me.tenantId,
        user_id: me.userId,
        display_name: me.displayName,
        email: me.email,
        role: me.role,
      })) {
        await sql.run(
          'insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
          [key, value],
        );
      }
    });
  }

  const seen = new Set<string>();
  let page: string | undefined;
  for (let guard = 0; guard < 200; guard += 1) {
    const sentAt = clock.now();
    const response = await api.pull({
      ...(stored.cursor === undefined ? {} : { cursor: stored.cursor }),
      ...(page === undefined ? {} : { page }),
      retentionDays: policy.closedJobDays,
    });
    const receivedAt = clock.now();
    outcome.pages += 1;
    outcome.reset ||= response.reset;
    outcome.workOrders += response.workOrders.length;

    await db.write(PULL_TABLES, async (sql) => {
      await saveClockOffset(sql, measureOffset(response.serverTime, sentAt, receivedAt));
      outcome.removed += await applyPage(sql, response, seen, response.serverTime);

      if (response.cursor !== null) {
        if (response.reset) {
          // Everything in scope has arrived: what the server did not send is not mine any more.
          outcome.removed += (
            await sql.run(
              `delete from work_orders
               where id not in (select value from json_each(?)) and id not in (${UNSENT_WORK_ORDER_IDS})`,
              [JSON.stringify([...seen])],
            )
          ).changes;
        }
        await sql.run(
          `insert into meta (key, value) values ('sync_cursor', ?)
           on conflict (key) do update set value = excluded.value`,
          [response.cursor],
        );
        await sql.run(
          `insert into meta (key, value) values ('last_download_at', ?)
           on conflict (key) do update set value = excluded.value`,
          [response.serverTime],
        );
        const now = serverNow(clock.now(), await clockOffset(sql));
        outcome.evicted = await evict(sql, now, policy);
      }
    });

    if (response.cursor !== null) {
      break;
    }
    page = response.page ?? undefined;
    if (page === undefined) {
      break;
    }
  }
  return outcome;
}

/**
 * Fetches jobs whose shown state may no longer be right: a change to them was
 * refused, conflicted, or dropped by the engineer, so the phone's copy still has
 * it applied. A delta pull would not bring them if nothing changed on the server.
 */
export async function refreshRequested(db: LocalDatabase, api: SyncApi): Promise<number> {
  const requested = await db.read(async (sql) => {
    const row = await sql.get<{ value: string }>(
      `select value from meta where key = 'refresh_work_orders'`,
    );
    return row === undefined ? [] : (JSON.parse(row.value) as string[]);
  });
  let refreshed = 0;
  for (const workOrderId of requested) {
    const detail = await api.workOrder(workOrderId);
    const customer = detail === undefined ? undefined : await api.customer(detail.customer.id);
    await db.write(PULL_TABLES, async (sql) => {
      const at = new Date().toISOString();
      if (customer !== undefined) {
        await upsertCustomer(sql, customer, at);
        for (const site of customer.sites) {
          await upsertSite(sql, site, at);
        }
      }
      if (detail !== undefined) {
        const me = await identity(sql);
        await upsertWorkOrder(
          sql,
          await withPendingChanges(sql, detail, {
            id: me?.userId ?? '',
            name: me?.displayName ?? '',
          }),
          at,
        );
        refreshed += 1;
      }
      const row = await sql.get<{ value: string }>(
        `select value from meta where key = 'refresh_work_orders'`,
      );
      const left = (row === undefined ? [] : (JSON.parse(row.value) as string[])).filter(
        (id) => id !== workOrderId,
      );
      await sql.run(
        `insert into meta (key, value) values ('refresh_work_orders', ?)
         on conflict (key) do update set value = excluded.value`,
        [JSON.stringify(left)],
      );
    });
  }
  return refreshed;
}
