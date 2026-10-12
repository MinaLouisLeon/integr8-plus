import { POSTING_ROLES } from '@integr8/core';
import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type LedgerSettings, type PostingRoleKey, useOperations } from '../api.js';
import { BackLink, buttonClass, cardClass, Field, inputClass, Loading } from '../ui.js';
import {
  AccountSelect,
  errorCode,
  LedgerFailure,
  ManagementNote,
  monthNames,
  Notice,
  useLedgerAccess,
  useLedgerAccounts,
  useLedgerOverview,
} from './ledger-parts.js';

interface Draft {
  startMonth: string;
  fiscalStartMonth: number;
  autoPostSales: boolean;
  autoPostStock: boolean;
  allowSelfApproval: boolean;
  accounts: Partial<Record<PostingRoleKey, string>>;
}

function draftOf(settings: LedgerSettings): Draft {
  return {
    startMonth: settings.startDate.slice(0, 7),
    fiscalStartMonth: settings.fiscalStartMonth,
    autoPostSales: settings.autoPostSales,
    autoPostStock: settings.autoPostStock,
    allowSelfApproval: settings.allowSelfApproval,
    accounts: { ...settings.accounts },
  };
}

/**
 * The ledger's settings (ADR-0009): whether sales and stock post on their
 * own, the account each automatic posting uses, and — the owner's alone —
 * whether a person may post a journal they drafted. The start date and the
 * fiscal year change only until the first journal is posted.
 */
export function LedgerSettingsScreen() {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const queries = useQueryClient();
  const access = useLedgerAccess();
  const overview = useLedgerOverview();
  const accounts = useLedgerAccounts(true, overview.data?.setUp === true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: async (values: Draft) => {
      const current = overview.data!.settings!;
      const startDate = `${values.startMonth}-01`;
      const changedAccounts = Object.fromEntries(
        Object.entries(values.accounts).filter(
          ([role, id]) => id !== '' && id !== current.accounts[role as PostingRoleKey],
        ),
      );
      return (
        await client.PUT('/v1/ledger/settings', {
          body: {
            expectedVersion: current.version,
            ...(startDate === current.startDate ? {} : { startDate }),
            ...(values.fiscalStartMonth === current.fiscalStartMonth
              ? {}
              : { fiscalStartMonth: values.fiscalStartMonth }),
            ...(values.autoPostSales === current.autoPostSales
              ? {}
              : { autoPostSales: values.autoPostSales }),
            ...(values.autoPostStock === current.autoPostStock
              ? {}
              : { autoPostStock: values.autoPostStock }),
            ...(values.allowSelfApproval === current.allowSelfApproval
              ? {}
              : { allowSelfApproval: values.allowSelfApproval }),
            ...(Object.keys(changedAccounts).length === 0 ? {} : { accounts: changedAccounts }),
          },
        })
      ).data!;
    },
    onSuccess: async () => {
      setDraft(null);
      setSaved(true);
      await queries.invalidateQueries({ queryKey: ['ledger'] });
    },
  });

  const back = <BackLink to={paths.ledger} label={t('ledger.back')} />;
  if (overview.isPending) {
    return <Loading />;
  }
  if (overview.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <LedgerFailure error={overview.error} onRetry={() => void overview.refetch()} />
      </div>
    );
  }
  const ledger = overview.data;
  if (ledger.settings === null) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Notice>
          <p>{t('ledger.home.notSetUp')}</p>
        </Notice>
      </div>
    );
  }

  const values = draft ?? draftOf(ledger.settings);
  const editable = access.manage;
  const set = (change: Partial<Draft>) => {
    setSaved(false);
    setDraft({ ...values, ...change });
  };
  const monthValid = /^\d{4}-(0[1-9]|1[0-2])$/u.test(values.startMonth);
  const conflict = errorCode(save.error) === 'version_conflict';
  const names = monthNames(locale);

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content">{t('ledger.settings.title')}</h1>
        <ManagementNote />
      </header>

      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (editable && monthValid) {
            save.mutate(values);
          }
        }}
      >
        <section aria-labelledby="ledger-auto" className={cardClass}>
          <h2 id="ledger-auto" className="text-lg font-semibold text-content">
            {t('ledger.settings.automatic')}
          </h2>
          <p className="text-sm text-content-muted">{t('ledger.settings.automaticIntro')}</p>
          <label className="flex items-center gap-2 text-sm text-content">
            <input
              type="checkbox"
              disabled={!editable}
              checked={values.autoPostSales}
              onChange={(event) => set({ autoPostSales: event.target.checked })}
            />
            {t('ledger.settings.autoPostSales')}
          </label>
          <label className="flex items-center gap-2 text-sm text-content">
            <input
              type="checkbox"
              disabled={!editable}
              checked={values.autoPostStock}
              onChange={(event) => set({ autoPostStock: event.target.checked })}
            />
            {t('ledger.settings.autoPostStock')}
          </label>
          <p className="text-sm text-content-muted">{t('ledger.settings.whenOff')}</p>
        </section>

        <section aria-labelledby="ledger-roles" className={cardClass}>
          <h2 id="ledger-roles" className="text-lg font-semibold text-content">
            {t('ledger.settings.accounts')}
          </h2>
          <p className="text-sm text-content-muted">{t('ledger.settings.accountsIntro')}</p>
          {accounts.isPending ? (
            <Loading />
          ) : accounts.isError ? (
            <LedgerFailure error={accounts.error} onRetry={() => void accounts.refetch()} />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {POSTING_ROLES.map((role) => (
                <Field key={role} label={t(`ledger.role.${role}`)}>
                  {(id) => (
                    <AccountSelect
                      id={id}
                      accounts={accounts.data}
                      value={values.accounts[role] ?? ''}
                      disabled={!editable}
                      onChange={(accountId) =>
                        set({ accounts: { ...values.accounts, [role]: accountId } })
                      }
                    />
                  )}
                </Field>
              ))}
            </div>
          )}
          <p className="text-sm text-content-muted">{t('ledger.settings.goodsReceivedNote')}</p>
        </section>

        <section aria-labelledby="ledger-approval" className={cardClass}>
          <h2 id="ledger-approval" className="text-lg font-semibold text-content">
            {t('ledger.settings.approval')}
          </h2>
          <label className="flex items-center gap-2 text-sm text-content">
            <input
              type="checkbox"
              aria-describedby="ledger-approval-hint"
              disabled={!editable || !access.unlock}
              checked={values.allowSelfApproval}
              onChange={(event) => set({ allowSelfApproval: event.target.checked })}
            />
            {t('ledger.settings.allowSelfApproval')}
          </label>
          <p id="ledger-approval-hint" className="text-sm text-content-muted">
            {access.unlock
              ? t('ledger.settings.selfApprovalHint')
              : t('ledger.settings.selfApprovalOwner')}
          </p>
        </section>

        <section aria-labelledby="ledger-year" className={cardClass}>
          <h2 id="ledger-year" className="text-lg font-semibold text-content">
            {t('ledger.settings.year')}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t('ledger.setup.startMonth')}
              hint={
                monthValid
                  ? t('ledger.setup.startsOn', {
                      date: formatCalendarDate(`${values.startMonth}-01`, { locale }),
                    })
                  : t('ledger.setup.startMonthHint')
              }
            >
              {(id, describedBy) => (
                <input
                  id={id}
                  type="month"
                  dir="ltr"
                  required
                  aria-describedby={describedBy}
                  disabled={!editable || ledger.fixed}
                  className={inputClass}
                  value={values.startMonth}
                  onChange={(event) => set({ startMonth: event.target.value })}
                />
              )}
            </Field>
            <Field label={t('ledger.setup.fiscalStart')}>
              {(id) => (
                <select
                  id={id}
                  disabled={!editable || ledger.fixed}
                  className={inputClass}
                  value={values.fiscalStartMonth}
                  onChange={(event) => set({ fiscalStartMonth: Number(event.target.value) })}
                >
                  {names.map((name, index) => (
                    <option key={name} value={index + 1}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <p className="text-sm text-content-muted">
            {ledger.fixed ? t('ledger.settings.fixed') : t('ledger.settings.notFixed')}
          </p>
        </section>

        {save.isError ? (
          conflict ? (
            <div
              role="alert"
              className="flex flex-col items-start gap-2 rounded-lg border border-danger bg-danger-subtle p-4 text-sm text-content"
            >
              <p>{t('ledger.errors.version_conflict')}</p>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => {
                  setDraft(null);
                  save.reset();
                  void overview.refetch();
                }}
              >
                {t('ledger.settings.reload')}
              </button>
            </div>
          ) : (
            <LedgerFailure error={save.error} />
          )
        ) : null}
        {saved ? (
          <p role="status" className="text-sm text-content">
            {t('ledger.settings.saved')}
          </p>
        ) : null}
        {editable ? (
          <div className="flex gap-2">
            <button
              type="submit"
              className={buttonClass.primary}
              disabled={draft === null || !monthValid || save.isPending}
            >
              {save.isPending ? t('ledger.saving') : t('ledger.save')}
            </button>
            {draft === null ? null : (
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => {
                  setDraft(null);
                  save.reset();
                }}
              >
                {t('ledger.cancel')}
              </button>
            )}
          </div>
        ) : (
          <p className="text-sm text-content-muted">{t('ledger.settings.readOnly')}</p>
        )}
      </form>
    </div>
  );
}
