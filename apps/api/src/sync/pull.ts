import { can, type Principal } from '@integr8/core';
import type { Submission, TenantTransaction } from '@integr8/db';
import { unprocessable } from '../http/errors.js';
import { customerDetailBody } from '../routes/v1/customers.js';
import { formDetailBody } from '../routes/v1/forms.js';
import { peopleOf } from '../routes/v1/operations.js';
import { mayRead } from '../routes/v1/submissions.js';
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
  options: { cursor?: string; page?: string; retentionDays: number; now: Date },
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
  const manage = can(principal.role, 'form.manage');
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
  };
}
