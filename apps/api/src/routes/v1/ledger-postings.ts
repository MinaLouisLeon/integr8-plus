import {
  accountTypeSchema,
  convertLines,
  exchangeRateSchema,
  formatJournalReference,
  holds,
  journalSourceKindSchema,
  journalTotals,
} from '@integr8/core';
import {
  LEDGER_POSTING_REASONS,
  LEDGER_POSTING_STATUSES,
  type JournalLineInput,
  type LedgerPosting,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { crmAudit as audit } from './crm-shared.js';
import {
  auditJournal,
  checkDate,
  checkLines,
  journalDetail,
  journalDetailSchema,
  LEDGER,
  LEDGER_TAGS,
  lineInputSchema,
  requireSettings,
} from './ledger.js';
import { many, type People, peopleOf, personBody, personSchema } from './operations.js';
import { isoOrNull, iso } from './schemas.js';

/**
 * The unposted list (CRM/ERP plan, phase A1; ADR-0009): sales documents and
 * stock the database captured for the ledger and could not post at once —
 * the company switched automatic posting off, the document is in another
 * currency or carries no cost, its month is locked, or it follows an invoice
 * still waiting. Each is reviewed and posted — as proposed, on another date,
 * to other accounts, or at a typed rate — or set aside with a reason.
 */

const reasonSchema = z.enum(LEDGER_POSTING_REASONS);

const postingSummarySchema = z.object({
  id: z.uuid(),
  source: z.object({ kind: journalSourceKindSchema, id: z.uuid() }),
  /** `INV-000012`, `CN-000003`, `INV-000012 void`, `RC-000004`; null for stock. */
  label: z.string().nullable(),
  documentDate: z.iso.date(),
  currency: z.string(),
  /** The proposal's debits, in the document's currency. */
  amount: z.string(),
  status: z.enum(LEDGER_POSTING_STATUSES),
  /** Why it waits, while it does. */
  reason: reasonSchema.nullable(),
  /** The database's words when posting failed. */
  detail: z.string().nullable(),
  journal: z.object({ id: z.uuid(), reference: z.string().nullable() }).nullable(),
  resolvedBy: personSchema.nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  skipReason: z.string().nullable(),
  capturedAt: z.iso.datetime(),
});

const proposedLineSchema = z.object({
  account: z.object({ id: z.uuid(), code: z.string(), name: z.string(), type: accountTypeSchema }),
  debit: z.string(),
  credit: z.string(),
  customer: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});

const postingDetailSchema = postingSummarySchema.extend({
  /** What it would post, in the document's currency. */
  lines: z.array(proposedLineSchema),
  totals: z.object({ debit: z.string(), credit: z.string(), balanced: z.boolean() }),
  /** The company's currency; a document in another one needs a rate to post. */
  companyCurrency: z.string(),
  /** The invoice a credit note or a void follows. */
  invoice: postingSummarySchema.pick({ id: true, label: true, status: true }).nullable(),
  can: z.object({ post: z.boolean(), skip: z.boolean() }),
});

const countsSchema = z.object({
  total: z.number().int(),
  byReason: z.partialRecord(reasonSchema, z.number().int()),
});

const postingParams = z.object({ postingId: z.uuid() });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** How many documents wait, in all and by why. */
export async function unpostedCounts(tx: TenantTransaction): Promise<z.infer<typeof countsSchema>> {
  const byReason = await tx.ledger.pendingCounts();
  return {
    total: Object.values(byReason).reduce((sum, count) => sum + count, 0),
    byReason,
  };
}

async function summaries(
  tx: TenantTransaction,
  postings: readonly LedgerPosting[],
  people?: People,
): Promise<z.infer<typeof postingSummarySchema>[]> {
  const journalIds = postings.flatMap((posting) =>
    posting.journalId === null ? [] : [posting.journalId],
  );
  const [known, journals] = await Promise.all([
    people === undefined ? peopleOf(tx) : Promise.resolve(people),
    Promise.all(journalIds.map((id) => tx.ledger.find(id))),
  ]);
  const references = new Map(
    journals.flatMap((journal) =>
      journal === undefined
        ? []
        : [
            [
              journal.id,
              journal.reference === null ? null : formatJournalReference(journal.reference),
            ] as const,
          ],
    ),
  );
  return postings.map((posting) => ({
    id: posting.id,
    source: { kind: posting.sourceKind, id: posting.sourceId },
    label: posting.label,
    documentDate: posting.documentDate,
    currency: posting.currency,
    amount: posting.amount,
    status: posting.status,
    reason: posting.reason,
    detail: posting.detail,
    journal:
      posting.journalId === null
        ? null
        : { id: posting.journalId, reference: references.get(posting.journalId) ?? null },
    resolvedBy: posting.resolvedBy === null ? null : personBody(posting.resolvedBy, known),
    resolvedAt: isoOrNull(posting.resolvedAt),
    skipReason: posting.skipReason,
    capturedAt: iso(posting.capturedAt),
  }));
}

async function postingOr404(tx: TenantTransaction, id: string): Promise<LedgerPosting> {
  const posting = await tx.ledger.lockPosting(id);
  if (posting === undefined) {
    throw notFound('This document is not in the unposted list.');
  }
  return posting;
}

async function postingDetail(
  tx: TenantTransaction,
  context: RequestContext,
  posting: LedgerPosting,
): Promise<z.infer<typeof postingDetailSchema>> {
  const [summary] = await summaries(tx, [posting]);
  const [proposal, company, parent] = await Promise.all([
    tx.ledger.proposal(posting.sourceKind, posting.sourceId),
    tx.settings.get(),
    tx.ledger.parentInvoiceOf(posting),
  ]);
  const [accounts, customers] = await Promise.all([
    tx.ledger.accountsByIds(proposal.map((line) => line.accountId)),
    tx.customers.findMany(
      proposal.flatMap((line) => (line.customerId === null ? [] : [line.customerId])),
    ),
  ]);
  const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));
  const pending = posting.status === 'pending';
  const posts = holds(context.principal, 'ledger.post');
  if (summary === undefined) {
    throw notFound('This document is not in the unposted list.');
  }
  return {
    ...summary,
    lines: proposal.map((line) => {
      const account = accounts.get(line.accountId);
      return {
        account: {
          id: line.accountId,
          code: account?.code ?? '',
          name: account?.name ?? '',
          type: account?.type ?? 'asset',
        },
        debit: line.debit,
        credit: line.credit,
        customer:
          line.customerId === null
            ? null
            : { id: line.customerId, name: customerName.get(line.customerId) ?? '' },
      };
    }),
    totals: journalTotals(proposal),
    companyCurrency: company.currency,
    invoice:
      parent === undefined ? null : { id: parent.id, label: parent.label, status: parent.status },
    can: {
      post: posts && pending && posting.reason !== 'waits_for_invoice',
      skip: posts && pending,
    },
  };
}

/** Sets aside the credit notes and voids waiting on an invoice set aside. */
async function skipFollowing(tx: TenantTransaction, invoiceId: string, by: string) {
  for (const following of await tx.ledger.pendingFollowing(invoiceId)) {
    await tx.ledger.skip(following.id, by, 'Its invoice was set aside');
  }
}

/** After an invoice posts, what follows it may post too, as the company's switch says. */
async function postFollowing(tx: TenantTransaction, invoiceId: string, by: string) {
  for (const following of await tx.ledger.pendingFollowing(invoiceId)) {
    await tx.ledger.tryPost(following.id, by, false);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function encodeCursor(next: { date: string; id: string } | undefined): string | null {
  return next === undefined
    ? null
    : Buffer.from(JSON.stringify(next), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { date: string; id: string } | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    const parsed = z
      .object({ date: z.iso.date(), id: z.uuid() })
      .safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export const listPostingsRoute = defineRoute({
  method: 'get',
  path: '/v1/ledger/postings',
  operationId: 'listLedgerPostings',
  summary: 'Documents captured for the ledger: the unposted list, oldest first',
  description:
    'By default what waits (`status=pending`), with why. `counts` is what waits, in all and by reason, whatever the filters.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.read',
  feature: LEDGER,
  params: noSchema,
  query: z.object({
    status: z.enum(LEDGER_POSTING_STATUSES).default('pending'),
    kind: many(journalSourceKindSchema, 5),
    reason: many(reasonSchema, 8),
    cursor: z.string().max(300).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page.',
      schema: z.object({
        items: z.array(postingSummarySchema),
        nextCursor: z.string().nullable(),
        counts: countsSchema,
      }),
    },
  },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      await requireSettings(tx);
      const page = await tx.ledger.postings({
        status: query.status,
        kinds: query.kind,
        reasons: query.reason,
        after: decodeCursor(query.cursor),
        limit: query.limit,
      });
      return {
        items: await summaries(tx, page.items),
        nextCursor: encodeCursor(page.next),
        counts: await unpostedCounts(tx),
      };
    });
    return { status: 200, body };
  },
});

export const getPostingRoute = defineRoute({
  method: 'get',
  path: '/v1/ledger/postings/:postingId',
  operationId: 'getLedgerPosting',
  summary: 'A captured document and the journal it would post',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.read',
  feature: LEDGER,
  params: postingParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The document.', schema: postingDetailSchema },
    404: { description: 'Not captured.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const posting = await tx.ledger.posting(params.postingId);
      if (posting === undefined) {
        throw notFound('This document is not in the unposted list.');
      }
      return postingDetail(tx, context, posting);
    });
    return { status: 200, body };
  },
});

export const postPostingRoute = defineRoute({
  method: 'post',
  path: '/v1/ledger/postings/:postingId/post',
  operationId: 'postLedgerPosting',
  summary: 'Post a waiting document',
  description:
    'As proposed, or on `entryDate` (an open month on or after the start; default the document’s date), or with `lines` written out in the company’s currency. A document in another currency needs `rate` (company currency per unit) and where it came from (`rateSource`); the proposal is converted line by line. A credit note or void posts after its invoice (409 `waits_for_invoice`); stock without a cost needs `lines` (409 `cost_unknown`). Honours `Idempotency-Key`.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.post',
  feature: LEDGER,
  idempotent: true,
  params: postingParams,
  query: noSchema,
  body: z.object({
    entryDate: z.iso.date().optional(),
    lines: z.array(lineInputSchema).min(2).max(500).optional(),
    rate: exchangeRateSchema.optional(),
    rateSource: z.string().trim().min(1).max(200).optional(),
  }),
  responses: {
    200: { description: 'The journal it posted.', schema: journalDetailSchema },
    404: { description: 'Not captured.' },
    409: {
      description:
        'No longer waiting, waiting for its invoice, without a cost, or in a locked month.',
    },
    422: { description: 'Before the start, unbalanced, a missing rate, or lines not usable.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const settings = await requireSettings(tx);
      const posting = await postingOr404(tx, params.postingId);
      if (posting.status !== 'pending') {
        throw conflict('not_pending', 'This document no longer waits.');
      }
      const parent = await tx.ledger.parentInvoiceOf(posting);
      if (parent?.status === 'pending') {
        throw conflict(
          'waits_for_invoice',
          `Post or set aside ${parent.label ?? 'its invoice'} first.`,
        );
      }
      if (posting.reason === 'cost_unknown' && body.lines === undefined) {
        throw conflict(
          'cost_unknown',
          'Some of this stock has no cost recorded: write the lines out with the amounts.',
        );
      }
      const company = await tx.settings.get();
      const foreign = posting.currency !== company.currency;
      if (foreign && (body.rate === undefined || body.rateSource === undefined)) {
        throw unprocessable(
          'rate_required',
          `This document is in ${posting.currency}: enter the rate to ${company.currency} and where it came from.`,
          [
            ...(body.rate === undefined
              ? [{ field: 'body.rate', code: 'rate_required', message: 'Enter the rate.' }]
              : []),
            ...(body.rateSource === undefined
              ? [
                  {
                    field: 'body.rateSource',
                    code: 'rate_required',
                    message: 'Say where the rate came from.',
                  },
                ]
              : []),
          ],
        );
      }
      const entryDate = body.entryDate ?? posting.documentDate;
      await checkDate(tx, settings, entryDate, 'body.entryDate');
      const lines = await linesToPost(tx, posting, body, foreign);
      const totals = journalTotals(
        lines.map((line) => ({ debit: line.debit ?? '0', credit: line.credit ?? '0' })),
      );
      if (!totals.balanced) {
        throw unprocessable(
          'unbalanced',
          `Debits (${totals.debit}) and credits (${totals.credit}) must be equal, on two lines or more.`,
        );
      }
      const draft = await tx.ledger.createDraft(
        {
          kind: 'automatic',
          entryDate,
          memo: posting.label,
          sourceKind: posting.sourceKind,
          sourceId: posting.sourceId,
          ...(foreign && body.rate !== undefined && body.rateSource !== undefined
            ? { foreign: { currency: posting.currency, rate: body.rate, source: body.rateSource } }
            : {}),
        },
        lines,
        principal.userId,
      );
      const journal = await tx.ledger.post(draft.id, principal.userId);
      await tx.ledger.markPosted(posting.id, journal.id, principal.userId);
      await auditJournal(tx, context, 'ledger.posting_posted', journal, {
        source: posting.sourceKind,
        sourceId: posting.sourceId,
        label: posting.label,
        edited: body.lines !== undefined,
        redated: entryDate !== posting.documentDate,
        ...(foreign
          ? { currency: posting.currency, rate: body.rate, rateSource: body.rateSource }
          : {}),
      });
      if (posting.sourceKind === 'invoice') {
        await postFollowing(tx, posting.sourceId, principal.userId);
      }
      return journalDetail(tx, principal, journal);
    });
    return { status: 200, body: detail };
  },
});

/** The lines a waiting document posts: written out, or its proposal (converted when foreign). */
async function linesToPost(
  tx: TenantTransaction,
  posting: LedgerPosting,
  body: { lines?: z.infer<typeof lineInputSchema>[] | undefined; rate?: string | undefined },
  foreign: boolean,
): Promise<JournalLineInput[]> {
  if (body.lines !== undefined) {
    return checkLines(tx, body.lines);
  }
  const proposal = await tx.ledger.proposal(posting.sourceKind, posting.sourceId);
  const accounts = await tx.ledger.accountsByIds(proposal.map((line) => line.accountId));
  const archived = [...accounts.values()].find((account) => account.archivedAt !== null);
  if (archived !== undefined) {
    throw conflict(
      'account_archived',
      `${archived.code} ${archived.name} is archived: choose the accounts by writing the lines out, or change the posting accounts in the settings.`,
    );
  }
  if (foreign && body.rate !== undefined) {
    return convertLines(proposal, body.rate).map((line) => ({
      accountId: line.accountId,
      debit: line.debit === '0' ? undefined : line.debit,
      credit: line.credit === '0' ? undefined : line.credit,
      customerId: line.customerId,
      foreignAmount: line.foreignAmount,
    }));
  }
  return proposal.map((line) => ({
    accountId: line.accountId,
    debit: line.debit === '0' ? undefined : line.debit,
    credit: line.credit === '0' ? undefined : line.credit,
    customerId: line.customerId,
  }));
}

export const postAllPostingsRoute = defineRoute({
  method: 'post',
  path: '/v1/ledger/postings/post-all',
  operationId: 'postLedgerPostings',
  summary: 'Post many waiting documents as proposed',
  description:
    'The given `ids`, or everything waiting of the given `kind`s (all kinds when none), oldest first, up to 500 a call. Each posts as proposed or keeps waiting with its reason: documents in another currency and stock without a cost are left for one-by-one review. `remaining` says whether more wait.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.post',
  feature: LEDGER,
  params: noSchema,
  query: noSchema,
  body: z.object({
    ids: z.array(z.uuid()).max(500).optional(),
    kind: z.array(journalSourceKindSchema).max(5).optional(),
  }),
  responses: {
    200: {
      description: 'What happened.',
      schema: z.object({
        posted: z.number().int(),
        skipped: z.number().int(),
        waiting: z.partialRecord(reasonSchema, z.number().int()),
        counts: countsSchema,
      }),
    },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const result = await withTenant(principal.tenantId, async (tx) => {
      await requireSettings(tx);
      const ids =
        body.ids ??
        (
          await tx.ledger.postings({
            status: 'pending',
            kinds: body.kind ?? [],
            reasons: LEDGER_POSTING_REASONS.filter(
              (reason) => reason !== 'foreign_currency' && reason !== 'cost_unknown',
            ),
            limit: 500,
          })
        ).items.map((posting) => posting.id);
      // Counted from where each stands before and after: posting an invoice
      // also posts what follows it, which may come later in the list.
      const before = await tx.ledger.postingStates(ids);
      const tried = ids.filter((id) => before.get(id)?.status === 'pending');
      for (const id of tried) {
        await tx.ledger.tryPost(id, principal.userId, true);
      }
      const after = await tx.ledger.postingStates(tried);
      let posted = 0;
      let skipped = 0;
      const waiting: Partial<Record<(typeof LEDGER_POSTING_REASONS)[number], number>> = {};
      for (const state of after.values()) {
        if (state.status === 'posted') {
          posted += 1;
        } else if (state.status === 'skipped') {
          skipped += 1;
        } else if (state.reason !== null) {
          waiting[state.reason] = (waiting[state.reason] ?? 0) + 1;
        }
      }
      await audit(tx, context, 'ledger.postings_posted', 'ledger', principal.tenantId, {
        tried: tried.length,
        posted,
        skipped,
      });
      return { posted, skipped, waiting, counts: await unpostedCounts(tx) };
    });
    return { status: 200, body: result };
  },
});

export const skipPostingRoute = defineRoute({
  method: 'post',
  path: '/v1/ledger/postings/:postingId/skip',
  operationId: 'skipLedgerPosting',
  summary: 'Set a waiting document aside: it will not post',
  description:
    'With a reason, kept with it. Setting an invoice aside sets aside the credit notes and void waiting on it.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.post',
  feature: LEDGER,
  params: postingParams,
  query: noSchema,
  body: z.object({ reason: z.string().trim().min(1).max(500) }),
  responses: {
    200: { description: 'The document, set aside.', schema: postingDetailSchema },
    404: { description: 'Not captured.' },
    409: { description: 'No longer waiting.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      await requireSettings(tx);
      const posting = await postingOr404(tx, params.postingId);
      if (!(await tx.ledger.skip(posting.id, principal.userId, body.reason))) {
        throw conflict('not_pending', 'This document no longer waits.');
      }
      if (posting.sourceKind === 'invoice') {
        await skipFollowing(tx, posting.sourceId, principal.userId);
      }
      await audit(tx, context, 'ledger.posting_skipped', 'ledger_posting', posting.id, {
        source: posting.sourceKind,
        sourceId: posting.sourceId,
        label: posting.label,
        reason: body.reason,
      });
      const skipped = await tx.ledger.posting(posting.id);
      if (skipped === undefined) {
        throw notFound('This document is not in the unposted list.');
      }
      return postingDetail(tx, context, skipped);
    });
    return { status: 200, body: detail };
  },
});

export const ledgerPostingRoutes = [
  listPostingsRoute,
  postAllPostingsRoute,
  getPostingRoute,
  postPostingRoute,
  skipPostingRoute,
];
