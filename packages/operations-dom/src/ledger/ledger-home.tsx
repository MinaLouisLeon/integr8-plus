import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, type LedgerOverview, useOperations } from '../api.js';
import { useIdempotencyKey } from '../purchasing/purchasing-parts.js';
import { buttonClass, cardClass, DashboardBackLink, Field, inputClass, Loading } from '../ui.js';
import {
  AppLink,
  LedgerFailure,
  ManagementNote,
  monthNames,
  Notice,
  POSTING_REASONS,
  useLedgerAccess,
  useLedgerOverview,
  useReasonName,
} from './ledger-parts.js';

/**
 * The ledger's front page (CRM/ERP plan, phase A1; ADR-0009). Before it is
 * set up, an owner or admin chooses the month it starts, the month the
 * fiscal year starts and the language of the starting chart. After, it is
 * the way into everything else: what waits to be posted, the opening
 * balances, the chart, journals, months and years, reports and settings.
 */
export function LedgerHomeScreen() {
  const { t } = useTranslation();
  const access = useLedgerAccess();
  const overview = useLedgerOverview();

  return (
    <div className="flex flex-col gap-6 text-start">
      <DashboardBackLink />
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content">{t('ledger.home.title')}</h1>
        <ManagementNote />
      </header>
      {overview.isPending ? (
        <Loading />
      ) : overview.isError ? (
        <LedgerFailure error={overview.error} onRetry={() => void overview.refetch()} />
      ) : !overview.data.setUp ? (
        access.manage ? (
          <SetUpForm overview={overview.data} />
        ) : (
          <Notice>
            <p>{t('ledger.home.notSetUp')}</p>
          </Notice>
        )
      ) : (
        <Hub overview={overview.data} />
      )}
    </div>
  );
}

/** This month, as `YYYY-MM`: the start the form suggests. */
function thisMonth(today: string): string {
  return today.slice(0, 7);
}

function SetUpForm({ overview }: { overview: LedgerOverview }) {
  const { t, i18n } = useTranslation();
  const { client, locale } = useOperations();
  const queries = useQueryClient();
  const [month, setMonth] = useState(thisMonth(overview.today));
  const [fiscalStartMonth, setFiscalStartMonth] = useState(1);
  const [language, setLanguage] = useState<'en' | 'ar'>(
    i18n.language.startsWith('ar') ? 'ar' : 'en',
  );
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/u.test(month);
  const body = { startDate: `${month}-01`, fiscalStartMonth, language };
  const idempotencyKey = useIdempotencyKey(body);
  const setUp = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/ledger/setup', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body,
        })
      ).data!,
    onSuccess: async (next) => {
      queries.setQueryData(keys.ledger, next);
      await queries.invalidateQueries({ queryKey: ['ledger'] });
    },
  });
  const names = monthNames(locale);

  return (
    <form
      aria-labelledby="ledger-setup"
      className={`${cardClass} max-w-2xl`}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) {
          setUp.mutate();
        }
      }}
    >
      <h2 id="ledger-setup" className="text-lg font-semibold text-content">
        {t('ledger.setup.title')}
      </h2>
      <p className="text-sm text-content-muted">
        {t('ledger.setup.intro', { currency: overview.currency })}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('ledger.setup.startMonth')} hint={t('ledger.setup.startMonthHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              type="month"
              dir="ltr"
              required
              aria-describedby={describedBy}
              className={inputClass}
              value={month}
              onChange={(event) => setMonth(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('ledger.setup.fiscalStart')} hint={t('ledger.setup.fiscalStartHint')}>
          {(id, describedBy) => (
            <select
              id={id}
              aria-describedby={describedBy}
              className={inputClass}
              value={fiscalStartMonth}
              onChange={(event) => setFiscalStartMonth(Number(event.target.value))}
            >
              {names.map((name, index) => (
                <option key={name} value={index + 1}>
                  {name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('ledger.setup.language')} hint={t('ledger.setup.languageHint')}>
          {(id, describedBy) => (
            <select
              id={id}
              aria-describedby={describedBy}
              className={inputClass}
              value={language}
              onChange={(event) => setLanguage(event.target.value === 'ar' ? 'ar' : 'en')}
            >
              <option value="en">{t('ledger.setup.english')}</option>
              <option value="ar">{t('ledger.setup.arabic')}</option>
            </select>
          )}
        </Field>
      </div>
      {valid ? (
        <p className="text-sm text-content-muted">
          {t('ledger.setup.startsOn', {
            date: formatCalendarDate(`${month}-01`, { locale }),
          })}
        </p>
      ) : null}
      <p className="text-sm text-content-muted">{t('ledger.setup.afterwards')}</p>
      {setUp.isError ? <LedgerFailure error={setUp.error} /> : null}
      <div>
        <button type="submit" className={buttonClass.primary} disabled={!valid || setUp.isPending}>
          {setUp.isPending ? t('ledger.setup.settingUp') : t('ledger.setup.submit')}
        </button>
      </div>
    </form>
  );
}

function Hub({ overview }: { overview: LedgerOverview }) {
  const { t } = useTranslation();
  const { paths, locale } = useOperations();
  const access = useLedgerAccess();
  const reasonName = useReasonName();
  const settings = overview.settings!;
  const waiting = POSTING_REASONS.flatMap((reason) => {
    const count = overview.unposted.byReason[reason] ?? 0;
    return count > 0 ? [{ reason, count }] : [];
  });
  const opening = overview.openingJournal;

  return (
    <>
      {overview.unposted.total > 0 ? (
        <Notice tone="warning">
          <p className="font-medium">
            {t('ledger.home.waiting', { count: overview.unposted.total })}
          </p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {waiting.map(({ reason, count }) => (
              <li key={reason}>
                {t('ledger.home.byReason', { reason: reasonName(reason), count })}
              </li>
            ))}
          </ul>
          <AppLink to={paths.unposted} className="self-start font-medium">
            {t('ledger.home.reviewWaiting')}
          </AppLink>
        </Notice>
      ) : (
        <p role="status" className="text-sm text-content-muted">
          {t('ledger.home.nothingWaiting')}
        </p>
      )}

      <section aria-labelledby="ledger-facts" className={cardClass}>
        <h2 id="ledger-facts" className="text-base font-semibold text-content">
          {t('ledger.home.facts')}
        </h2>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div className="flex flex-col">
            <dt className="text-content-muted">{t('ledger.home.startDate')}</dt>
            <dd className="text-content">{formatCalendarDate(settings.startDate, { locale })}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-content-muted">{t('ledger.home.fiscalStart')}</dt>
            <dd className="text-content">{monthNames(locale)[settings.fiscalStartMonth - 1]}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-content-muted">{t('ledger.home.currency')}</dt>
            <dd className="text-content" dir="ltr">
              {overview.currency}
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="ledger-opening" className={cardClass}>
        <h2 id="ledger-opening" className="text-base font-semibold text-content">
          {t('ledger.home.opening')}
        </h2>
        {opening === null ? (
          <>
            <p className="text-sm text-content-muted">{t('ledger.home.openingNone')}</p>
            {access.post ? (
              <AppLink to={paths.newJournal({ opening: true })} className="self-start text-sm">
                {t('ledger.home.openingCreate')}
              </AppLink>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-content">
            {opening.status === 'posted'
              ? t('ledger.home.openingPosted')
              : t('ledger.home.openingDraft')}{' '}
            <AppLink to={paths.journal(opening.id)} ltr>
              {opening.reference ?? t('ledger.journals.draftLabel')}
            </AppLink>
          </p>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <HubCard
          to={paths.ledgerAccounts}
          title={t('ledger.accounts.title')}
          note={t('ledger.home.accountsNote')}
        />
        <HubCard
          to={paths.journals}
          title={t('ledger.journals.title')}
          note={t('nav.hint.journals')}
        />
        <HubCard
          to={paths.unposted}
          title={t('ledger.unposted.title')}
          note={t('ledger.home.unpostedNote')}
        />
        <HubCard
          to={paths.ledgerPeriods}
          title={t('ledger.periods.title')}
          note={t('ledger.home.periodsNote')}
        />
        <HubCard
          to={paths.ledgerReports}
          title={t('ledger.reports.title')}
          note={t('nav.hint.ledgerReports')}
        />
        <HubCard
          to={paths.ledgerSettings}
          title={t('ledger.settings.title')}
          note={t('ledger.home.settingsNote')}
        />
      </div>
    </>
  );
}

function HubCard({ to, title, note }: { to: string; title: string; note: string }) {
  return (
    <section className={cardClass}>
      <h2 className="text-base font-semibold text-content">
        <AppLink to={to}>{title}</AppLink>
      </h2>
      <p className="text-sm text-content-muted">{note}</p>
    </section>
  );
}
