import {
  EXPENSE_CLAIM_STATUSES,
  expenseClaimStatusSchema,
  expensePaidViaSchema,
  expenseSettlementSchema,
  formatExpenseReference,
  formatWorkOrderReference,
  holds,
  ledgerAmountSchema,
  parseExpenseReference,
  type Principal,
} from '@integr8/core';
import {
  type ExpenseCategory,
  type ExpenseClaim,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import { conflict, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { isFeatureEnabled } from '../../http/features.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { crmAudit as audit, versionConflict } from './crm-shared.js';
import {
  attachmentBodies,
  attachmentSchema,
  many,
  type People,
  peopleOf,
  personBody,
  personSchema,
  readableWorkOrder,
} from './operations.js';
import { companyToday } from './sales-quotes.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * Staff expense claims (seventh round; ADR-0010).
 *
 * Every member claims, with receipts attached as files; somebody else — an
 * owner, admin or HR manager — approves or rejects, and pays back directly or
 * through the next pay run. Claims are in the company's currency. A claim
 * never changes once submitted: a wrong one is withdrawn and claimed again.
 * Approving and paying back post to the ledger when it is set up.
 */

const TAGS = ['expenses'];
const HR = 'hr' as const;

export const expenseCategorySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** The ledger account an approved claim posts to; the staff expenses account when null. */
  accountId: z.uuid().nullable(),
  archived: z.boolean(),
  version: z.number().int(),
});

export const expenseClaimSchema = z.object({
  id: z.uuid(),
  /** `EX-000123`. */
  reference: z.string(),
  claimant: personSchema,
  category: z.object({ id: z.uuid(), name: z.string() }),
  workOrder: z.object({ id: z.uuid(), reference: z.string() }).nullable(),
  spentOn: z.iso.date(),
  amount: z.string(),
  currency: z.string(),
  description: z.string(),
  status: expenseClaimStatusSchema,
  submittedAt: z.iso.datetime(),
  decidedBy: personSchema.nullable(),
  decidedAt: z.iso.datetime().nullable(),
  rejectReason: z.string().nullable(),
  settleVia: expenseSettlementSchema.nullable(),
  paidVia: expensePaidViaSchema.nullable(),
  paidBy: personSchema.nullable(),
  paidAt: z.iso.datetime().nullable(),
  paymentReference: z.string().nullable(),
  version: z.number().int(),
});

const claimDetailSchema = expenseClaimSchema.extend({
  receipts: z.array(attachmentSchema),
  can: z.object({
    attach: z.boolean(),
    withdraw: z.boolean(),
    decide: z.boolean(),
    pay: z.boolean(),
  }),
});

const claimParams = z.object({ claimId: z.uuid() });
const versionBody = z.object({ expectedVersion: z.number().int().min(1) });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function categoryBody(category: ExpenseCategory): z.infer<typeof expenseCategorySchema> {
  return {
    id: category.id,
    name: category.name,
    accountId: category.accountId,
    archived: category.archivedAt !== null,
    version: category.version,
  };
}

async function claimBodies(
  tx: TenantTransaction,
  claims: readonly ExpenseClaim[],
  people?: People,
): Promise<z.infer<typeof expenseClaimSchema>[]> {
  const [known, categories, jobs] = await Promise.all([
    people === undefined ? peopleOf(tx) : Promise.resolve(people),
    tx.hrExpenses.categories({ includeArchived: true }),
    Promise.all(
      [
        ...new Set(
          claims.flatMap((claim) => (claim.workOrderId === null ? [] : [claim.workOrderId])),
        ),
      ].map((id) => tx.workOrders.find(id)),
    ),
  ]);
  const categoryName = new Map(categories.map((category) => [category.id, category.name]));
  const jobReference = new Map(
    jobs.flatMap((job) =>
      job === undefined ? [] : [[job.id, formatWorkOrderReference(job.reference)] as const],
    ),
  );
  return claims.map((claim) => ({
    id: claim.id,
    reference: formatExpenseReference(claim.reference),
    claimant: personBody(claim.claimantId, known),
    category: { id: claim.categoryId, name: categoryName.get(claim.categoryId) ?? '' },
    workOrder:
      claim.workOrderId === null
        ? null
        : { id: claim.workOrderId, reference: jobReference.get(claim.workOrderId) ?? '' },
    spentOn: claim.spentOn,
    amount: claim.amount,
    currency: claim.currency,
    description: claim.description,
    status: claim.status,
    submittedAt: iso(claim.submittedAt),
    decidedBy: claim.decidedBy === null ? null : personBody(claim.decidedBy, known),
    decidedAt: isoOrNull(claim.decidedAt),
    rejectReason: claim.rejectReason,
    settleVia: claim.settleVia,
    paidVia: claim.paidVia,
    paidBy: claim.paidBy === null ? null : personBody(claim.paidBy, known),
    paidAt: isoOrNull(claim.paidAt),
    paymentReference: claim.paymentReference,
    version: claim.version,
  }));
}

const own = (principal: Principal, claim: ExpenseClaim) => claim.claimantId === principal.userId;

/** A claim this person may read: their own, or any for an approver. */
export async function readableClaim(
  tx: TenantTransaction,
  principal: Principal,
  claimId: string,
  lock = false,
): Promise<ExpenseClaim> {
  const claim = lock ? await tx.hrExpenses.lock(claimId) : await tx.hrExpenses.find(claimId);
  if (claim === undefined || !(own(principal, claim) || holds(principal, 'expense.approve'))) {
    throw notFound('This expense claim does not exist.');
  }
  return claim;
}

/** May this person add or remove receipts on this claim: its claimant while it waits, or an approver. */
export function mayAttachReceipt(principal: Principal, claim: ExpenseClaim): boolean {
  return (
    (own(principal, claim) && claim.status === 'submitted') ||
    (holds(principal, 'expense.approve') && claim.status !== 'withdrawn')
  );
}

async function claimDetail(
  tx: TenantTransaction,
  principal: Principal,
  claim: ExpenseClaim,
): Promise<z.infer<typeof claimDetailSchema>> {
  const people = await peopleOf(tx);
  const [body] = await claimBodies(tx, [claim], people);
  const receipts = await attachmentBodies(
    tx,
    await tx.attachments.list({ expenseClaimId: claim.id }),
    people,
  );
  const approver = holds(principal, 'expense.approve');
  if (body === undefined) {
    throw notFound('This expense claim does not exist.');
  }
  return {
    ...body,
    receipts,
    can: {
      attach: mayAttachReceipt(principal, claim),
      withdraw: own(principal, claim) && claim.status === 'submitted',
      decide: approver && !own(principal, claim) && claim.status === 'submitted',
      pay: approver && claim.status === 'approved' && claim.settleVia === 'direct',
    },
  };
}

function encodeCursor(next: { at: string; id: string } | undefined): string | null {
  return next === undefined
    ? null
    : Buffer.from(JSON.stringify(next), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { at: string; id: string } | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    const parsed = z
      .object({ at: z.iso.datetime(), id: z.uuid() })
      .safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function auditClaim(
  tx: TenantTransaction,
  context: RequestContext,
  action: string,
  claim: ExpenseClaim,
  extra: Record<string, unknown> = {},
) {
  await audit(tx, context, action, 'expense_claim', claim.id, {
    reference: formatExpenseReference(claim.reference),
    amount: claim.amount,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const listExpenseCategoriesRoute = defineRoute({
  method: 'get',
  path: '/v1/expenses/categories',
  operationId: 'listExpenseCategories',
  summary: 'What expenses may be claimed for',
  tags: TAGS,
  security: 'authenticated',
  permission: 'expense.submit',
  feature: HR,
  params: noSchema,
  query: z.object({ archived: z.enum(['true', 'false']).optional() }),
  body: noSchema,
  responses: {
    200: {
      description: 'Categories.',
      schema: z.object({ items: z.array(expenseCategorySchema) }),
    },
  },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const items = await withTenant(principal.tenantId, async (tx) =>
      (
        await tx.hrExpenses.categories({
          includeArchived: query.archived === 'true' && holds(principal, 'expense.approve'),
        })
      ).map(categoryBody),
    );
    return { status: 200, body: { items } };
  },
});

async function checkAccount(tx: TenantTransaction, accountId: string | null | undefined) {
  if (accountId === undefined || accountId === null) {
    return;
  }
  const account = await tx.ledger.account(accountId);
  if (account?.archivedAt !== null || account.type !== 'expense') {
    throw unprocessable('account_not_usable', 'Choose an expense account in use.', [
      {
        field: 'body.accountId',
        code: 'account_not_usable',
        message: 'An expense account in use.',
      },
    ]);
  }
}

export const createExpenseCategoryRoute = defineRoute({
  method: 'post',
  path: '/v1/expenses/categories',
  operationId: 'createExpenseCategory',
  summary: 'Add an expense category',
  description:
    '`accountId`, when given, is an expense account in the ledger (422 `account_not_usable`). 409 `name_taken`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'expense.approve',
  feature: HR,
  params: noSchema,
  query: noSchema,
  body: z.object({
    name: z.string().trim().min(1).max(100),
    accountId: z.uuid().nullable().optional(),
  }),
  responses: {
    201: { description: 'The category.', schema: expenseCategorySchema },
    409: { description: 'Another category has this name.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const created = await withTenant(principal.tenantId, async (tx) => {
      await checkAccount(tx, body.accountId);
      const result = await tx.hrExpenses.createCategory(
        { name: body.name, accountId: body.accountId ?? null },
        principal.userId,
      );
      if (result === 'name_taken') {
        throw conflict('name_taken', 'Another category has this name.');
      }
      await audit(tx, context, 'expense.category_created', 'expense_category', result.id, {
        name: result.name,
      });
      return categoryBody(result);
    });
    return { status: 201, body: created };
  },
});

export const updateExpenseCategoryRoute = defineRoute({
  method: 'patch',
  path: '/v1/expenses/categories/:categoryId',
  operationId: 'updateExpenseCategory',
  summary: 'Rename, re-point or archive an expense category',
  tags: TAGS,
  security: 'authenticated',
  permission: 'expense.approve',
  feature: HR,
  params: z.object({ categoryId: z.uuid() }),
  query: noSchema,
  body: versionBody.extend({
    name: z.string().trim().min(1).max(100).optional(),
    accountId: z.uuid().nullable().optional(),
    archived: z.boolean().optional(),
  }),
  responses: {
    200: { description: 'The category.', schema: expenseCategorySchema },
    404: { description: 'No such category.' },
    409: { description: 'Changed elsewhere, or the name is taken.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const updated = await withTenant(principal.tenantId, async (tx) => {
      if ((await tx.hrExpenses.category(params.categoryId)) === undefined) {
        throw notFound('No such category.');
      }
      await checkAccount(tx, body.accountId);
      const result = await tx.hrExpenses.updateCategory(params.categoryId, body.expectedVersion, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.accountId === undefined ? {} : { accountId: body.accountId }),
        ...(body.archived === undefined ? {} : { archived: body.archived }),
      });
      if (result === 'version_conflict') {
        throw versionConflict();
      }
      if (result === 'name_taken') {
        throw conflict('name_taken', 'Another category has this name.');
      }
      await audit(tx, context, 'expense.category_updated', 'expense_category', result.id, {
        changed: Object.keys(body).filter((key) => key !== 'expectedVersion'),
      });
      return categoryBody(result);
    });
    return { status: 200, body: updated };
  },
});

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export const listExpenseClaimsRoute = defineRoute({
  method: 'get',
  path: '/v1/expenses',
  operationId: 'listExpenseClaims',
  summary: 'Expense claims, newest first',
  description:
    '`scope=mine` (the default) is one’s own claims; `scope=all` is everybody’s, for approvers (owners, admins, HR managers). `q` is a claim number (`EX-000123`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'expense.submit',
  feature: HR,
  params: noSchema,
  query: z.object({
    scope: z.enum(['mine', 'all']).default('mine'),
    status: many(z.enum(EXPENSE_CLAIM_STATUSES), 5),
    claimantId: z.uuid().optional(),
    q: z.string().trim().max(40).optional(),
    cursor: z.string().max(300).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page, and how many claims wait for a decision (approvers only).',
      schema: z.object({
        items: z.array(expenseClaimSchema),
        nextCursor: z.string().nullable(),
        waiting: z.number().int().nullable(),
      }),
    },
    403: { description: 'Everybody’s claims are for approvers.' },
  },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const approver = holds(principal, 'expense.approve');
    if (query.scope === 'all' && !approver) {
      throw forbidden('Only those who approve claims see everybody’s.');
    }
    const body = await withTenant(principal.tenantId, async (tx) => {
      const reference = query.q === undefined ? undefined : parseExpenseReference(query.q);
      const page = await tx.hrExpenses.list({
        ...(query.scope === 'mine'
          ? { claimantId: principal.userId }
          : query.claimantId === undefined
            ? {}
            : { claimantId: query.claimantId }),
        statuses: query.status,
        ...(query.q === undefined ? {} : { reference: reference ?? -1 }),
        before: decodeCursor(query.cursor),
        limit: query.limit,
      });
      return {
        items: await claimBodies(tx, page.items),
        nextCursor: encodeCursor(page.next),
        waiting: approver ? await tx.hrExpenses.waitingCount() : null,
      };
    });
    return { status: 200, body };
  },
});

export const getExpenseClaimRoute = defineRoute({
  method: 'get',
  path: '/v1/expenses/:claimId',
  operationId: 'getExpenseClaim',
  summary: 'An expense claim, its receipts and what this person may do with it',
  tags: TAGS,
  security: 'authenticated',
  permission: 'expense.submit',
  feature: HR,
  params: claimParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The claim.', schema: claimDetailSchema },
    404: { description: 'No such claim, or not one this person may read.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) =>
      claimDetail(tx, principal, await readableClaim(tx, principal, params.claimId)),
    );
    return { status: 200, body };
  },
});

export const submitClaimBody = z.object({
  categoryId: z.uuid(),
  spentOn: z.iso.date(),
  amount: ledgerAmountSchema,
  description: z.string().trim().min(1).max(1000),
  workOrderId: z.uuid().nullable().optional(),
  /** The phone's id for this claim, so a resent one lands once. */
  clientActionId: z.uuid().optional(),
});

/** Submits a claim for this person; shared with the phone's outbox. */
export async function submitClaim(
  tx: TenantTransaction,
  principal: Principal,
  body: z.infer<typeof submitClaimBody>,
): Promise<{ claim: ExpenseClaim; created: boolean }> {
  const category = await tx.hrExpenses.category(body.categoryId);
  if (category?.archivedAt !== null) {
    throw unprocessable('category_not_usable', 'Choose a category in use.', [
      { field: 'body.categoryId', code: 'category_not_usable', message: 'A category in use.' },
    ]);
  }
  if (body.spentOn > (await companyToday(tx))) {
    throw unprocessable('spent_in_future', 'An expense is claimed once it is spent.', [
      { field: 'body.spentOn', code: 'spent_in_future', message: 'Today or earlier.' },
    ]);
  }
  if (body.workOrderId !== undefined && body.workOrderId !== null) {
    await readableWorkOrder(tx, principal, body.workOrderId);
  }
  const company = await tx.settings.get();
  return tx.hrExpenses.submit({
    claimantId: principal.userId,
    categoryId: category.id,
    workOrderId: body.workOrderId ?? null,
    spentOn: body.spentOn,
    amount: body.amount,
    currency: company.currency,
    description: body.description,
    clientActionId: body.clientActionId ?? null,
  });
}

export const submitExpenseClaimRoute = defineRoute({
  method: 'post',
  path: '/v1/expenses',
  operationId: 'submitExpenseClaim',
  summary: 'Claim an expense back',
  description:
    'In the company’s currency, spent today or earlier, for a category in use, optionally for a job this person may read. Attach receipts with `POST /v1/attachments` and `{ expenseClaimId }`. Honours `Idempotency-Key`; `clientActionId` makes a phone’s resent claim land once.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'expense.submit',
  feature: HR,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: submitClaimBody,
  responses: {
    201: { description: 'The claim.', schema: claimDetailSchema },
    422: { description: 'A category not in use, a date ahead, or a job not this person’s.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const { claim, created } = await submitClaim(tx, principal, body);
      if (created) {
        await auditClaim(tx, context, 'expense.submitted', claim);
      }
      return claimDetail(tx, principal, claim);
    });
    return { status: 201, body: detail };
  },
});

export const withdrawExpenseClaimRoute = defineRoute({
  method: 'post',
  path: '/v1/expenses/:claimId/withdraw',
  operationId: 'withdrawExpenseClaim',
  summary: 'Withdraw one’s own claim while it waits',
  tags: TAGS,
  security: 'authenticated',
  permission: 'expense.submit',
  feature: HR,
  params: claimParams,
  query: noSchema,
  body: versionBody,
  responses: {
    200: { description: 'The claim.', schema: claimDetailSchema },
    404: { description: 'No such claim.' },
    409: { description: 'Not waiting, not one’s own, or changed elsewhere.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const claim = await readableClaim(tx, principal, params.claimId, true);
      if (!own(principal, claim)) {
        throw conflict('not_own_claim', 'Only the person who claimed withdraws a claim.');
      }
      if (claim.status !== 'submitted') {
        throw conflict('not_waiting', 'Only a claim waiting for a decision is withdrawn.');
      }
      const moved = await tx.hrExpenses.withdraw(claim.id, body.expectedVersion);
      if (moved === undefined) {
        throw versionConflict();
      }
      await auditClaim(tx, context, 'expense.withdrawn', moved);
      return claimDetail(tx, principal, moved);
    });
    return { status: 200, body: detail };
  },
});

/** The checks before deciding, said in words. */
async function forDecision(
  tx: TenantTransaction,
  principal: Principal,
  claimId: string,
): Promise<ExpenseClaim> {
  const claim = await readableClaim(tx, principal, claimId, true);
  if (own(principal, claim)) {
    throw conflict('self_approval', 'Somebody other than the claimant decides a claim.');
  }
  if (claim.status !== 'submitted') {
    throw conflict('not_waiting', 'This claim has already been decided or withdrawn.');
  }
  return claim;
}

export const approveExpenseClaimRoute = defineRoute({
  method: 'post',
  path: '/v1/expenses/:claimId/approve',
  operationId: 'approveExpenseClaim',
  summary: 'Approve a claim, to be paid back directly or through payroll',
  description:
    'By an owner, admin or HR manager who is not the claimant (409 `self_approval`). `settleVia: payroll` needs the payroll module (422 `payroll_off`). Posts to the ledger when it is set up.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'expense.approve',
  feature: HR,
  params: claimParams,
  query: noSchema,
  body: versionBody.extend({ settleVia: expenseSettlementSchema.default('direct') }),
  responses: {
    200: { description: 'The claim.', schema: claimDetailSchema },
    404: { description: 'No such claim.' },
    409: { description: 'One’s own, already decided, or changed elsewhere.' },
    422: { description: 'Payroll is not switched on.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    if (body.settleVia === 'payroll' && !(await isFeatureEnabled(principal.tenantId, 'payroll'))) {
      throw unprocessable('payroll_off', 'Payroll is not switched on; pay it back directly.');
    }
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const claim = await forDecision(tx, principal, params.claimId);
      const moved = await tx.hrExpenses.approve(
        claim.id,
        body.expectedVersion,
        principal.userId,
        body.settleVia,
      );
      if (moved === undefined) {
        throw versionConflict();
      }
      await auditClaim(tx, context, 'expense.approved', moved, { settleVia: body.settleVia });
      return claimDetail(tx, principal, moved);
    });
    return { status: 200, body: detail };
  },
});

export const rejectExpenseClaimRoute = defineRoute({
  method: 'post',
  path: '/v1/expenses/:claimId/reject',
  operationId: 'rejectExpenseClaim',
  summary: 'Reject a claim, saying why',
  tags: TAGS,
  security: 'authenticated',
  permission: 'expense.approve',
  feature: HR,
  params: claimParams,
  query: noSchema,
  body: versionBody.extend({ reason: z.string().trim().min(1).max(1000) }),
  responses: {
    200: { description: 'The claim.', schema: claimDetailSchema },
    404: { description: 'No such claim.' },
    409: { description: 'One’s own, already decided, or changed elsewhere.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const claim = await forDecision(tx, principal, params.claimId);
      const moved = await tx.hrExpenses.reject(
        claim.id,
        body.expectedVersion,
        principal.userId,
        body.reason,
      );
      if (moved === undefined) {
        throw versionConflict();
      }
      await auditClaim(tx, context, 'expense.rejected', moved, { reason: body.reason });
      return claimDetail(tx, principal, moved);
    });
    return { status: 200, body: detail };
  },
});

export const payExpenseClaimRoute = defineRoute({
  method: 'post',
  path: '/v1/expenses/:claimId/pay',
  operationId: 'payExpenseClaim',
  summary: 'Record paying an approved claim back',
  description:
    'By cash or bank transfer, with an optional reference. A claim approved to go through payroll is paid by the pay run (409 `settles_through_payroll`). Posts to the ledger when it is set up.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'expense.approve',
  feature: HR,
  params: claimParams,
  query: noSchema,
  body: versionBody.extend({
    via: expensePaidViaSchema.exclude(['payroll']),
    reference: z.string().trim().min(1).max(200).nullable().optional(),
  }),
  responses: {
    200: { description: 'The claim.', schema: claimDetailSchema },
    404: { description: 'No such claim.' },
    409: { description: 'Not approved, settled through payroll, or changed elsewhere.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const claim = await readableClaim(tx, principal, params.claimId, true);
      if (claim.status !== 'approved') {
        throw conflict('not_approved', 'Only an approved claim is paid back.');
      }
      if (claim.settleVia === 'payroll') {
        throw conflict('settles_through_payroll', 'This claim is paid back by the next pay run.');
      }
      const moved = await tx.hrExpenses.pay(
        claim.id,
        body.expectedVersion,
        principal.userId,
        body.via,
        body.reference ?? null,
      );
      if (moved === undefined) {
        throw versionConflict();
      }
      await auditClaim(tx, context, 'expense.paid', moved, { via: body.via });
      return claimDetail(tx, principal, moved);
    });
    return { status: 200, body: detail };
  },
});

export const expenseRoutes = [
  listExpenseCategoriesRoute,
  createExpenseCategoryRoute,
  updateExpenseCategoryRoute,
  listExpenseClaimsRoute,
  submitExpenseClaimRoute,
  getExpenseClaimRoute,
  withdrawExpenseClaimRoute,
  approveExpenseClaimRoute,
  rejectExpenseClaimRoute,
  payExpenseClaimRoute,
];
