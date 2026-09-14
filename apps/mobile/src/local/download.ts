import { ApiRequestError, type Integr8Client } from '@integr8/api-client';
import { CLOSED_WORK_ORDER_STATES, WORK_ORDER_STATES } from '@integr8/core';
import type { CustomerDetail, FormDetail, WorkOrderDetail, WorkOrderSummary } from './api-types';
import type { LocalDatabase } from './database';
import { evict, type EvictionOutcome, RETENTION, type RetentionPolicy } from './eviction';
import { identity } from './queries';
import { applySnapshot } from './snapshot';

/**
 * "Download my work": the one-way stand-in for sync until P12.
 *
 * It asks the API for the engineer's open jobs and the ones they closed within
 * the retention window, then each job's detail, its customers and its forms,
 * and writes the lot in **one transaction** — a download that loses signal
 * half-way changes nothing, rather than leaving a job without its site.
 *
 * Screens never call this and never wait for it. They show what is on the
 * phone, and change when a download commits.
 */

const OPEN_STATES = WORK_ORDER_STATES.filter((state) => !CLOSED_WORK_ORDER_STATES.includes(state));

export class IdentityChangedError extends Error {
  constructor() {
    super('The phone holds another person’s or another company’s work.');
    this.name = 'IdentityChangedError';
  }
}

export interface DownloadOptions {
  now?: Date;
  /** Requests at once. Four is gentle on a phone's connection and on the API. */
  concurrency?: number;
  policy?: RetentionPolicy;
}

export interface DownloadOutcome {
  workOrders: number;
  customers: number;
  forms: number;
  removedWorkOrders: number;
  evicted: EvictionOutcome;
}

export async function downloadWork(
  client: Integr8Client,
  db: LocalDatabase,
  options: DownloadOptions = {},
): Promise<DownloadOutcome> {
  const now = options.now ?? new Date();
  const concurrency = options.concurrency ?? 4;
  const policy = options.policy ?? RETENTION;

  const me = (await client.GET('/v1/me')).data!;
  const stored = await db.read(identity);
  if (stored !== undefined && (stored.tenantId !== me.tenantId || stored.userId !== me.userId)) {
    // Mixing two people's work in one database is never right. The caller wipes
    // the phone and downloads again.
    throw new IdentityChangedError();
  }

  const closedSince = new Date(now.getTime() - policy.closedJobDays * 24 * 60 * 60 * 1000);
  const summaries = [
    // Every state that is not closed, scheduled included: tomorrow's job is work too.
    ...(await everyPage(client, { state: OPEN_STATES })),
    ...(await everyPage(client, { closedSince: closedSince.toISOString() })),
  ];
  const ids = [...new Set(summaries.map((summary) => summary.id))];

  const workOrders = (
    await mapLimit(ids, concurrency, (workOrderId) =>
      unlessGone(async () => {
        const { data } = await client.GET('/v1/work-orders/{workOrderId}', {
          params: { path: { workOrderId } },
        });
        return data!;
      }),
    )
  ).filter((detail): detail is WorkOrderDetail => detail !== undefined);

  const customerIds = [...new Set(workOrders.map((detail) => detail.customer.id))];
  const customers = (
    await mapLimit(customerIds, concurrency, (customerId) =>
      unlessGone(async () => {
        const { data } = await client.GET('/v1/customers/{customerId}', {
          params: { path: { customerId }, query: {} },
        });
        return data!;
      }),
    )
  ).filter((detail): detail is CustomerDetail => detail !== undefined);

  const formIds = [
    ...new Set(workOrders.flatMap((detail) => detail.forms.map((form) => form.formId))),
  ];
  const forms = (
    await mapLimit(formIds, concurrency, (formId) =>
      unlessGone(async () => {
        const { data } = await client.GET('/v1/forms/{formId}', {
          params: { path: { formId } },
        });
        return data!;
      }),
    )
  ).filter((detail): detail is FormDetail => detail !== undefined);

  const written = await db.write(
    ['meta', 'customers', 'sites', 'work_orders', 'forms', 'form_versions', 'files'],
    async (sql) => {
      const applied = await applySnapshot(sql, { me, workOrders, customers, forms }, now);
      const evicted = await evict(sql, now, policy);
      return { ...applied, evicted };
    },
  );

  return {
    workOrders: workOrders.length,
    customers: customers.length,
    forms: forms.length,
    removedWorkOrders: written.removedWorkOrders,
    evicted: written.evicted,
  };
}

async function everyPage(
  client: Integr8Client,
  filters: { state?: WorkOrderSummary['state'][]; closedSince?: string },
): Promise<WorkOrderSummary[]> {
  const items: WorkOrderSummary[] = [];
  let cursor: string | undefined;
  // A hard stop, so a server that keeps returning a cursor cannot keep a phone busy forever.
  for (let page = 0; page < 50; page += 1) {
    const { data } = await client.GET('/v1/work-orders', {
      params: {
        query: {
          assigneeId: 'me',
          order: 'due',
          limit: 200,
          ...filters,
          ...(cursor === undefined ? {} : { cursor }),
        },
      },
    });
    items.push(...data!.items);
    if (data!.nextCursor === null) {
      break;
    }
    cursor = data!.nextCursor;
  }
  return items;
}

/** A job reassigned, or a form unpublished, between the list and the detail is skipped, not fatal. */
async function unlessGone<T>(request: () => Promise<T>): Promise<T | undefined> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof ApiRequestError && (error.status === 404 || error.status === 403)) {
      return undefined;
    }
    throw error;
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
