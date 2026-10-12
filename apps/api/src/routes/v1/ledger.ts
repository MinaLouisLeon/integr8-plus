import {
  accountCodeSchema,
  accountTypeSchema,
  DEFAULT_CHART,
  fiscalStartMonthSchema,
  fiscalYearOf,
  formatJournalReference,
  holds,
  journalKindSchema,
  journalSourceKindSchema,
  journalTotals,
  ledgerAmountSchema,
  monthOf,
  monthStartSchema,
  monthsBetween,
  parseJournalReference,
  POSTING_ROLES,
  type PostingRole,
  type Principal,
} from '@integr8/core';
import type {
  Journal,
  JournalLine,
  JournalLineInput,
  LedgerAccount,
  LedgerSettings,
  TenantTransaction,
} from '@integr8/db';
import { LEDGER_POSTING_REASONS, withTenant } from '@integr8/db';
import { z } from 'zod';
import { conflict, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { crmAudit as audit, versionConflict } from './crm-shared.js';
import { many, type People, peopleOf, personBody, personSchema } from './operations.js';
import { companyToday } from './sales-quotes.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * The general ledger (CRM/ERP plan, phase A1; ADR-0009): set-up, the chart of
 * accounts, months locked by hand, and journals — drafted, posted by a second
 * person when written by hand, never changed once posted, and corrected by a
 * reversal. A management ledger in the company's currency, not statutory
 * accounts.
 *
 * Every rule the database enforces at posting is checked here first, so a
 * refusal is said in words; the database is the backstop.
 */

export const LEDGER_TAGS = ['ledger'];
export const LEDGER = 'ledger' as const;

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

const roleSchema = z.enum(POSTING_ROLES);

export const accountSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  type: accountTypeSchema,
  archived: z.boolean(),
  /** The automatic posting that uses it, if any. */
  role: roleSchema.nullable(),
  version: z.number().int(),
});

const settingsBodySchema = z.object({
  startDate: z.iso.date(),
  fiscalStartMonth: z.number().int(),
  autoPostSales: z.boolean(),
  autoPostStock: z.boolean(),
  allowSelfApproval: z.boolean(),
  accounts: z.record(roleSchema, z.uuid()),
  version: z.number().int(),
});

export const overviewSchema = z.object({
  setUp: z.boolean(),
  settings: settingsBodySchema.nullable(),
  /** The company's currency: the ledger's only one. */
  currency: z.string(),
  /** Today in the company's calendar. */
  today: z.iso.date(),
  /** Once a journal is posted, the start date and fiscal year no longer change. */
  fixed: z.boolean(),
  openingJournal: z
    .object({ id: z.uuid(), status: z.enum(['draft', 'posted']), reference: z.string().nullable() })
    .nullable(),
  can: z.object({ post: z.boolean(), manage: z.boolean(), unlock: z.boolean() }),
  /** Documents waiting in the unposted list, in all and by why. */
  unposted: z.object({
    total: z.number().int(),
    byReason: z.partialRecord(z.enum(LEDGER_POSTING_REASONS), z.number().int()),
  }),
});

export const journalSummarySchema = z.object({
  id: z.uuid(),
  /** `JV-000123`; null while a draft. */
  reference: z.string().nullable(),
  status: z.enum(['draft', 'posted']),
  kind: journalKindSchema,
  entryDate: z.iso.date(),
  memo: z.string().nullable(),
  /** The sum of its debits, which is the sum of its credits once posted. */
  total: z.string(),
  source: z.object({ kind: journalSourceKindSchema, id: z.uuid() }).nullable(),
  reversalOf: z.uuid().nullable(),
  reversedBy: z.uuid().nullable(),
  draftedBy: personSchema,
  postedBy: personSchema.nullable(),
  postedAt: z.iso.datetime().nullable(),
  selfApproved: z.boolean(),
});

const lineBodySchema = z.object({
  id: z.uuid(),
  lineNo: z.number().int(),
  account: z.object({ id: z.uuid(), code: z.string(), name: z.string(), type: accountTypeSchema }),
  debit: z.string(),
  credit: z.string(),
  memo: z.string().nullable(),
  customer: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  foreignAmount: z.string().nullable(),
});

export const journalDetailSchema = journalSummarySchema.extend({
  /** The invoice behind an automatic journal: its own, a void's, or the one a credit note credits. */
  sourceInvoiceId: z.uuid().nullable(),
  lines: z.array(lineBodySchema),
  foreign: z.object({ currency: z.string(), rate: z.string(), source: z.string() }).nullable(),
  totals: z.object({ debit: z.string(), credit: z.string(), balanced: z.boolean() }),
  can: z.object({
    edit: z.boolean(),
    post: z.boolean(),
    discard: z.boolean(),
    reverse: z.boolean(),
  }),
});

const periodSchema = z.object({
  month: z.iso.date(),
  locked: z.boolean(),
  changedBy: personSchema.nullable(),
  changedAt: z.iso.datetime().nullable(),
});

const periodEventSchema = z.object({
  id: z.uuid(),
  month: z.iso.date(),
  kind: z.enum(['locked', 'unlocked']),
  reason: z.string().nullable(),
  by: personSchema,
  at: z.iso.datetime(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function settingsBody(settings: LedgerSettings): z.infer<typeof settingsBodySchema> {
  return {
    startDate: settings.startDate,
    fiscalStartMonth: settings.fiscalStartMonth,
    autoPostSales: settings.autoPostSales,
    autoPostStock: settings.autoPostStock,
    allowSelfApproval: settings.allowSelfApproval,
    accounts: { ...settings.accounts },
    version: settings.version,
  };
}

function roleOf(settings: LedgerSettings | undefined, accountId: string): PostingRole | null {
  if (settings === undefined) {
    return null;
  }
  return POSTING_ROLES.find((role) => settings.accounts[role] === accountId) ?? null;
}

function accountBody(account: LedgerAccount, settings: LedgerSettings | undefined) {
  return {
    id: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    archived: account.archivedAt !== null,
    role: roleOf(settings, account.id),
    version: account.version,
  };
}

/** The ledger's settings, or 409 `ledger_not_set_up`. */
export async function requireSettings(tx: TenantTransaction): Promise<LedgerSettings> {
  const settings = await tx.ledger.settings();
  if (settings === undefined) {
    throw conflict('ledger_not_set_up', 'Set up the ledger first.');
  }
  return settings;
}

async function journalOr404(tx: TenantTransaction, id: string): Promise<Journal> {
  const journal = await tx.ledger.find(id);
  if (journal === undefined) {
    throw notFound('This journal does not exist.');
  }
  return journal;
}

function summaryBody(
  journal: Journal,
  lines: readonly JournalLine[],
  reversedBy: string | null,
  people: People,
): z.infer<typeof journalSummarySchema> {
  return {
    id: journal.id,
    reference: journal.reference === null ? null : formatJournalReference(journal.reference),
    status: journal.status,
    kind: journal.kind,
    entryDate: journal.entryDate,
    memo: journal.memo,
    total: journalTotals(lines).debit,
    source:
      journal.sourceKind === null || journal.sourceId === null
        ? null
        : { kind: journal.sourceKind, id: journal.sourceId },
    reversalOf: journal.reversalOf,
    reversedBy,
    draftedBy: personBody(journal.draftedBy, people),
    postedBy: journal.postedBy === null ? null : personBody(journal.postedBy, people),
    postedAt: isoOrNull(journal.postedAt),
    selfApproved: journal.selfApproved,
  };
}

/** Whether this person may post this draft: someone else drafted it, or self-approval is allowed. */
function mayApprove(principal: Principal, journal: Journal, settings: LedgerSettings | undefined) {
  if (journal.kind !== 'manual' && journal.kind !== 'opening') {
    return true;
  }
  return journal.draftedBy !== principal.userId || settings?.allowSelfApproval === true;
}

export async function journalDetail(
  tx: TenantTransaction,
  principal: Principal,
  journal: Journal,
): Promise<z.infer<typeof journalDetailSchema>> {
  const [lines, people, reversal, settings] = await Promise.all([
    tx.ledger.lines(journal.id),
    peopleOf(tx),
    tx.ledger.reversalFor(journal.id),
    tx.ledger.settings(),
  ]);
  const [accounts, customers] = await Promise.all([
    tx.ledger.accountsByIds(lines.map((line) => line.accountId)),
    tx.customers.findMany(
      lines.flatMap((line) => (line.customerId === null ? [] : [line.customerId])),
    ),
  ]);
  const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));
  const sourceInvoiceId =
    journal.sourceId === null
      ? null
      : journal.sourceKind === 'invoice' || journal.sourceKind === 'invoice_void'
        ? journal.sourceId
        : journal.sourceKind === 'credit_note'
          ? ((await tx.financeInvoices.findCreditNote(journal.sourceId))?.invoiceId ?? null)
          : null;
  const posts = holds(principal, 'ledger.post');
  const draft = journal.status === 'draft';
  const handWritten = journal.kind === 'manual' || journal.kind === 'opening';
  return {
    ...summaryBody(journal, lines, reversal?.id ?? null, people),
    sourceInvoiceId,
    lines: lines.map((line) => {
      const account = accounts.get(line.accountId);
      return {
        id: line.id,
        lineNo: line.lineNo,
        account: {
          id: line.accountId,
          code: account?.code ?? '',
          name: account?.name ?? '',
          type: account?.type ?? 'asset',
        },
        debit: line.debit,
        credit: line.credit,
        memo: line.memo,
        customer:
          line.customerId === null
            ? null
            : { id: line.customerId, name: customerName.get(line.customerId) ?? '' },
        foreignAmount: line.foreignAmount,
      };
    }),
    foreign:
      journal.foreignCurrency === null ||
      journal.exchangeRate === null ||
      journal.rateSource === null
        ? null
        : {
            currency: journal.foreignCurrency,
            rate: journal.exchangeRate,
            source: journal.rateSource,
          },
    totals: journalTotals(lines),
    can: {
      edit: posts && draft && handWritten,
      post: posts && draft && handWritten && mayApprove(principal, journal, settings),
      discard: posts && draft && handWritten,
      reverse:
        posts &&
        journal.status === 'posted' &&
        reversal === undefined &&
        journal.kind !== 'closing' &&
        journal.kind !== 'reversal',
    },
  };
}

export const lineInputSchema = z
  .object({
    accountId: z.uuid(),
    debit: ledgerAmountSchema.optional(),
    credit: ledgerAmountSchema.optional(),
    memo: z.string().trim().max(500).nullable().optional(),
    customerId: z.uuid().nullable().optional(),
  })
  .refine((line) => (line.debit === undefined) !== (line.credit === undefined), {
    message: 'A line is a debit or a credit, not both and not neither',
  });

const linesSchema = z.array(lineInputSchema).min(2).max(500);

type LineInput = z.infer<typeof lineInputSchema>;

/** Checks lines against the chart: every account exists and is in use, every customer exists. */
export async function checkLines(
  tx: TenantTransaction,
  lines: readonly LineInput[],
): Promise<JournalLineInput[]> {
  const accounts = await tx.ledger.accountsByIds(lines.map((line) => line.accountId));
  const customerIds = lines.flatMap((line) =>
    line.customerId === null || line.customerId === undefined ? [] : [line.customerId],
  );
  const customers = new Set((await tx.customers.findMany(customerIds)).map((c) => c.id));
  const problems = lines.flatMap((line, index) => {
    const account = accounts.get(line.accountId);
    const found: { field: string; code: string; message: string }[] = [];
    if (account === undefined) {
      found.push({
        field: `body.lines.${String(index)}.accountId`,
        code: 'account_not_found',
        message: 'No such account.',
      });
    } else if (account.archivedAt !== null) {
      found.push({
        field: `body.lines.${String(index)}.accountId`,
        code: 'account_archived',
        message: `${account.code} ${account.name} is archived.`,
      });
    }
    if (
      line.customerId !== null &&
      line.customerId !== undefined &&
      !customers.has(line.customerId)
    ) {
      found.push({
        field: `body.lines.${String(index)}.customerId`,
        code: 'customer_not_found',
        message: 'No such customer.',
      });
    }
    return found;
  });
  if (problems.length > 0) {
    throw unprocessable(
      'invalid_lines',
      'Some lines name an account or customer that cannot be used.',
      problems,
    );
  }
  return lines.map((line) => ({
    accountId: line.accountId,
    debit: line.debit,
    credit: line.credit,
    memo: line.memo ?? null,
    customerId: line.customerId ?? null,
  }));
}

/** The date checks shared by drafting, posting and reversing. */
export async function checkDate(
  tx: TenantTransaction,
  settings: LedgerSettings,
  date: string,
  field: string,
) {
  if (date < settings.startDate) {
    throw unprocessable('before_start', `The ledger starts on ${settings.startDate}.`, [
      { field, code: 'before_start', message: `Date it on or after ${settings.startDate}.` },
    ]);
  }
  if (await tx.ledger.periodLocked(date)) {
    throw conflict(
      'period_locked',
      `${monthOf(date).slice(0, 7)} is locked. Date it in an open month.`,
    );
  }
}

/** Everything the database will check when this journal is posted, said in words. */
async function checkPostable(tx: TenantTransaction, settings: LedgerSettings, journal: Journal) {
  await checkDate(tx, settings, journal.entryDate, 'entryDate');
  const lines = await tx.ledger.lines(journal.id);
  const totals = journalTotals(lines);
  if (!totals.balanced) {
    throw unprocessable(
      'unbalanced',
      `Debits (${totals.debit}) and credits (${totals.credit}) must be equal, on two lines or more.`,
    );
  }
  const accounts = await tx.ledger.accountsByIds(lines.map((line) => line.accountId));
  const archived = [...accounts.values()].find((account) => account.archivedAt !== null);
  if (archived !== undefined) {
    throw conflict('account_archived', `${archived.code} ${archived.name} is archived.`);
  }
}

function encodeJournalCursor(next: { date: string; key: string } | undefined): string | null {
  return next === undefined
    ? null
    : Buffer.from(JSON.stringify(next), 'utf8').toString('base64url');
}

function decodeJournalCursor(
  cursor: string | undefined,
): { date: string; key: string } | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    const parsed = z
      .object({ date: z.iso.date(), key: z.string().max(60) })
      .safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const journalParams = z.object({ journalId: z.uuid() });

export async function auditJournal(
  tx: TenantTransaction,
  context: RequestContext,
  action: string,
  journal: Journal,
  extra: Record<string, unknown> = {},
) {
  await audit(tx, context, action, 'journal', journal.id, {
    reference: journal.reference === null ? null : formatJournalReference(journal.reference),
    kind: journal.kind,
    entryDate: journal.entryDate,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Routes: set-up and settings
// ---------------------------------------------------------------------------

export const ledgerOverviewRoute = defineRoute({
  method: 'get',
  path: '/v1/ledger',
  operationId: 'getLedger',
  summary: 'The ledger: whether it is set up, its settings, and what this seat may do',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.read',
  feature: LEDGER,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'The overview.', schema: overviewSchema } },
  handler: async (_request, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, (tx) => overviewBody(tx, principal));
    return { status: 200, body };
  },
});

async function overviewBody(
  tx: TenantTransaction,
  principal: Principal,
): Promise<z.infer<typeof overviewSchema>> {
  const [settings, company, today, fixed, opening, waiting] = await Promise.all([
    tx.ledger.settings(),
    tx.settings.get(),
    companyToday(tx),
    tx.ledger.anyPosted(),
    tx.ledger.openingJournal(),
    tx.ledger.pendingCounts(),
  ]);
  return {
    setUp: settings !== undefined,
    settings: settings === undefined ? null : settingsBody(settings),
    currency: company.currency,
    today,
    fixed,
    openingJournal:
      opening === undefined
        ? null
        : {
            id: opening.id,
            status: opening.status,
            reference:
              opening.reference === null ? null : formatJournalReference(opening.reference),
          },
    can: {
      post: holds(principal, 'ledger.post'),
      manage: holds(principal, 'ledger.manage'),
      unlock: holds(principal, 'ledger.unlock'),
    },
    unposted: {
      total: Object.values(waiting).reduce((sum, count) => sum + count, 0),
      byReason: waiting,
    },
  };
}

export const setUpLedgerRoute = defineRoute({
  method: 'post',
  path: '/v1/ledger/setup',
  operationId: 'setUpLedger',
  summary: 'Set up the ledger with the default chart',
  description:
    'Creates the default chart of accounts (an Egypt-oriented start for a service company, named in `language`) and the settings: the start date (the first of a month) and the month the fiscal year starts. Once only: 409 `already_set_up`. Honours `Idempotency-Key`.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.manage',
  feature: LEDGER,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    startDate: monthStartSchema,
    fiscalStartMonth: fiscalStartMonthSchema.default(1),
    language: z.enum(['en', 'ar']).default('en'),
  }),
  responses: {
    201: { description: 'The ledger.', schema: overviewSchema },
    409: { description: 'Already set up.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const overview = await withTenant(principal.tenantId, async (tx) => {
      const result = await tx.ledger.setUp(
        {
          startDate: body.startDate,
          fiscalStartMonth: body.fiscalStartMonth,
          chart: DEFAULT_CHART.map((account) => ({
            code: account.code,
            name: account.name[body.language],
            type: account.type,
            ...(account.role === undefined ? {} : { role: account.role }),
          })),
        },
        principal.userId,
      );
      if (result === 'already_set_up') {
        throw conflict('already_set_up', 'The ledger is already set up.');
      }
      // Documents already recorded since the start wait for review.
      const queued = await tx.ledger.backfill();
      await audit(tx, context, 'ledger.set_up', 'ledger', principal.tenantId, {
        startDate: body.startDate,
        fiscalStartMonth: body.fiscalStartMonth,
        language: body.language,
        queued,
      });
      return overviewBody(tx, principal);
    });
    return { status: 201, body: overview };
  },
});

export const saveLedgerSettingsRoute = defineRoute({
  method: 'put',
  path: '/v1/ledger/settings',
  operationId: 'saveLedgerSettings',
  summary: 'Change the ledger settings',
  description:
    'With `expectedVersion` (409 `version_conflict`). The start date and fiscal year are fixed once a journal is posted (409 `settings_fixed`). Allowing self-approval is the owner’s (`ledger.unlock`). A posting account must be in use.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.manage',
  feature: LEDGER,
  params: noSchema,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().min(1),
    startDate: monthStartSchema.optional(),
    fiscalStartMonth: fiscalStartMonthSchema.optional(),
    autoPostSales: z.boolean().optional(),
    autoPostStock: z.boolean().optional(),
    allowSelfApproval: z.boolean().optional(),
    accounts: z.partialRecord(roleSchema, z.uuid()).optional(),
  }),
  responses: {
    200: { description: 'The settings.', schema: settingsBodySchema },
    403: { description: 'Allowing self-approval is the owner’s.' },
    409: { description: 'Changed elsewhere, or fixed.' },
    422: { description: 'A posting account that is not in use.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const saved = await withTenant(principal.tenantId, async (tx) => {
      const current = await requireSettings(tx);
      if (
        body.allowSelfApproval !== undefined &&
        body.allowSelfApproval !== current.allowSelfApproval &&
        !holds(principal, 'ledger.unlock')
      ) {
        throw forbidden('Only the owner decides whether a person may post their own journals.');
      }
      const moves =
        (body.startDate !== undefined && body.startDate !== current.startDate) ||
        (body.fiscalStartMonth !== undefined && body.fiscalStartMonth !== current.fiscalStartMonth);
      if (moves && (await tx.ledger.anyPosted())) {
        throw conflict(
          'settings_fixed',
          'The start date and fiscal year are fixed once a journal is posted.',
        );
      }
      const accountIds = Object.values(body.accounts ?? {});
      const accounts = await tx.ledger.accountsByIds(accountIds);
      // Missing or archived: either way not usable.
      const unusable = accountIds.filter((id) => accounts.get(id)?.archivedAt !== null);
      if (unusable.length > 0) {
        throw unprocessable('account_not_usable', 'A posting account must exist and be in use.');
      }
      const result = await tx.ledger.saveSettings(body.expectedVersion, body, principal.userId);
      if (result === 'version_conflict') {
        throw versionConflict();
      }
      // A new start: what was recorded since joins the list, what is now before it leaves.
      const queued = result.startDate === current.startDate ? 0 : await tx.ledger.backfill();
      await audit(tx, context, 'ledger.settings_updated', 'ledger', principal.tenantId, {
        changed: Object.keys(body).filter((key) => key !== 'expectedVersion'),
        ...(queued > 0 ? { queued } : {}),
      });
      return result;
    });
    return { status: 200, body: settingsBody(saved) };
  },
});

// ---------------------------------------------------------------------------
// Routes: accounts
// ---------------------------------------------------------------------------

export const listAccountsRoute = defineRoute({
  method: 'get',
  path: '/v1/ledger/accounts',
  operationId: 'listLedgerAccounts',
  summary: 'The chart of accounts',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.read',
  feature: LEDGER,
  params: noSchema,
  query: z.object({ archived: z.enum(['true', 'false']).optional() }),
  body: noSchema,
  responses: {
    200: { description: 'By code.', schema: z.object({ items: z.array(accountSchema) }) },
  },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const items = await withTenant(principal.tenantId, async (tx) => {
      const [accounts, settings] = await Promise.all([
        tx.ledger.accounts({ includeArchived: query.archived === 'true' }),
        tx.ledger.settings(),
      ]);
      return accounts.map((account) => accountBody(account, settings));
    });
    return { status: 200, body: { items } };
  },
});

export const createAccountRoute = defineRoute({
  method: 'post',
  path: '/v1/ledger/accounts',
  operationId: 'createLedgerAccount',
  summary: 'Add an account to the chart',
  description: 'A code already in the chart is 409 `code_taken`.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.manage',
  feature: LEDGER,
  params: noSchema,
  query: noSchema,
  body: z.object({
    code: accountCodeSchema,
    name: z.string().trim().min(1).max(200),
    type: accountTypeSchema,
  }),
  responses: {
    201: { description: 'The account.', schema: accountSchema },
    409: { description: 'Not set up, or the code is taken.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const created = await withTenant(principal.tenantId, async (tx) => {
      const settings = await requireSettings(tx);
      const account = await tx.ledger.createAccount(body, principal.userId);
      if (account === 'code_taken') {
        throw conflict('code_taken', `The chart already has an account ${body.code}.`);
      }
      await audit(tx, context, 'ledger.account_created', 'ledger_account', account.id, {
        code: account.code,
        type: account.type,
      });
      return accountBody(account, settings);
    });
    return { status: 201, body: created };
  },
});

export const updateAccountRoute = defineRoute({
  method: 'patch',
  path: '/v1/ledger/accounts/:accountId',
  operationId: 'updateLedgerAccount',
  summary: 'Rename, recode, retype or archive an account',
  description:
    'With `expectedVersion` (409 `version_conflict`). A posted-to account keeps its type (409 `type_fixed`); an account an automatic posting uses is not archived (409 `posting_account`); a taken code is 409 `code_taken`.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.manage',
  feature: LEDGER,
  params: z.object({ accountId: z.uuid() }),
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().min(1),
    code: accountCodeSchema.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    type: accountTypeSchema.optional(),
    archived: z.boolean().optional(),
  }),
  responses: {
    200: { description: 'The account.', schema: accountSchema },
    404: { description: 'No such account.' },
    409: { description: 'Changed elsewhere, fixed, or in use.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const updated = await withTenant(principal.tenantId, async (tx) => {
      const settings = await requireSettings(tx);
      const account = await tx.ledger.account(params.accountId);
      if (account === undefined) {
        throw notFound('This account does not exist.');
      }
      if (
        body.type !== undefined &&
        body.type !== account.type &&
        (await tx.ledger.accountUsed(account.id))
      ) {
        throw conflict('type_fixed', 'An account that has been posted to keeps its type.');
      }
      if (body.archived === true && roleOf(settings, account.id) !== null) {
        throw conflict(
          'posting_account',
          'An automatic posting uses this account. Choose another in the settings first.',
        );
      }
      const result = await tx.ledger.updateAccount(
        account.id,
        body.expectedVersion,
        body,
        principal.userId,
      );
      if (result === 'version_conflict') {
        throw versionConflict();
      }
      if (result === 'code_taken') {
        throw conflict('code_taken', `The chart already has an account ${body.code ?? ''}.`);
      }
      await audit(tx, context, 'ledger.account_updated', 'ledger_account', account.id, {
        changed: Object.keys(body).filter((key) => key !== 'expectedVersion'),
      });
      return accountBody(result, settings);
    });
    return { status: 200, body: updated };
  },
});

// ---------------------------------------------------------------------------
// Routes: periods
// ---------------------------------------------------------------------------

export const listPeriodsRoute = defineRoute({
  method: 'get',
  path: '/v1/ledger/periods',
  operationId: 'listLedgerPeriods',
  summary: 'The months of a fiscal year, locked or open',
  description:
    'The fiscal year containing `date` (default today), with its recent lock and unlock history.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.read',
  feature: LEDGER,
  params: noSchema,
  query: z.object({ date: z.iso.date().optional() }),
  body: noSchema,
  responses: {
    200: {
      description: 'Twelve months and their history.',
      schema: z.object({
        year: z.object({ start: z.iso.date(), end: z.iso.date() }),
        months: z.array(periodSchema),
        events: z.array(periodEventSchema),
      }),
    },
  },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const settings = await requireSettings(tx);
      const year = fiscalYearOf(query.date ?? (await companyToday(tx)), settings.fiscalStartMonth);
      const [states, events, people] = await Promise.all([
        tx.ledger.periods(year.start, year.end),
        tx.ledger.periodEvents(),
        peopleOf(tx),
      ]);
      const byMonth = new Map(states.map((state) => [state.periodStart, state]));
      return {
        year,
        months: monthsBetween(year.start, year.end).map((month) => {
          const state = byMonth.get(month);
          return {
            month,
            locked: state?.locked ?? false,
            changedBy: state === undefined ? null : personBody(state.changedBy, people),
            changedAt: state === undefined ? null : iso(state.changedAt),
          };
        }),
        events: events
          .filter((event) => event.periodStart >= year.start && event.periodStart <= year.end)
          .map((event) => ({
            id: event.id,
            month: event.periodStart,
            kind: event.kind,
            reason: event.reason,
            by: personBody(event.actorId, people),
            at: iso(event.occurredAt),
          })),
      };
    });
    return { status: 200, body };
  },
});

const monthParams = z.object({ month: monthStartSchema });

export const lockPeriodRoute = defineRoute({
  method: 'post',
  path: '/v1/ledger/periods/:month/lock',
  operationId: 'lockLedgerPeriod',
  summary: 'Lock a month',
  description: 'Nothing is posted into a locked month. Locking one already locked changes nothing.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.manage',
  feature: LEDGER,
  params: monthParams,
  query: noSchema,
  body: noSchema,
  responses: { 204: { description: 'Locked.' } },
  handler: async ({ params }, context) => {
    const { principal } = context;
    await withTenant(principal.tenantId, async (tx) => {
      await requireSettings(tx);
      const { changed } = await tx.ledger.setPeriodLocked(
        params.month,
        true,
        principal.userId,
        null,
      );
      if (changed) {
        await audit(tx, context, 'ledger.period_locked', 'ledger_period', principal.tenantId, {
          month: params.month,
        });
      }
    });
    return { status: 204, body: undefined };
  },
});

export const unlockPeriodRoute = defineRoute({
  method: 'post',
  path: '/v1/ledger/periods/:month/unlock',
  operationId: 'unlockLedgerPeriod',
  summary: 'Unlock a month, saying why',
  description:
    'The owner’s (`ledger.unlock`). The reason is kept with the month’s history and audited. A month of a closed fiscal year is unlocked after reopening the year (409 `year_closed`).',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.unlock',
  feature: LEDGER,
  params: monthParams,
  query: noSchema,
  body: z.object({ reason: z.string().trim().min(1).max(1000) }),
  responses: {
    204: { description: 'Unlocked.' },
    409: { description: 'Its fiscal year is closed.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    await withTenant(principal.tenantId, async (tx) => {
      const settings = await requireSettings(tx);
      const year = fiscalYearOf(params.month, settings.fiscalStartMonth);
      if ((await tx.ledgerReports.closeInForce(year.start)) !== undefined) {
        throw conflict(
          'year_closed',
          `The fiscal year ${year.start} – ${year.end} is closed. Reopen it first.`,
        );
      }
      const { changed } = await tx.ledger.setPeriodLocked(
        params.month,
        false,
        principal.userId,
        body.reason,
      );
      if (changed) {
        await audit(tx, context, 'ledger.period_unlocked', 'ledger_period', principal.tenantId, {
          month: params.month,
          reason: body.reason,
        });
      }
    });
    return { status: 204, body: undefined };
  },
});

// ---------------------------------------------------------------------------
// Routes: journals
// ---------------------------------------------------------------------------

export const listJournalsRoute = defineRoute({
  method: 'get',
  path: '/v1/ledger/journals',
  operationId: 'listJournals',
  summary: 'Journals, newest first',
  description:
    '`q` is a journal number (`JV-000123`) or words in the memo. Posted journals by date and number; drafts after them.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.read',
  feature: LEDGER,
  params: noSchema,
  query: z.object({
    status: z.enum(['draft', 'posted']).optional(),
    kind: many(journalKindSchema, 5),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    accountId: z.uuid().optional(),
    q: z.string().trim().max(200).optional(),
    cursor: z.string().max(300).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page.',
      schema: z.object({ items: z.array(journalSummarySchema), nextCursor: z.string().nullable() }),
    },
  },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const reference = query.q === undefined ? undefined : parseJournalReference(query.q);
      const page = await tx.ledger.list({
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.kind.length === 0 ? {} : { kinds: query.kind }),
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
        ...(reference !== undefined
          ? { reference }
          : query.q === undefined
            ? {}
            : { text: query.q }),
        ...(query.cursor === undefined ? {} : { before: decodeJournalCursor(query.cursor) }),
        limit: query.limit,
      });
      const ids = page.items.map((journal) => journal.id);
      const [lines, people, reversals] = await Promise.all([
        tx.ledger.linesOf(ids),
        peopleOf(tx),
        Promise.all(page.items.map((journal) => tx.ledger.reversalFor(journal.id))),
      ]);
      return {
        items: page.items.map((journal, index) =>
          summaryBody(journal, lines.get(journal.id) ?? [], reversals[index]?.id ?? null, people),
        ),
        nextCursor: encodeJournalCursor(page.next),
      };
    });
    return { status: 200, body };
  },
});

export const getJournalRoute = defineRoute({
  method: 'get',
  path: '/v1/ledger/journals/:journalId',
  operationId: 'getJournal',
  summary: 'A journal and its lines',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.read',
  feature: LEDGER,
  params: journalParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The journal.', schema: journalDetailSchema },
    404: { description: 'No such journal.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) =>
      journalDetail(tx, principal, await journalOr404(tx, params.journalId)),
    );
    return { status: 200, body };
  },
});

const draftBodySchema = z.object({
  entryDate: z.iso.date(),
  memo: z.string().trim().max(2000).nullable().optional(),
  lines: linesSchema,
});

export const createJournalRoute = defineRoute({
  method: 'post',
  path: '/v1/ledger/journals',
  operationId: 'createJournal',
  summary: 'Draft a manual journal, or the opening balances',
  description:
    'A draft, posted later by someone other than its drafter. `kind: opening` is the company’s one opening-balances journal, dated on the start date (409 `opening_exists`). Lines need not balance until posting. Honours `Idempotency-Key`.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.post',
  feature: LEDGER,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: draftBodySchema.extend({ kind: z.enum(['manual', 'opening']).default('manual') }),
  responses: {
    201: { description: 'The draft.', schema: journalDetailSchema },
    409: { description: 'Not set up, a locked month, or an opening journal already exists.' },
    422: { description: 'A date before the start, or lines that cannot be used.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const settings = await requireSettings(tx);
      if (body.kind === 'opening') {
        if ((await tx.ledger.openingJournal()) !== undefined) {
          throw conflict('opening_exists', 'The opening balances journal already exists.');
        }
        if (body.entryDate !== settings.startDate) {
          throw unprocessable(
            'opening_date',
            `Date the opening balances on ${settings.startDate}.`,
            [
              {
                field: 'body.entryDate',
                code: 'opening_date',
                message: `Use ${settings.startDate}.`,
              },
            ],
          );
        }
      }
      await checkDate(tx, settings, body.entryDate, 'body.entryDate');
      const lines = await checkLines(tx, body.lines);
      const journal = await tx.ledger.createDraft(
        { kind: body.kind, entryDate: body.entryDate, memo: body.memo ?? null },
        lines,
        principal.userId,
      );
      await auditJournal(tx, context, 'ledger.journal_drafted', journal);
      return journalDetail(tx, principal, journal);
    });
    return { status: 201, body: detail };
  },
});

export const updateJournalRoute = defineRoute({
  method: 'put',
  path: '/v1/ledger/journals/:journalId',
  operationId: 'updateJournal',
  summary: 'Rewrite a draft',
  description:
    'Replaces the date, memo and lines of a manual or opening draft. Whoever rewrites it becomes its drafter, so its approver must be someone else (409 `not_draft` once posted).',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.post',
  feature: LEDGER,
  params: journalParams,
  query: noSchema,
  body: draftBodySchema,
  responses: {
    200: { description: 'The draft.', schema: journalDetailSchema },
    404: { description: 'No such journal.' },
    409: { description: 'Not a draft written by hand, or a locked month.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const settings = await requireSettings(tx);
      const journal = await tx.ledger.lock(params.journalId);
      if (journal === undefined) {
        throw notFound('This journal does not exist.');
      }
      if (journal.status !== 'draft' || (journal.kind !== 'manual' && journal.kind !== 'opening')) {
        throw conflict('not_draft', 'Only a draft written by hand is rewritten.');
      }
      if (journal.kind === 'opening' && body.entryDate !== settings.startDate) {
        throw unprocessable('opening_date', `Date the opening balances on ${settings.startDate}.`);
      }
      await checkDate(tx, settings, body.entryDate, 'body.entryDate');
      const lines = await checkLines(tx, body.lines);
      const rewritten = await tx.ledger.replaceDraft(
        journal.id,
        { entryDate: body.entryDate, memo: body.memo ?? null },
        lines,
        principal.userId,
      );
      if (rewritten === undefined) {
        throw conflict('not_draft', 'Only a draft is rewritten.');
      }
      await auditJournal(tx, context, 'ledger.journal_updated', rewritten);
      return journalDetail(tx, principal, rewritten);
    });
    return { status: 200, body: detail };
  },
});

export const discardJournalRoute = defineRoute({
  method: 'delete',
  path: '/v1/ledger/journals/:journalId',
  operationId: 'discardJournal',
  summary: 'Discard a draft',
  description: 'A posted journal is never deleted; reverse it (409 `not_draft`).',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.post',
  feature: LEDGER,
  params: journalParams,
  query: noSchema,
  body: noSchema,
  responses: {
    204: { description: 'Discarded.' },
    404: { description: 'No such journal.' },
    409: { description: 'Not a draft written by hand.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    await withTenant(principal.tenantId, async (tx) => {
      const journal = await tx.ledger.lock(params.journalId);
      if (journal === undefined) {
        throw notFound('This journal does not exist.');
      }
      if (journal.status !== 'draft' || (journal.kind !== 'manual' && journal.kind !== 'opening')) {
        throw conflict('not_draft', 'A posted journal is never deleted; reverse it.');
      }
      await tx.ledger.discardDraft(journal.id);
      await auditJournal(tx, context, 'ledger.journal_discarded', journal);
    });
    return { status: 204, body: undefined };
  },
});

export const postJournalRoute = defineRoute({
  method: 'post',
  path: '/v1/ledger/journals/:journalId/post',
  operationId: 'postJournal',
  summary: 'Post a draft',
  description:
    'Numbers it and freezes it. Someone other than its drafter posts it (409 `self_approval`), unless the owner allows self-approval and `selfApprove` is true, which the journal then shows. 422 `unbalanced`, `before_start`; 409 `period_locked`, `account_archived`.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.post',
  feature: LEDGER,
  params: journalParams,
  query: noSchema,
  body: z.object({ selfApprove: z.boolean().default(false) }),
  responses: {
    200: { description: 'The posted journal.', schema: journalDetailSchema },
    404: { description: 'No such journal.' },
    409: {
      description: 'Not a draft, a second person needed, a locked month or an archived account.',
    },
    422: { description: 'Unbalanced, or before the start.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const settings = await requireSettings(tx);
      const journal = await tx.ledger.lock(params.journalId);
      if (journal === undefined) {
        throw notFound('This journal does not exist.');
      }
      if (journal.status !== 'draft' || (journal.kind !== 'manual' && journal.kind !== 'opening')) {
        throw conflict('not_draft', 'Only a draft written by hand is posted here.');
      }
      const own = journal.draftedBy === principal.userId;
      if (own && !(settings.allowSelfApproval && body.selfApprove)) {
        throw conflict(
          'self_approval',
          settings.allowSelfApproval
            ? 'You drafted this journal: confirm that you approve it yourself.'
            : 'Someone other than the person who drafted this journal posts it.',
        );
      }
      await checkPostable(tx, settings, journal);
      const posted = await tx.ledger.post(journal.id, principal.userId, own);
      await auditJournal(tx, context, 'ledger.journal_posted', posted, { selfApproved: own });
      return journalDetail(tx, principal, posted);
    });
    return { status: 200, body: detail };
  },
});

export const reverseJournalRoute = defineRoute({
  method: 'post',
  path: '/v1/ledger/journals/:journalId/reverse',
  operationId: 'reverseJournal',
  summary: 'Reverse a posted journal',
  description:
    'Posts its mirror image, dated `entryDate` (default today) in an open month on or after the original. Once per journal (409 `already_reversed`); a closing journal is reversed by reopening its year (409 `closing_journal`). Honours `Idempotency-Key`.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.post',
  feature: LEDGER,
  idempotent: true,
  params: journalParams,
  query: noSchema,
  body: z.object({
    entryDate: z.iso.date().optional(),
    memo: z.string().trim().max(2000).nullable().optional(),
  }),
  responses: {
    201: { description: 'The reversal, posted.', schema: journalDetailSchema },
    404: { description: 'No such journal.' },
    409: { description: 'Not posted, already reversed, a closing journal, or a locked month.' },
    422: { description: 'Dated before the original or the start.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const settings = await requireSettings(tx);
      const reversal = await reverseJournal(tx, context, settings, params.journalId, {
        entryDate: body.entryDate ?? (await companyToday(tx)),
        memo: body.memo ?? null,
      });
      return journalDetail(tx, principal, reversal);
    });
    return { status: 201, body: detail };
  },
});

/** Posts the mirror image of a posted journal. Shared with reopening a year. */
export async function reverseJournal(
  tx: TenantTransaction,
  context: RequestContext,
  settings: LedgerSettings,
  journalId: string,
  input: { entryDate: string; memo: string | null },
  allowClosing = false,
): Promise<Journal> {
  const { principal } = context;
  const journal = await tx.ledger.lock(journalId);
  if (journal === undefined) {
    throw notFound('This journal does not exist.');
  }
  if (journal.status !== 'posted') {
    throw conflict('not_posted', 'Only a posted journal is reversed; a draft is discarded.');
  }
  if (journal.kind === 'reversal') {
    throw conflict(
      'reversal_of_reversal',
      'A reversal is not reversed; post the journal again instead.',
    );
  }
  if (journal.kind === 'closing' && !allowClosing) {
    throw conflict(
      'closing_journal',
      'A year-end closing journal is reversed by reopening the year.',
    );
  }
  if ((await tx.ledger.reversalFor(journal.id)) !== undefined) {
    throw conflict('already_reversed', 'This journal has already been reversed.');
  }
  if (input.entryDate < journal.entryDate) {
    throw unprocessable(
      'reversal_before_original',
      `Date the reversal on or after ${journal.entryDate}.`,
      [
        {
          field: 'body.entryDate',
          code: 'reversal_before_original',
          message: `Use ${journal.entryDate} or later.`,
        },
      ],
    );
  }
  await checkDate(tx, settings, input.entryDate, 'body.entryDate');
  const lines = await tx.ledger.lines(journal.id);
  const reference = journal.reference === null ? '' : formatJournalReference(journal.reference);
  const draft = await tx.ledger.createDraft(
    {
      kind: 'reversal',
      entryDate: input.entryDate,
      memo: input.memo ?? `Reversal of ${reference}`,
      reversalOf: journal.id,
      ...(journal.foreignCurrency === null ||
      journal.exchangeRate === null ||
      journal.rateSource === null
        ? {}
        : {
            foreign: {
              currency: journal.foreignCurrency,
              rate: journal.exchangeRate,
              source: journal.rateSource,
            },
          }),
    },
    lines.map((line) => ({
      accountId: line.accountId,
      // The mirror image: each debit becomes a credit and each credit a debit.
      debit: line.credit === '0' ? undefined : line.credit,
      credit: line.debit === '0' ? undefined : line.debit,
      memo: line.memo,
      customerId: line.customerId,
      foreignAmount: line.foreignAmount,
    })),
    principal.userId,
  );
  const posted = await tx.ledger.post(draft.id, principal.userId);
  await auditJournal(tx, context, 'ledger.journal_reversed', posted, { reverses: reference });
  return posted;
}

export const openingReceivablesRoute = defineRoute({
  method: 'get',
  path: '/v1/ledger/opening-receivables',
  operationId: 'getOpeningReceivables',
  summary: 'What customers owed at the start date, for the opening journal',
  description:
    'Per customer, in the company currency: invoices issued before the start date (and not voided before it), less credit notes and payments before it. Documents in other currencies are counted, not included.',
  tags: LEDGER_TAGS,
  security: 'authenticated',
  permission: 'ledger.post',
  feature: LEDGER,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'Lines to start from.',
      schema: z.object({
        date: z.iso.date(),
        accountId: z.uuid(),
        items: z.array(
          z.object({ customer: z.object({ id: z.uuid(), name: z.string() }), amount: z.string() }),
        ),
      }),
    },
  },
  handler: async (_request, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const settings = await requireSettings(tx);
      const company = await tx.settings.get();
      const owed = await tx.ledger.receivablesAt(settings.startDate, company.currency);
      const customers = new Map(
        (await tx.customers.findMany(owed.map((row) => row.customerId))).map((customer) => [
          customer.id,
          customer.name,
        ]),
      );
      return {
        date: settings.startDate,
        accountId: settings.accounts.receivables,
        items: owed.map((row) => ({
          customer: { id: row.customerId, name: customers.get(row.customerId) ?? '' },
          amount: row.amount,
        })),
      };
    });
    return { status: 200, body };
  },
});

export const ledgerRoutes = [
  ledgerOverviewRoute,
  setUpLedgerRoute,
  saveLedgerSettingsRoute,
  listAccountsRoute,
  createAccountRoute,
  updateAccountRoute,
  listPeriodsRoute,
  lockPeriodRoute,
  unlockPeriodRoute,
  listJournalsRoute,
  getJournalRoute,
  createJournalRoute,
  updateJournalRoute,
  discardJournalRoute,
  postJournalRoute,
  reverseJournalRoute,
  openingReceivablesRoute,
];
