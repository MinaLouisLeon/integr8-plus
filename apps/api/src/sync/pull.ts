import { holds, type Principal } from '@integr8/core';
import type { FormVersion, Shift, Submission, TenantTransaction } from '@integr8/db';
import { unprocessable } from '../http/errors.js';
import { assetsForSites } from '../routes/v1/assets.js';
import { customerDetailBody } from '../routes/v1/customers.js';
import { formDetailBody } from '../routes/v1/forms.js';
import { isFeatureEnabled } from '../http/features.js';
import { availability, itemSummary, reservedAt } from '../routes/v1/inventory.js';
import { peopleOf } from '../routes/v1/operations.js';
import { carryOverFor, mayRead } from '../routes/v1/submissions.js';
import { detailBody } from '../routes/v1/work-orders.js';

/**
 * What changed for this person since their phone last asked (P12).
 *
 * The cursor is a transaction id. A pull reads the change log up to the oldest
 * transaction still running and hands that back as the next cursor, so a slow
 * transaction that commits after a faster, later one is caught next time rather
 * than skipped (see `SyncRepository`). With no cursor, or one older than the
 * pruned log, it returns everything in scope and says so (`reset`), and the phone
 * replaces what it holds.
 *
 * A page holds up to {@link PAGE_SIZE} jobs, each with everything the phone shows
 * for it: the job, its customer and sites, its forms' live versions and this
 * person's submissions for it. Later pages share the first page's horizon, so a
 * pull spread over several requests is still one consistent window.
 */

const PAGE_SIZE = 25;

interface PageToken {
  since: string | null;
  horizon: string;
  after: string;
  reset: boolean;
}

export function encodeCursor(horizon: string): string {
  return `v1.${horizon}`;
}

export function decodeCursor(cursor: string): string {
  const match = /^v1\.(\d{1,20})$/u.exec(cursor);
  if (match === null) {
    throw unprocessable('cursor_invalid', 'This sync cursor is not one the server issued.', [
      { field: 'query.cursor', code: 'cursor_invalid', message: 'Pull again without a cursor.' },
    ]);
  }
  return match[1]!;
}

function encodePage(token: PageToken): string {
  return Buffer.from(JSON.stringify(token), 'utf8').toString('base64url');
}

function decodePage(page: string): PageToken {
  try {
    const token = JSON.parse(Buffer.from(page, 'base64url').toString('utf8')) as PageToken;
    if (
      typeof token.horizon === 'string' &&
      /^\d{1,20}$/u.test(token.horizon) &&
      (token.since === null || /^\d{1,20}$/u.test(token.since)) &&
      typeof token.after === 'string' &&
      typeof token.reset === 'boolean'
    ) {
      return token;
    }
  } catch {
    // Fall through to the refusal.
  }
  throw unprocessable('page_invalid', 'This page token is not one the server issued.', [
    { field: 'query.page', code: 'page_invalid', message: 'Pull again from the cursor.' },
  ]);
}

export function submissionSyncBody(submission: Submission, people: Map<string, string>) {
  return {
    id: submission.id,
    formId: submission.formId,
    formVersionId: submission.formVersionId,
    workOrderId: submission.workOrderId,
    status: submission.status,
    revision: submission.revision,
    answers: submission.answers,
    submittedBy: { id: submission.submittedBy, name: people.get(submission.submittedBy) ?? '' },
    submittedAt: submission.submittedAt?.toISOString() ?? null,
    updatedAt: submission.updatedAt.toISOString(),
  };
}

export async function pullPage(
  tx: TenantTransaction,
  principal: Principal,
  options: {
    cursor?: string;
    page?: string;
    retentionDays: number;
    now: Date;
    /** Where the web app lives, for the asset tag links the phone shows. */
    webAppUrl?: string | undefined;
  },
) {
  let token: Omit<PageToken, 'after'> & { after?: string };
  if (options.page !== undefined) {
    token = decodePage(options.page);
  } else {
    const horizon = await tx.sync.horizon();
    let since = options.cursor === undefined ? null : decodeCursor(options.cursor);
    if (since !== null) {
      const pruned = await tx.sync.prunedBefore();
      if (pruned !== undefined && BigInt(pruned) >= BigInt(since)) {
        since = null;
      }
    }
    token = { since, horizon, reset: since === null };
  }

  const closedSince = new Date(options.now.getTime() - options.retentionDays * 24 * 60 * 60 * 1000);
  const changed = await tx.sync.changedWorkOrderIds({
    userId: principal.userId,
    closedSince,
    since: token.since,
    horizon: token.horizon,
    ...(token.after === undefined ? {} : { after: token.after }),
    limit: PAGE_SIZE,
  });
  // Removals are worked out once, with the first page.
  const removedWorkOrderIds =
    options.page === undefined && token.since !== null
      ? await tx.sync.removedWorkOrderIds({
          userId: principal.userId,
          since: token.since,
          horizon: token.horizon,
        })
      : [];

  const jobs = await tx.workOrders.findMany(changed.ids);
  const workOrders = await Promise.all(jobs.map((job) => detailBody(tx, principal, job)));

  const customerIds = [...new Set(jobs.map((job) => job.customerId))];
  const customers = await Promise.all(
    (await tx.customers.findMany(customerIds)).map((customer) =>
      customerDetailBody(tx, principal, customer),
    ),
  );

  const formIds = [
    ...new Set(workOrders.flatMap((detail) => detail.forms.map((form) => form.formId))),
  ];
  const manage = holds(principal, 'form.manage');
  const forms = (
    await Promise.all(
      formIds.map(async (formId) => {
        const form = await tx.forms.findForm(formId);
        return form === undefined ? undefined : formDetailBody(tx, manage, form);
      }),
    )
  ).filter((detail) => detail !== undefined);

  const people = await peopleOf(tx);
  const submissions = (
    await Promise.all(
      changed.ids.map(
        async (workOrderId) =>
          (await tx.submissions.list({ workOrderId, order: 'updated', limit: 200 })).items,
      ),
    )
  )
    .flat()
    .filter((submission) => mayRead(principal, submission))
    .map((submission) => submissionSyncBody(submission, people));

  // The caller's recent shifts, with the first page: small, and the phone keeps
  // whether it is clocked in even if it was reinstalled or clocked in elsewhere.
  const shifts =
    options.page === undefined
      ? await tx.shifts.list({
          from: new Date(options.now.getTime() - 36 * 60 * 60 * 1000),
          to: new Date(options.now.getTime() + 60 * 60 * 1000),
          userId: principal.userId,
        })
      : [];

  // The caller's van and what it holds (CRM/ERP plan, phase E2), with the first
  // page: the phone's parts picker works offline from it.
  const vanStock = options.page === undefined ? await vanStockBody(tx, principal) : null;

  // The assets of the sites of these jobs, each with its whole history
  // (CRM/ERP plan, phase E3; ADR-0008): a tag scanned with no signal opens
  // from the phone. `assetSiteIds` says which sites' assets are complete here,
  // so the phone replaces exactly those.
  const assetSiteIds = (await isFeatureEnabled(principal.tenantId, 'assets'))
    ? [...new Set(jobs.map((job) => job.siteId))]
    : [];
  const assets = await withCarryOver(
    tx,
    await assetsForSites(tx, principal, options.webAppUrl, assetSiteIds),
  );

  const last = changed.ids.at(-1);
  return {
    reset: token.reset,
    cursor: changed.more ? null : encodeCursor(token.horizon),
    page:
      changed.more && last !== undefined
        ? encodePage({
            since: token.since,
            horizon: token.horizon,
            reset: token.reset,
            after: last,
          })
        : null,
    serverTime: new Date().toISOString(),
    workOrders,
    removedWorkOrderIds,
    customers,
    forms,
    submissions,
    shifts: shifts.map(shiftBody),
    vanStock,
    assetSiteIds: holdsAssets(principal) ? assetSiteIds : [],
    assets,
    expenseCategories:
      options.page === undefined &&
      holds(principal, 'expense.submit') &&
      (await isFeatureEnabled(principal.tenantId, 'hr'))
        ? (await tx.hrExpenses.categories()).map((category) => ({
            id: category.id,
            name: category.name,
          }))
        : null,
  };
}

/**
 * For each asset, what a form started for it on the phone would carry over
 * (ADR-0008): per form it has been filled on, the marked answers of its last
 * submission moved onto the form's current version. The phone uses one only
 * while its own copy of the form is that version.
 */
async function withCarryOver(
  tx: TenantTransaction,
  assets: Awaited<ReturnType<typeof assetsForSites>>,
) {
  const latest = new Map<string, Promise<FormVersion | undefined>>();
  const versionOf = (formId: string) => {
    let found = latest.get(formId);
    if (found === undefined) {
      found = tx.forms.findLatestPublished(formId);
      latest.set(formId, found);
    }
    return found;
  };
  const result = [];
  for (const entry of assets) {
    const formIds = new Set(
      entry.timeline.flatMap((item) =>
        item.kind === 'submission' ? [item.submission.form.id] : [],
      ),
    );
    const carryOver = [];
    for (const formId of formIds) {
      const version = await versionOf(formId);
      const carry =
        version === undefined ? undefined : await carryOverFor(tx, entry.asset.id, version);
      if (version !== undefined && carry !== undefined) {
        carryOver.push({
          formId,
          formVersionId: version.id,
          fromSubmissionId: carry.carriedOver.fromSubmissionId,
          fields: carry.carriedOver.fields,
          answers: carry.answers,
        });
      }
    }
    result.push({ ...entry, carryOver });
  }
  return result;
}

/** The engineer's van and its stock, or an empty answer for a company without the module. */
export async function vanStockBody(tx: TenantTransaction, principal: Principal) {
  if (!(await isFeatureEnabled(principal.tenantId, 'inventory'))) {
    return { location: null, items: [] };
  }
  const van = await tx.inventoryStock.vanOf(principal.userId);
  if (van?.archivedAt !== null) {
    return { location: null, items: [] };
  }
  const balances = await tx.inventoryStock.balances({ locationId: van.id, limit: 2000 });
  const itemIds = balances.map((row) => row.itemId);
  const [found, reserved, images, lotBalances] = await Promise.all([
    tx.inventoryCatalogue.findItems(itemIds),
    reservedAt(tx, { locationId: van.id }),
    tx.attachments.mainImages(itemIds),
    tx.inventoryLots.balances({ locationId: van.id }),
  ]);
  const items = new Map(found.map((item) => [item.id, item]));
  // The van's serial numbers and batches, for picking offline (ADR-0013).
  const lotsHeld = await tx.inventoryLots.find(lotBalances.map((row) => row.lotId));
  const lot = new Map(lotsHeld.map((row) => [row.id, row]));
  const lotsOf = new Map<
    string,
    {
      lotId: string;
      kind: 'serial' | 'batch';
      code: string;
      expiresOn: string | null;
      onHand: string;
    }[]
  >();
  for (const balance of lotBalances) {
    const found = lot.get(balance.lotId);
    if (found === undefined) {
      continue;
    }
    const list = lotsOf.get(balance.itemId) ?? [];
    list.push({
      lotId: found.id,
      kind: found.kind,
      code: found.code,
      expiresOn: found.expiresOn,
      onHand: balance.onHand,
    });
    lotsOf.set(balance.itemId, list);
  }
  for (const list of lotsOf.values()) {
    // The earliest expiry first, then by code: the order the phone suggests.
    list.sort((a, b) =>
      a.expiresOn === b.expiresOn
        ? a.code.localeCompare(b.code)
        : a.expiresOn === null
          ? 1
          : b.expiresOn === null
            ? -1
            : a.expiresOn.localeCompare(b.expiresOn),
    );
  }
  return {
    location: { id: van.id, name: van.name },
    items: balances.flatMap((row) => {
      const item = items.get(row.itemId);
      return item?.archivedAt !== null
        ? []
        : [
            {
              item: itemSummary(item),
              onHand: row.onHand,
              ...availability(row.onHand, reserved.get(`${row.itemId}:${van.id}`)),
              mainImageFileId: images.get(item.id) ?? null,
              lots: item.tracking === 'none' ? [] : (lotsOf.get(item.id) ?? []),
            },
          ];
    }),
  };
}

export function shiftBody(shift: Shift) {
  return {
    id: shift.id,
    userId: shift.userId,
    startedAt: shift.startedAt.toISOString(),
    endedAt: shift.endedAt?.toISOString() ?? null,
    startLocation: shift.startLocation,
    endLocation: shift.endLocation,
  };
}

const holdsAssets = (principal: Principal) => holds(principal, 'asset.read');
