import { ApiRequestError } from '@integr8/api-client';
import { ACCOUNT_TYPES, fromUnits, hasFeature, journalTotals, toUnits } from '@integr8/core';
import { apiErrorCodeMessage, type TFunction, useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  type JournalDetail,
  type JournalKindKey,
  keys,
  type LedgerAccount,
  type PostingReason,
  type PostingSourceKind,
  useOperations,
} from '../api.js';
import { formatAmount } from '../crm/lead-parts.js';
import { CustomerPicker } from '../crm/opportunity-parts.js';
import { buttonClass, Dialog, Failure, inputClass } from '../ui.js';

/**
 * Pieces the ledger screens share (CRM/ERP plan, phase A1; ADR-0009): who may
 * do what, the overview and the chart, amounts in the company's currency, the
 * refusals the server gives in words of this language, and the journal-lines
 * editor used to draft a journal and to write out a waiting document.
 *
 * Money is a decimal string from end to end: it is added up with the core's
 * integer arithmetic, never as a JavaScript number.
 */

/** What this seat may do with the company's ledger. */
export function useLedgerAccess() {
  const { client } = useOperations();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const permissions = me.data?.permissions ?? [];
  const enabled = me.data !== undefined && hasFeature(me.data.features, 'ledger');
  return {
    loaded: me.data !== undefined,
    enabled,
    userId: me.data?.userId ?? null,
    read: enabled && permissions.includes('ledger.read'),
    post: enabled && permissions.includes('ledger.post'),
    manage: enabled && permissions.includes('ledger.manage'),
    unlock: enabled && permissions.includes('ledger.unlock'),
    /** Modules whose documents the ledger may post: staff expenses (HR) and pay runs. */
    hr: me.data !== undefined && hasFeature(me.data.features, 'hr'),
    payroll: me.data !== undefined && hasFeature(me.data.features, 'payroll'),
  };
}

/** Whether the ledger is set up, its settings, today in the company's calendar, and what is waiting. */
export function useLedgerOverview() {
  const { client } = useOperations();
  return useQuery({
    queryKey: keys.ledger,
    queryFn: async () => (await client.GET('/v1/ledger')).data!,
  });
}

/** The chart of accounts, by code; archived ones only when asked for. */
export function useLedgerAccounts(includeArchived = false, enabled = true) {
  const { client } = useOperations();
  return useQuery({
    queryKey: keys.ledgerAccounts(includeArchived),
    queryFn: async () =>
      (
        await client.GET('/v1/ledger/accounts', {
          params: { query: includeArchived ? { archived: 'true' } : {} },
        })
      ).data!.items,
    enabled,
  });
}

// ---------------------------------------------------------------------------
// Amounts and dates
// ---------------------------------------------------------------------------

/** What an amount field accepts: digits with up to four places, as the API does. */
export const AMOUNT_PATTERN = String.raw`\d{1,16}(\.\d{1,4})?`;
const AMOUNT = /^\d{1,16}(\.\d{1,4})?$/u;

/** A positive amount the API will take. */
export function isAmount(text: string): boolean {
  return AMOUNT.test(text.trim()) && toUnits(text.trim()) > 0n;
}

/** What a typed amount counts for in a live total: nothing until it is a valid amount. */
export function amountOrZero(text: string): string {
  return AMOUNT.test(text.trim()) ? text.trim() : '0';
}

/** A rate of the company's currency per unit of another, as the API takes it. */
export function isRate(text: string): boolean {
  return /^\d{1,10}(\.\d{1,10})?$/u.test(text.trim()) && /[1-9]/u.test(text);
}

export const isZero = (value: string) => toUnits(value) === 0n;

/** An amount in a currency, with its digits lined up; empty for zero when asked. */
export function Amount({
  value,
  currency,
  blankZero = false,
  strong = false,
}: {
  value: string;
  currency: string | null;
  blankZero?: boolean;
  strong?: boolean;
}) {
  const { locale } = useOperations();
  if (blankZero && isZero(value)) {
    return null;
  }
  return (
    <span className={`tabular-nums whitespace-nowrap ${strong ? 'font-semibold' : ''}`}>
      {formatAmount(value, currency, locale)}
    </span>
  );
}

/** `2026-10-01` as `October 2026`, in the reader's language. */
export function formatMonth(month: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${month.slice(0, 7)}-01T12:00:00Z`));
  } catch {
    return month.slice(0, 7);
  }
}

/** The month names, January first, in the reader's language. */
export function monthNames(locale: string): string[] {
  return Array.from({ length: 12 }, (_unused, index) => {
    try {
      return new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(
        new Date(Date.UTC(2026, index, 15)),
      );
    } catch {
      return String(index + 1);
    }
  });
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** Why a document waits, in the order the screens list them; checked whole against the API's own. */
const REASON_ORDER: Record<PostingReason, number> = {
  queued: 0,
  auto_off: 1,
  foreign_currency: 2,
  cost_unknown: 3,
  waits_for_invoice: 4,
  period_locked: 5,
  before_set_up: 6,
  failed: 7,
};
export const POSTING_REASONS = (Object.keys(REASON_ORDER) as PostingReason[]).sort(
  (left, right) => REASON_ORDER[left] - REASON_ORDER[right],
);

/** The code of an API refusal, when it is one. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof ApiRequestError ? error.code : undefined;
}

/**
 * A request the ledger refused, in words (ADR-0012) — with the ledger's own
 * wording where a code means more here, and line by line where the server
 * says which line.
 */
export function LedgerFailure({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  const overrides = {
    self_approval: t('ledger.errors.self_approval'),
    not_posted: t('ledger.errors.not_posted'),
    account_not_usable: t('ledger.errors.account_not_usable'),
    code_taken: t('ledger.errors.code_taken'),
  };
  const lines =
    error instanceof ApiRequestError && error.status !== 404
      ? error.details.flatMap((detail) => {
          const line = /^body\.lines\.(\d+)\./u.exec(detail.field);
          const problem = apiErrorCodeMessage(detail.code, t, overrides);
          if (problem === undefined || detail.code === error.code) {
            return [];
          }
          return [
            line === null
              ? problem
              : t('ledger.errors.onLine', { line: Number(line[1]) + 1, problem }),
          ];
        })
      : undefined;
  return (
    <Failure
      error={error}
      onRetry={onRetry}
      overrides={overrides}
      {...(lines === undefined ? {} : { lines: [...new Set(lines)] })}
    />
  );
}

/** The line every ledger screen carries: what this ledger is, and what it is not. */
export function ManagementNote({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  return <p className={`text-sm text-content-muted ${className}`}>{t('ledger.managementNote')}</p>;
}

/** A journal's state, in words. */
export function JournalStatusBadge({ status }: { status: 'draft' | 'posted' }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
        status === 'posted'
          ? 'border-success text-content'
          : 'border-border-subtle bg-surface-muted text-content'
      }`}
    >
      {t(`ledger.journalStatus.${status}`)}
    </span>
  );
}

/** A journal's reference, or that it is a draft. */
export function journalTitle(journal: { reference: string | null }, t: TFunction): string {
  return journal.reference ?? t('ledger.journals.draftLabel');
}

export function useKindName(): (kind: JournalKindKey) => string {
  const { t } = useTranslation();
  return (kind) => t(`ledger.kind.${kind}`);
}

export function useReasonName(): (reason: PostingReason) => string {
  const { t } = useTranslation();
  return (reason) => t(`ledger.reason.${reason}`);
}

/** A captured document's own name: its reference, or that it is a stock movement. */
export function documentLabel(
  posting: { label: string | null; source: { kind: PostingSourceKind } },
  t: TFunction,
): string {
  return posting.label ?? t(`ledger.source.${posting.source.kind}`);
}

/** A link inside the app: a real link, followed through the app's own navigation. */
export function AppLink({
  to,
  children,
  className = '',
  ltr = false,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  ltr?: boolean;
}) {
  const { navigate } = useOperations();
  return (
    <a
      href={to}
      {...(ltr ? { dir: 'ltr' } : {})}
      className={`text-accent underline-offset-4 hover:underline ${className}`}
      onClick={(event) => {
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/**
 * Where the document behind a journal lives: an invoice or its void opens
 * the invoice, a payment the payment. A credit note's journal does not say
 * which invoice it credits, and stock has no page of its own.
 */
export function useSourceLink(): (
  journal: Pick<JournalDetail, 'source' | 'sourceInvoiceId'>,
) => string | undefined {
  const { paths } = useOperations();
  return ({ source, sourceInvoiceId }) => {
    if (source === null) {
      return undefined;
    }
    if (source.kind === 'payment') {
      return paths.payment(source.id);
    }
    // An invoice, its void, or the invoice a credit note credits; stock has no page.
    return sourceInvoiceId === null ? undefined : paths.invoice(sourceInvoiceId);
  };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** `1200 · Accounts receivable`. */
export const accountLabel = (account: { code: string; name: string }) =>
  `${account.code} · ${account.name}`;

/** A choice of account from the chart, by type and then code. */
export function AccountSelect({
  id,
  accounts,
  value,
  onChange,
  describedBy,
  label,
  disabled = false,
  required = false,
  emptyLabel,
}: {
  id?: string;
  accounts: readonly LedgerAccount[];
  value: string;
  onChange: (accountId: string) => void;
  describedBy?: string | undefined;
  /** An accessible name, when no visible label points at it. */
  label?: string;
  disabled?: boolean;
  required?: boolean;
  emptyLabel?: string;
}) {
  const { t } = useTranslation();
  // An archived account already chosen stays listed, so the choice is not silently lost.
  const usable = accounts.filter((account) => !account.archived || account.id === value);
  return (
    <select
      {...(id === undefined ? {} : { id })}
      {...(label === undefined ? {} : { 'aria-label': label })}
      aria-describedby={describedBy}
      className={inputClass}
      value={value}
      disabled={disabled}
      required={required}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{emptyLabel ?? t('ledger.lines.chooseAccount')}</option>
      {ACCOUNT_TYPES.map((type) => {
        const ofType = usable.filter((account) => account.type === type);
        return ofType.length === 0 ? null : (
          <optgroup key={type} label={t(`ledger.accountType.${type}`)}>
            {ofType.map((account) => (
              <option key={account.id} value={account.id}>
                {accountLabel(account)}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Journal lines
// ---------------------------------------------------------------------------

/** One line as it is being written. */
export interface LineDraft {
  key: string;
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
  customer: { id: string; name: string } | null;
}

export function blankLine(): LineDraft {
  return {
    key: crypto.randomUUID(),
    accountId: '',
    debit: '',
    credit: '',
    memo: '',
    customer: null,
  };
}

/** A line from what the server has: a debit or a credit, never both. */
export function lineDraftOf(line: {
  account: { id: string };
  debit: string;
  credit: string;
  memo?: string | null;
  customer: { id: string; name: string } | null;
}): LineDraft {
  return {
    key: crypto.randomUUID(),
    accountId: line.account.id,
    debit: isZero(line.debit) ? '' : line.debit,
    credit: isZero(line.credit) ? '' : line.credit,
    memo: line.memo ?? '',
    customer: line.customer,
  };
}

const isBlank = (line: LineDraft) =>
  line.accountId === '' &&
  line.debit.trim() === '' &&
  line.credit.trim() === '' &&
  line.memo.trim() === '' &&
  line.customer === null;

/** A line the API will take: an account, and an amount on exactly one side. */
export function lineComplete(line: LineDraft): boolean {
  const debit = line.debit.trim() !== '';
  const credit = line.credit.trim() !== '';
  return (
    line.accountId !== '' &&
    debit !== credit &&
    (debit ? isAmount(line.debit) : isAmount(line.credit))
  );
}

/** The lines worth sending: blank rows dropped. */
export const filledLines = (lines: readonly LineDraft[]) => lines.filter((line) => !isBlank(line));

/** Whether every filled line is complete, and there are two or more. */
export function linesReady(lines: readonly LineDraft[]): boolean {
  const filled = filledLines(lines);
  return filled.length >= 2 && filled.length <= 500 && filled.every(lineComplete);
}

/** The lines as the API takes them. */
export function lineBodies(lines: readonly LineDraft[]) {
  return filledLines(lines).map((line) => ({
    accountId: line.accountId,
    ...(line.debit.trim() === '' ? { credit: line.credit.trim() } : { debit: line.debit.trim() }),
    ...(line.memo.trim() === '' ? {} : { memo: line.memo.trim() }),
    ...(line.customer === null ? {} : { customerId: line.customer.id }),
  }));
}

/** Debits, credits, and how far apart they are, from the core's integer arithmetic. */
export function draftTotals(lines: readonly LineDraft[]) {
  const totals = journalTotals(
    filledLines(lines).map((line) => ({
      debit: amountOrZero(line.debit),
      credit: amountOrZero(line.credit),
    })),
  );
  return {
    ...totals,
    difference: fromUnits(toUnits(totals.debit) - toUnits(totals.credit)),
  };
}

/** Whether the lines balance, and if not by how much: in words, never colour alone. */
export function BalanceIndicator({
  totals,
  currency,
}: {
  totals: { debit: string; credit: string; balanced: boolean; difference: string };
  currency: string;
}) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const gap = toUnits(totals.difference);
  const text = totals.balanced
    ? t('ledger.lines.balanced')
    : gap === 0n
      ? t('ledger.lines.nothingYet')
      : t(gap > 0n ? 'ledger.lines.moreDebit' : 'ledger.lines.moreCredit', {
          amount: formatAmount(fromUnits(gap > 0n ? gap : -gap), currency, locale),
        });
  return (
    <p
      role="status"
      className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${
        totals.balanced
          ? 'border-success text-content'
          : 'border-warning bg-warning-subtle text-content'
      }`}
    >
      <span aria-hidden="true">{totals.balanced ? '✓' : '≠'}</span>
      {text}
    </p>
  );
}

/**
 * Writes a journal's lines: an account, a debit or a credit, a customer on
 * a receivables line, and a note. Totals and whether they balance update as
 * amounts are typed.
 */
export function JournalLinesEditor({
  lines,
  onChange,
  accounts,
  currency,
  receivablesId,
}: {
  lines: readonly LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  accounts: readonly LedgerAccount[];
  currency: string;
  /** The receivables account: a line on it may name its customer. */
  receivablesId: string | undefined;
}) {
  const { t } = useTranslation();
  const [choosing, setChoosing] = useState<string | null>(null);
  const totals = draftTotals(lines);
  const update = (key: string, change: Partial<LineDraft>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...change } : line)));

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-lg border border-border-subtle">
        <table className="w-full min-w-[48rem] text-sm">
          <thead className="bg-surface-muted text-content-muted">
            <tr>
              <th scope="col" className="px-2 py-2 text-start font-medium">
                {t('ledger.lines.account')}
              </th>
              <th scope="col" className="w-36 px-2 py-2 text-end font-medium">
                {t('ledger.lines.debit')}
              </th>
              <th scope="col" className="w-36 px-2 py-2 text-end font-medium">
                {t('ledger.lines.credit')}
              </th>
              <th scope="col" className="px-2 py-2 text-start font-medium">
                {t('ledger.lines.customer')}
              </th>
              <th scope="col" className="px-2 py-2 text-start font-medium">
                {t('ledger.lines.memo')}
              </th>
              <th scope="col" className="w-10 px-2 py-2">
                <span className="sr-only">{t('ledger.lines.remove')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {lines.map((line, index) => {
              const number = index + 1;
              const customerAllowed =
                line.customer !== null ||
                (receivablesId !== undefined && line.accountId === receivablesId);
              return (
                <tr key={line.key} className="align-top">
                  <td className="px-2 py-2">
                    <AccountSelect
                      accounts={accounts}
                      value={line.accountId}
                      label={t('ledger.lines.accountFor', { line: number })}
                      onChange={(accountId) =>
                        update(line.key, {
                          accountId,
                          ...(accountId === receivablesId ? {} : { customer: null }),
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input
                      aria-label={t('ledger.lines.debitFor', { line: number })}
                      inputMode="decimal"
                      dir="ltr"
                      pattern={AMOUNT_PATTERN}
                      aria-invalid={line.debit.trim() !== '' && !isAmount(line.debit)}
                      className={`${inputClass} text-end tabular-nums`}
                      value={line.debit}
                      onChange={(event) =>
                        update(line.key, {
                          debit: event.target.value.trim(),
                          ...(event.target.value.trim() === '' ? {} : { credit: '' }),
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input
                      aria-label={t('ledger.lines.creditFor', { line: number })}
                      inputMode="decimal"
                      dir="ltr"
                      pattern={AMOUNT_PATTERN}
                      aria-invalid={line.credit.trim() !== '' && !isAmount(line.credit)}
                      className={`${inputClass} text-end tabular-nums`}
                      value={line.credit}
                      onChange={(event) =>
                        update(line.key, {
                          credit: event.target.value.trim(),
                          ...(event.target.value.trim() === '' ? {} : { debit: '' }),
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-2">
                    {line.customer !== null ? (
                      <span className="flex items-center gap-1">
                        <span className="min-w-0 truncate">{line.customer.name}</span>
                        <button
                          type="button"
                          className={buttonClass.ghost}
                          aria-label={t('ledger.lines.removeCustomer', { line: number })}
                          onClick={() => update(line.key, { customer: null })}
                        >
                          ✕
                        </button>
                      </span>
                    ) : customerAllowed ? (
                      <button
                        type="button"
                        className={buttonClass.ghost}
                        aria-label={t('ledger.lines.chooseCustomerFor', { line: number })}
                        onClick={() => setChoosing(line.key)}
                      >
                        {t('ledger.lines.chooseCustomer')}
                      </button>
                    ) : null}
                  </td>
                  <td className="px-2 py-2">
                    <input
                      aria-label={t('ledger.lines.memoFor', { line: number })}
                      maxLength={500}
                      dir="auto"
                      className={inputClass}
                      value={line.memo}
                      onChange={(event) => update(line.key, { memo: event.target.value })}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      className={buttonClass.ghost}
                      aria-label={t('ledger.lines.removeLine', { line: number })}
                      disabled={lines.length <= 2}
                      onClick={() => onChange(lines.filter((other) => other.key !== line.key))}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-border-subtle bg-surface-muted">
            <tr>
              <th scope="row" className="px-2 py-2 text-start font-medium text-content">
                {t('ledger.lines.totals')}
              </th>
              <td className="px-2 py-2 text-end">
                <Amount value={totals.debit} currency={currency} strong />
              </td>
              <td className="px-2 py-2 text-end">
                <Amount value={totals.credit} currency={currency} strong />
              </td>
              <td colSpan={3} />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          className={buttonClass.secondary}
          disabled={lines.length >= 500}
          onClick={() => onChange([...lines, blankLine()])}
        >
          {t('ledger.lines.add')}
        </button>
        <BalanceIndicator totals={totals} currency={currency} />
      </div>
      {choosing === null ? null : (
        <ChooseCustomerDialog
          onClose={() => setChoosing(null)}
          onChoose={(customer) => {
            update(choosing, { customer });
            setChoosing(null);
          }}
        />
      )}
    </div>
  );
}

function ChooseCustomerDialog({
  onClose,
  onChoose,
}: {
  onClose: () => void;
  onChoose: (customer: { id: string; name: string }) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={t('ledger.lines.chooseCustomer')}
      onClose={onClose}
      footer={
        <button type="button" className={buttonClass.secondary} onClick={onClose}>
          {t('ledger.cancel')}
        </button>
      }
    >
      <CustomerPicker
        label={t('ledger.lines.customer')}
        value={null}
        onChange={(customer) => {
          if (customer !== null) {
            onChoose({ id: customer.id, name: customer.name });
          }
        }}
      />
    </Dialog>
  );
}

/** Lines already written, read-only: a posted journal's, or a waiting document's proposal. */
export function LinesTable({
  lines,
  currency,
  totals,
  foreignCurrency,
  caption,
}: {
  lines: readonly {
    key: string;
    account: { code: string; name: string };
    debit: string;
    credit: string;
    memo?: string | null;
    customer: { name: string } | null;
    foreignAmount?: string | null;
  }[];
  currency: string;
  totals: { debit: string; credit: string };
  /** When the journal came from another currency: each line's amount in it. */
  foreignCurrency?: string | undefined;
  caption?: string;
}) {
  const { t } = useTranslation();
  const memos = lines.some((line) => (line.memo ?? '') !== '');
  return (
    <div className="overflow-x-auto rounded-lg border border-border-subtle">
      <table className="w-full text-sm">
        {caption === undefined ? null : <caption className="sr-only">{caption}</caption>}
        <thead className="bg-surface-muted text-content-muted">
          <tr>
            <th scope="col" className="px-3 py-2 text-start font-medium">
              {t('ledger.lines.account')}
            </th>
            <th scope="col" className="px-3 py-2 text-start font-medium">
              {t('ledger.lines.customer')}
            </th>
            {memos ? (
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('ledger.lines.memo')}
              </th>
            ) : null}
            {foreignCurrency === undefined ? null : (
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t('ledger.lines.foreignAmount', { currency: foreignCurrency })}
              </th>
            )}
            <th scope="col" className="px-3 py-2 text-end font-medium">
              {t('ledger.lines.debit')}
            </th>
            <th scope="col" className="px-3 py-2 text-end font-medium">
              {t('ledger.lines.credit')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {lines.map((line) => (
            <tr key={line.key}>
              <td className="px-3 py-2 text-content">
                <span dir="ltr" className="me-2 tabular-nums text-content-muted">
                  {line.account.code}
                </span>
                {line.account.name}
              </td>
              <td className="px-3 py-2 text-content">{line.customer?.name ?? ''}</td>
              {memos ? (
                <td className="px-3 py-2 text-content" dir="auto">
                  {line.memo ?? ''}
                </td>
              ) : null}
              {foreignCurrency === undefined ? null : (
                <td className="px-3 py-2 text-end text-content-muted">
                  {line.foreignAmount === null || line.foreignAmount === undefined ? null : (
                    <Amount value={line.foreignAmount} currency={foreignCurrency} />
                  )}
                </td>
              )}
              <td className="px-3 py-2 text-end text-content">
                <Amount value={line.debit} currency={currency} blankZero />
              </td>
              <td className="px-3 py-2 text-end text-content">
                <Amount value={line.credit} currency={currency} blankZero />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-border-subtle bg-surface-muted">
          <tr>
            <th
              scope="row"
              colSpan={2 + (memos ? 1 : 0) + (foreignCurrency === undefined ? 0 : 1)}
              className="px-3 py-2 text-start font-medium text-content"
            >
              {t('ledger.lines.totals')}
            </th>
            <td className="px-3 py-2 text-end text-content">
              <Amount value={totals.debit} currency={currency} strong />
            </td>
            <td className="px-3 py-2 text-end text-content">
              <Amount value={totals.credit} currency={currency} strong />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** A note set apart from the page: a warning in words with an icon, never colour alone. */
export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning';
  children: ReactNode;
}) {
  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border p-4 text-start text-sm text-content ${
        tone === 'warning'
          ? 'border-warning bg-warning-subtle'
          : 'border-border-subtle bg-surface-muted'
      }`}
    >
      {children}
    </div>
  );
}
