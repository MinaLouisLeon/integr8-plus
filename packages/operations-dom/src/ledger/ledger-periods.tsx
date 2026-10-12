import { monthOf } from '@integr8/core';
import { formatCalendarDate, formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, type LedgerYear, useOperations } from '../api.js';
import { useIdempotencyKey } from '../purchasing/purchasing-parts.js';
import { BackLink, buttonClass, cardClass, Dialog, Field, inputClass, Loading } from '../ui.js';
import {
  AppLink,
  formatMonth,
  LedgerFailure,
  ManagementNote,
  useLedgerAccess,
  useLedgerOverview,
} from './ledger-parts.js';

/**
 * Months and fiscal years (ADR-0009). Nothing posts into a locked month: an
 * owner or admin locks a month once it is closed, and only the owner unlocks
 * one, saying why. Closing a year posts one journal on its last day moving
 * income and expenses into retained earnings and locks its months; only the
 * owner reopens it, with a reason.
 */
export function LedgerPeriodsScreen() {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const overview = useLedgerOverview();
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    { kind: 'close' | 'reopen'; year: LedgerYear } | { kind: 'unlock'; month: string } | null
  >(null);

  const years = useQuery({
    queryKey: keys.ledgerYears,
    queryFn: async () => (await client.GET('/v1/ledger/years')).data!.items,
  });
  const today = overview.data?.today;
  const current =
    years.data?.find((year) => today !== undefined && year.start <= today && today <= year.end) ??
    years.data?.[0];
  const yearStart = selected ?? current?.start ?? null;

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink to={paths.ledger} label={t('ledger.back')} />
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content">{t('ledger.periods.title')}</h1>
        <p className="text-sm text-content-muted">{t('ledger.periods.intro')}</p>
        <ManagementNote />
      </header>

      <section aria-labelledby="ledger-years" className="flex flex-col gap-3">
        <h2 id="ledger-years" className="text-lg font-semibold text-content">
          {t('ledger.periods.years')}
        </h2>
        {years.isPending ? (
          <Loading />
        ) : years.isError ? (
          <LedgerFailure error={years.error} onRetry={() => void years.refetch()} />
        ) : years.data.length === 0 ? (
          <p className="text-sm text-content-muted">{t('ledger.periods.noYears')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {years.data.map((year) => (
              <li key={year.start} className={cardClass}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold text-content">
                      {t('ledger.periods.yearRange', {
                        from: formatCalendarDate(year.start, { locale }),
                        to: formatCalendarDate(year.end, { locale }),
                      })}
                      <span className="inline-flex items-center rounded-full border border-border-subtle px-2 py-0.5 text-xs font-medium">
                        {t(`ledger.yearStatus.${year.status}`)}
                      </span>
                    </h3>
                    <p className="text-sm text-content-muted">
                      {t('ledger.periods.lockedOf', {
                        locked: year.lockedMonths,
                        months: year.months,
                      })}
                    </p>
                    {year.close === null ? null : (
                      <p className="text-sm text-content">
                        {t('ledger.periods.closedBy', {
                          name: year.close.closedBy.name,
                          date: formatDateTime(year.close.closedAt, { locale }),
                        })}{' '}
                        <AppLink
                          to={paths.journal(year.close.journal.id)}
                          ltr={year.close.journal.reference !== null}
                        >
                          {year.close.journal.reference ?? t('ledger.periods.closingJournal')}
                        </AppLink>
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={buttonClass.secondary}
                      aria-pressed={yearStart === year.start}
                      onClick={() => setSelected(year.start)}
                    >
                      {t('ledger.periods.showMonths')}
                    </button>
                    {year.can.close ? (
                      <button
                        type="button"
                        className={buttonClass.primary}
                        onClick={() => setDialog({ kind: 'close', year })}
                      >
                        {t('ledger.periods.close')}
                      </button>
                    ) : null}
                    {year.can.reopen ? (
                      <button
                        type="button"
                        className={buttonClass.danger}
                        onClick={() => setDialog({ kind: 'reopen', year })}
                      >
                        {t('ledger.periods.reopen')}
                      </button>
                    ) : null}
                  </div>
                </div>
                {year.reopened.length === 0 ? null : (
                  <div className="flex flex-col gap-1">
                    <h4 className="text-sm font-medium text-content">
                      {t('ledger.periods.reopenHistory')}
                    </h4>
                    <ul className="flex flex-col gap-1 text-sm text-content-muted">
                      {year.reopened.map((entry) => (
                        <li key={entry.reopenedAt}>
                          {t('ledger.periods.reopenedBy', {
                            name: entry.reopenedBy.name,
                            date: formatDateTime(entry.reopenedAt, { locale }),
                          })}{' '}
                          <span dir="auto" className="text-content">
                            {entry.reason}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {yearStart === null ? null : (
        <Months
          key={yearStart}
          yearStart={yearStart}
          startDate={overview.data?.settings?.startDate ?? null}
          onUnlock={(month) => setDialog({ kind: 'unlock', month })}
        />
      )}

      {dialog?.kind === 'close' ? (
        <CloseYearDialog year={dialog.year} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'reopen' ? (
        <ReasonDialog
          title={t('ledger.periods.reopenTitle')}
          intro={t('ledger.periods.reopenIntro')}
          action={t('ledger.periods.reopen')}
          onClose={() => setDialog(null)}
          send={async (reason, idempotencyKey) => {
            await client.POST('/v1/ledger/years/{yearStart}/reopen', {
              params: {
                path: { yearStart: dialog.year.start },
                header: { 'Idempotency-Key': idempotencyKey },
              },
              body: { reason },
            });
          }}
        />
      ) : null}
      {dialog?.kind === 'unlock' ? (
        <ReasonDialog
          title={t('ledger.periods.unlockTitle', { month: formatMonth(dialog.month, locale) })}
          intro={t('ledger.periods.unlockIntro')}
          action={t('ledger.periods.unlock')}
          onClose={() => setDialog(null)}
          send={async (reason) => {
            await client.POST('/v1/ledger/periods/{month}/unlock', {
              params: { path: { month: dialog.month } },
              body: { reason },
            });
          }}
        />
      ) : null}
    </div>
  );
}

/** The months of one fiscal year, locked or open, and who changed each and why. */
function Months({
  yearStart,
  startDate,
  onUnlock,
}: {
  yearStart: string;
  startDate: string | null;
  onUnlock: (month: string) => void;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const queries = useQueryClient();
  const access = useLedgerAccess();
  const periods = useQuery({
    queryKey: keys.ledgerPeriods(yearStart),
    queryFn: async () =>
      (await client.GET('/v1/ledger/periods', { params: { query: { date: yearStart } } })).data!,
  });
  const lock = useMutation({
    mutationFn: async (month: string) =>
      client.POST('/v1/ledger/periods/{month}/lock', { params: { path: { month } } }),
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ['ledger'] });
    },
  });
  const firstMonth = startDate === null ? null : monthOf(startDate);

  return (
    <section aria-labelledby="ledger-months" className="flex flex-col gap-3">
      <h2 id="ledger-months" className="text-lg font-semibold text-content">
        {periods.data === undefined
          ? t('ledger.periods.months')
          : t('ledger.periods.monthsOf', {
              from: formatMonth(periods.data.year.start, locale),
              to: formatMonth(periods.data.year.end, locale),
            })}
      </h2>
      {periods.isPending ? (
        <Loading />
      ) : periods.isError ? (
        <LedgerFailure error={periods.error} onRetry={() => void periods.refetch()} />
      ) : (
        <>
          {lock.isError ? <LedgerFailure error={lock.error} /> : null}
          <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted text-content-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 text-start font-medium">
                    {t('ledger.periods.month')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-start font-medium">
                    {t('ledger.periods.state')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-start font-medium">
                    {t('ledger.periods.changed')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    <span className="sr-only">{t('ledger.accounts.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {periods.data.months.map((period) => {
                  const beforeStart = firstMonth !== null && period.month < firstMonth;
                  const name = formatMonth(period.month, locale);
                  return (
                    <tr key={period.month}>
                      <th scope="row" className="px-3 py-2 text-start font-medium text-content">
                        {name}
                      </th>
                      <td className="px-3 py-2 text-content">
                        {beforeStart
                          ? t('ledger.periods.beforeStart')
                          : period.locked
                            ? t('ledger.periods.locked')
                            : t('ledger.periods.open')}
                      </td>
                      <td className="px-3 py-2 text-content-muted">
                        {period.changedBy === null || period.changedAt === null
                          ? ''
                          : t('ledger.periods.byOn', {
                              name: period.changedBy.name,
                              date: formatDateTime(period.changedAt, { locale }),
                            })}
                      </td>
                      <td className="px-3 py-2 text-end">
                        {beforeStart ? null : !period.locked && access.manage ? (
                          <button
                            type="button"
                            className={buttonClass.ghost}
                            aria-label={t('ledger.periods.lockOne', { month: name })}
                            disabled={lock.isPending}
                            onClick={() => lock.mutate(period.month)}
                          >
                            {t('ledger.periods.lock')}
                          </button>
                        ) : period.locked && access.unlock ? (
                          <button
                            type="button"
                            className={buttonClass.ghost}
                            aria-label={t('ledger.periods.unlockOne', { month: name })}
                            onClick={() => onUnlock(period.month)}
                          >
                            {t('ledger.periods.unlock')}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {periods.data.events.length === 0 ? null : (
            <div className="flex flex-col gap-2">
              <h3 className="text-base font-semibold text-content">
                {t('ledger.periods.history')}
              </h3>
              <ul className="flex flex-col gap-1 text-sm">
                {periods.data.events.map((event) => (
                  <li key={event.id} className="text-content-muted">
                    {t(`ledger.periods.event.${event.kind}`, {
                      month: formatMonth(event.month, locale),
                      name: event.by.name,
                      date: formatDateTime(event.at, { locale }),
                    })}
                    {event.reason === null ? null : (
                      <>
                        {' '}
                        <span dir="auto" className="text-content">
                          {event.reason}
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Closes a fiscal year once it has ended: a closing journal on its last day, every month locked. */
function CloseYearDialog({ year, onClose }: { year: LedgerYear; onClose: () => void }) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const queries = useQueryClient();
  const idempotencyKey = useIdempotencyKey({ close: year.start });
  const close = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/ledger/years/{yearStart}/close', {
          params: {
            path: { yearStart: year.start },
            header: { 'Idempotency-Key': idempotencyKey },
          },
        })
      ).data!,
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ['ledger'] });
      onClose();
    },
  });
  return (
    <Dialog
      title={t('ledger.periods.closeTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('ledger.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.primary}
            disabled={close.isPending}
            onClick={() => close.mutate()}
          >
            {close.isPending ? t('ledger.periods.closing') : t('ledger.periods.close')}
          </button>
        </>
      }
    >
      <p>
        {t('ledger.periods.closeIntro', {
          from: formatCalendarDate(year.start, { locale }),
          to: formatCalendarDate(year.end, { locale }),
        })}
      </p>
      <p>{t('ledger.periods.closeLocks')}</p>
      {close.isError ? <LedgerFailure error={close.error} /> : null}
    </Dialog>
  );
}

/** An owner's action that needs a reason kept with it: reopening a year, unlocking a month. */
function ReasonDialog({
  title,
  intro,
  action,
  onClose,
  send,
}: {
  title: string;
  intro: string;
  action: string;
  onClose: () => void;
  send: (reason: string, idempotencyKey: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [reason, setReason] = useState('');
  const idempotencyKey = useIdempotencyKey({ title, reason: reason.trim() });
  const submit = useMutation({
    mutationFn: async () => send(reason.trim(), idempotencyKey),
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ['ledger'] });
      onClose();
    },
  });
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('ledger.cancel')}
          </button>
          <button
            type="submit"
            form="ledger-reason"
            className={buttonClass.danger}
            disabled={reason.trim() === '' || submit.isPending}
          >
            {action}
          </button>
        </>
      }
    >
      <form
        id="ledger-reason"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (reason.trim() !== '') {
            submit.mutate();
          }
        }}
      >
        <p>{intro}</p>
        <Field label={t('ledger.periods.reason')}>
          {(id) => (
            <textarea
              id={id}
              required
              rows={2}
              maxLength={1000}
              dir="auto"
              className={inputClass}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
        {submit.isError ? <LedgerFailure error={submit.error} /> : null}
      </form>
    </Dialog>
  );
}
