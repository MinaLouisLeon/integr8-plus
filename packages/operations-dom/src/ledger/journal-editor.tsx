import { fromUnits, toUnits } from '@integr8/core';
import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  type JournalDetail,
  keys,
  type LedgerOverview,
  type OpeningReceivables,
  useOperations,
} from '../api.js';
import { useIdempotencyKey } from '../purchasing/purchasing-parts.js';
import { BackLink, buttonClass, cardClass, Field, inputClass, Loading } from '../ui.js';
import {
  AppLink,
  blankLine,
  draftTotals,
  JournalLinesEditor,
  LedgerFailure,
  lineBodies,
  lineDraftOf,
  type LineDraft,
  linesReady,
  ManagementNote,
  Notice,
  useLedgerAccess,
  useLedgerAccounts,
  useLedgerOverview,
} from './ledger-parts.js';

interface Draft {
  entryDate: string;
  memo: string;
  lines: LineDraft[];
}

/** The draft a new manual journal starts from: today, or the start date if today is before it. */
function manualDraft(overview: LedgerOverview): Draft {
  const start = overview.settings?.startDate ?? overview.today;
  return {
    entryDate: overview.today < start ? start : overview.today,
    memo: '',
    lines: [blankLine(), blankLine()],
  };
}

/**
 * The opening balances start from what customers owed at the start date: a
 * debit to receivables for each customer who owed (a credit for one in
 * credit), balanced against the opening-balances account. The rest — cash,
 * bank, stock, what the company owes — is typed in.
 */
function openingDraft(
  overview: LedgerOverview,
  receivables: OpeningReceivables | undefined,
  memo: string,
): Draft {
  const settings = overview.settings!;
  const owed = (receivables?.items ?? []).filter((item) => toUnits(item.amount) !== 0n);
  if (receivables === undefined || owed.length === 0) {
    return { entryDate: settings.startDate, memo, lines: [blankLine(), blankLine()] };
  }
  const lines: LineDraft[] = owed.map((item) => {
    const amount = toUnits(item.amount);
    return {
      ...blankLine(),
      accountId: receivables.accountId,
      debit: amount > 0n ? fromUnits(amount) : '',
      credit: amount < 0n ? fromUnits(-amount) : '',
      customer: item.customer,
    };
  });
  const net = owed.reduce((total, item) => total + toUnits(item.amount), 0n);
  const balancing = settings.accounts.openingBalances ?? '';
  if (net !== 0n) {
    lines.push({
      ...blankLine(),
      accountId: balancing,
      debit: net < 0n ? fromUnits(-net) : '',
      credit: net > 0n ? fromUnits(net) : '',
    });
  }
  if (lines.length < 2) {
    lines.push(blankLine());
  }
  return { entryDate: settings.startDate, memo, lines };
}

function editDraft(journal: JournalDetail): Draft {
  return {
    entryDate: journal.entryDate,
    memo: journal.memo ?? '',
    lines: journal.lines.map(lineDraftOf),
  };
}

/**
 * Drafts a manual journal or the opening balances, or rewrites a draft
 * (ADR-0009). A draft need not balance; it must to be posted, which someone
 * other than its drafter does unless the owner allows otherwise. Totals and
 * the balance show as lines are typed.
 */
export function JournalEditorScreen({
  journalId,
  opening = false,
}: {
  /** The draft to rewrite; absent for a new journal. */
  journalId?: string;
  /** A new opening-balances journal rather than a manual one. */
  opening?: boolean;
}) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const access = useLedgerAccess();
  const overview = useLedgerOverview();
  const accounts = useLedgerAccounts(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const existing = useQuery({
    queryKey: keys.journal(journalId ?? ''),
    queryFn: async () =>
      (
        await client.GET('/v1/ledger/journals/{journalId}', {
          params: { path: { journalId: journalId! } },
        })
      ).data!,
    enabled: journalId !== undefined,
  });
  const kind: 'manual' | 'opening' =
    journalId === undefined
      ? opening
        ? 'opening'
        : 'manual'
      : existing.data?.kind === 'opening'
        ? 'opening'
        : 'manual';
  const prefill = journalId === undefined && kind === 'opening';
  const receivables = useQuery({
    queryKey: keys.openingReceivables,
    queryFn: async () => (await client.GET('/v1/ledger/opening-receivables')).data!,
    enabled: prefill && access.post && overview.data?.setUp === true,
  });

  const loaded =
    access.loaded &&
    overview.data !== undefined &&
    accounts.data !== undefined &&
    (journalId === undefined || existing.data !== undefined) &&
    (!prefill || !access.post || receivables.data !== undefined || receivables.isError);
  // Worked out once from what loaded, so the lines keep their keys until the first edit.
  const openingMemo = t('ledger.editor.openingMemo');
  const initial = useMemo<Draft | null>(
    () =>
      !loaded || overview.data === undefined
        ? null
        : existing.data !== undefined
          ? editDraft(existing.data)
          : prefill
            ? openingDraft(overview.data, receivables.data, openingMemo)
            : manualDraft(overview.data),
    [loaded, overview.data, existing.data, prefill, receivables.data, openingMemo],
  );
  const values = draft ?? initial;

  const body = {
    entryDate: values?.entryDate ?? '',
    memo: values === null || values.memo.trim() === '' ? null : values.memo.trim(),
    lines: values === null ? [] : lineBodies(values.lines),
  };
  const idempotencyKey = useIdempotencyKey({ kind, ...body });
  const save = useMutation({
    mutationFn: async () =>
      journalId === undefined
        ? (
            await client.POST('/v1/ledger/journals', {
              params: { header: { 'Idempotency-Key': idempotencyKey } },
              body: { kind, ...body },
            })
          ).data!
        : (
            await client.PUT('/v1/ledger/journals/{journalId}', {
              params: { path: { journalId } },
              body,
            })
          ).data!,
    onSuccess: async (saved) => {
      queries.setQueryData(keys.journal(saved.id), saved);
      await queries.invalidateQueries({ queryKey: ['ledger'] });
      navigate(paths.journal(saved.id));
    },
  });

  const back =
    journalId === undefined ? (
      <BackLink to={paths.journals} label={t('ledger.journals.back')} />
    ) : (
      <BackLink to={paths.journal(journalId)} label={t('ledger.editor.backToJournal')} />
    );
  const failed = [overview, accounts, existing].find((query) => query.isError);
  if (failed !== undefined) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <LedgerFailure error={failed.error} onRetry={() => void failed.refetch()} />
      </div>
    );
  }
  if (values === null || overview.data === undefined || accounts.data === undefined) {
    return <Loading />;
  }
  const ledger = overview.data;
  if (!ledger.setUp) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Notice>
          <p>{t('ledger.home.notSetUp')}</p>
        </Notice>
      </div>
    );
  }
  if (journalId === undefined && kind === 'opening' && ledger.openingJournal !== null) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Notice>
          <p>{t('ledger.editor.openingExists')}</p>
          <AppLink to={paths.journal(ledger.openingJournal.id)} className="self-start">
            {t('ledger.editor.openingOpen')}
          </AppLink>
        </Notice>
      </div>
    );
  }
  if (existing.data !== undefined && !existing.data.can.edit) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Notice>
          <p>{t('ledger.editor.cannotEdit')}</p>
        </Notice>
      </div>
    );
  }

  const currency = ledger.currency;
  const startDate = ledger.settings!.startDate;
  const totals = draftTotals(values.lines);
  const ready = values.entryDate !== '' && linesReady(values.lines);
  const set = (change: Partial<Draft>) => setDraft({ ...values, ...change });
  const title =
    journalId === undefined
      ? kind === 'opening'
        ? t('ledger.editor.newOpening')
        : t('ledger.editor.newManual')
      : kind === 'opening'
        ? t('ledger.editor.editOpening')
        : t('ledger.editor.editManual');

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content">{title}</h1>
        <p className="text-sm text-content-muted">
          {kind === 'opening' ? t('ledger.editor.openingIntro') : t('ledger.editor.manualIntro')}
        </p>
        <ManagementNote />
      </header>

      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            save.mutate();
          }
        }}
      >
        <section className={cardClass} aria-labelledby="journal-details">
          <h2 id="journal-details" className="text-base font-semibold text-content">
            {t('ledger.editor.details')}
          </h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              label={t('ledger.editor.entryDate')}
              hint={
                kind === 'opening'
                  ? t('ledger.editor.openingDateHint', {
                      date: formatCalendarDate(startDate, { locale }),
                    })
                  : t('ledger.editor.entryDateHint', {
                      date: formatCalendarDate(startDate, { locale }),
                    })
              }
            >
              {(id, describedBy) => (
                <input
                  id={id}
                  type="date"
                  dir="ltr"
                  required
                  aria-describedby={describedBy}
                  min={startDate}
                  disabled={kind === 'opening'}
                  className={inputClass}
                  value={values.entryDate}
                  onChange={(event) => set({ entryDate: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('ledger.editor.memo')} className="sm:col-span-2">
              {(id) => (
                <textarea
                  id={id}
                  rows={2}
                  maxLength={2000}
                  dir="auto"
                  className={inputClass}
                  value={values.memo}
                  onChange={(event) => set({ memo: event.target.value })}
                />
              )}
            </Field>
          </div>
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="journal-lines">
          <h2 id="journal-lines" className="text-base font-semibold text-content">
            {t('ledger.editor.lines')}
          </h2>
          {prefill && receivables.data !== undefined && receivables.data.items.length > 0 ? (
            <p className="text-sm text-content-muted">{t('ledger.editor.openingPrefilled')}</p>
          ) : null}
          {prefill && receivables.isError ? (
            <p className="text-sm text-content-muted">{t('ledger.editor.openingNoPrefill')}</p>
          ) : null}
          <JournalLinesEditor
            lines={values.lines}
            onChange={(lines) => set({ lines })}
            accounts={accounts.data}
            currency={currency}
            receivablesId={ledger.settings?.accounts.receivables}
          />
          {!totals.balanced ? (
            <p className="text-sm text-content-muted">{t('ledger.editor.unbalancedNote')}</p>
          ) : null}
        </section>

        {save.isError ? <LedgerFailure error={save.error} /> : null}
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={buttonClass.primary} disabled={!ready || save.isPending}>
            {save.isPending ? t('ledger.saving') : t('ledger.editor.saveDraft')}
          </button>
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() =>
              navigate(journalId === undefined ? paths.journals : paths.journal(journalId))
            }
          >
            {t('ledger.cancel')}
          </button>
        </div>
        {!ready ? (
          <p className="text-sm text-content-muted">{t('ledger.editor.notReady')}</p>
        ) : null}
      </form>
    </div>
  );
}
