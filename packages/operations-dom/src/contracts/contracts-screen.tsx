import { CONTRACT_CANCEL_REASON_MAX, renewalNoticeDay, renewalTerm } from '@integr8/core';
import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { type Contract, keys, useOperations } from '../api.js';
import { PlanStatusBadge } from '../maintenance/maintenance-parts.js';
import {
  BackLink,
  buttonClass,
  cardClass,
  DashboardBackLink,
  Dialog,
  Failure,
  Field,
  inputClass,
  Loading,
  StateBadge,
  when,
} from '../ui.js';
import {
  ContractDialog,
  ContractLink,
  ContractStandingBadge,
  CoverageBadge,
  ScopeText,
  TermText,
} from './contract-parts.js';
import { localDay, moneyValid, termReversed } from './model.js';

/**
 * Service contracts (P27): what each customer has agreed to. The list, with
 * the ones ending soon or ended marked; owners, admins and dispatchers add,
 * change, renew and cancel them (`contract.manage`), viewers read them.
 */
export function ContractsScreen() {
  const { t } = useTranslation();
  const { client, locale, paths, navigate } = useOperations();
  const [search, setSearch] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [cancelled, setCancelled] = useState(false);
  const [adding, setAdding] = useState(false);

  const q = search.trim();
  const query = { q, cancelled };
  const list = useQuery({
    queryKey: keys.contracts(query),
    queryFn: async () =>
      (
        await client.GET('/v1/contracts', {
          params: {
            query: {
              ...(q === '' ? {} : { q }),
              ...(cancelled ? { includeCancelled: 'true' as const } : {}),
            },
          },
        })
      ).data!,
    placeholderData: (previous) => previous,
  });
  const data = list.data;
  const customers = useMemo(() => {
    const byId = new Map((data?.items ?? []).map((item) => [item.customer.id, item.customer]));
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, locale));
  }, [data, locale]);
  const shown = (data?.items ?? []).filter(
    (item) => customerId === '' || item.customer.id === customerId,
  );
  const manage = data?.can.manage ?? false;

  return (
    <div className="flex flex-col gap-6 text-start">
      <DashboardBackLink />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-content">{t('operations.contracts.title')}</h1>
          <p className="text-sm text-content-muted">
            {manage ? t('operations.contracts.intro') : t('operations.contracts.readOnly')}
          </p>
        </div>
        {manage ? (
          <button type="button" className={buttonClass.primary} onClick={() => setAdding(true)}>
            {t('operations.contracts.add')}
          </button>
        ) : null}
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('operations.contracts.search')} className="min-w-64 flex-1">
          {(id) => (
            <input
              id={id}
              type="search"
              className={inputClass}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('operations.contracts.customer')} className="min-w-48">
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={customerId}
              onChange={(event) => setCustomerId(event.target.value)}
            >
              <option value="">{t('operations.contracts.allCustomers')}</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm text-content">
          <input
            type="checkbox"
            checked={cancelled}
            onChange={(event) => setCancelled(event.target.checked)}
          />
          {t('operations.contracts.showCancelled')}
        </label>
      </div>

      {list.isError && data === undefined ? (
        <Failure error={list.error} onRetry={() => void list.refetch()} />
      ) : data === undefined ? (
        <Loading />
      ) : shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {q === '' && customerId === ''
            ? t('operations.contracts.empty')
            : t('operations.contracts.noMatch')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('operations.contracts.title')}</caption>
            <thead className="border-b border-border-subtle text-xs text-content-muted">
              <tr>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.contracts.contract')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.contracts.customer')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.contracts.term')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.contracts.callouts')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.contracts.status')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {shown.map((contract) => (
                <tr
                  key={contract.id}
                  className={
                    contract.standing === 'ending'
                      ? 'bg-warning-subtle'
                      : contract.standing === 'ended'
                        ? 'bg-danger-subtle'
                        : undefined
                  }
                >
                  <td className="px-3 py-2">
                    <a
                      href={paths.contract(contract.id)}
                      className="font-medium text-accent underline-offset-4 hover:underline"
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(paths.contract(contract.id));
                      }}
                    >
                      <span dir="ltr" className="font-mono text-xs text-content-muted">
                        {contract.reference}
                      </span>{' '}
                      <span dir="auto">{contract.title}</span>
                    </a>
                  </td>
                  <td dir="auto" className="px-3 py-2 text-content">
                    {contract.customer.name}
                  </td>
                  <td className="px-3 py-2 text-content">
                    <TermText startsOn={contract.startsOn} endsOn={contract.endsOn} />
                  </td>
                  <td className="px-3 py-2 text-content">
                    <CalloutsText contract={contract} />
                  </td>
                  <td className="px-3 py-2">
                    <ContractStandingBadge standing={contract.standing} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding ? (
        <ContractDialog
          renewalNoticeDays={data?.defaults.renewalNoticeDays}
          onClose={() => setAdding(false)}
          onSaved={(saved) => {
            setAdding(false);
            navigate(paths.contract(saved.id));
          }}
        />
      ) : null}
    </div>
  );
}

function CalloutsText({ contract }: { contract: Contract }) {
  const { t } = useTranslation();
  return (
    <>
      {contract.includedCallouts === null
        ? t('operations.contracts.noLimit')
        : t('operations.contracts.calloutsUsed', {
            used: contract.calloutsUsed,
            included: contract.includedCallouts,
          })}
    </>
  );
}

// ---------------------------------------------------------------------------
// One contract
// ---------------------------------------------------------------------------

type ContractAction = 'edit' | 'renew' | 'cancel';

export function ContractScreen({ contractId }: { contractId: string }) {
  const { t } = useTranslation();
  const { client, locale, paths, navigate } = useOperations();
  const [action, setAction] = useState<ContractAction | undefined>();

  const detail = useQuery({
    queryKey: keys.contract(contractId),
    queryFn: async () =>
      (await client.GET('/v1/contracts/{contractId}', { params: { path: { contractId } } })).data!,
  });

  const back = <BackLink to={paths.contracts} label={t('operations.contracts.back')} />;
  if (detail.isPending || detail.isError) {
    return (
      <div className="flex flex-col gap-6 text-start">
        {back}
        {detail.isPending ? (
          <Loading />
        ) : (
          <Failure error={detail.error} onRetry={() => void detail.refetch()} />
        )}
      </div>
    );
  }

  const { contract, contractYear, plans, jobs, can } = detail.data;
  const open = contract.standing !== 'cancelled';
  const day = (value: string) => formatCalendarDate(value, { locale });
  const link = (href: string, label: ReactNode) => (
    <a
      href={href}
      className="text-accent underline-offset-4 hover:underline"
      onClick={(event) => {
        event.preventDefault();
        navigate(href);
      }}
    >
      {label}
    </a>
  );
  const fact = (label: string, value: ReactNode) => (
    <div className="flex flex-col gap-0.5">
      <dt className="text-content-muted">{label}</dt>
      <dd className="text-content">{value}</dd>
    </div>
  );

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span dir="ltr" className="font-mono text-sm text-content-muted">
              {contract.reference}
            </span>
            <ContractStandingBadge standing={contract.standing} />
          </div>
          <h1 dir="auto" className="text-2xl font-semibold text-content">
            {contract.title}
          </h1>
          <p className="text-sm text-content-muted">
            {link(paths.customer(contract.customer.id), contract.customer.name)}
          </p>
        </div>
        {can.manage && open ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setAction('edit')}
            >
              {t('operations.contracts.edit')}
            </button>
            {contract.renewedBy === null ? (
              <button
                type="button"
                className={buttonClass.primary}
                onClick={() => setAction('renew')}
              >
                {t('operations.contracts.renew')}
              </button>
            ) : null}
            {/* An ended contract covers nothing more: there is nothing left to cancel. */}
            {contract.standing === 'ended' ? null : (
              <button
                type="button"
                className={buttonClass.danger}
                onClick={() => setAction('cancel')}
              >
                {t('operations.contracts.cancel')}
              </button>
            )}
          </div>
        ) : null}
      </header>

      {contract.standing === 'ending' && contract.renewedBy === null ? (
        <p
          role="status"
          className="rounded-md border border-warning bg-warning-subtle px-3 py-2 text-sm text-content"
        >
          {t('operations.contracts.endingNotice', { date: day(contract.endsOn) })}
        </p>
      ) : null}
      {contract.standing === 'cancelled' ? (
        <p className="rounded-md border border-border-subtle bg-surface-muted px-3 py-2 text-sm text-content">
          {t('operations.contracts.cancelledNotice', {
            date: contract.cancelledOn === null ? '' : day(contract.cancelledOn),
            reason: contract.cancelReason ?? '',
          })}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-labelledby="contract-details" className={cardClass}>
          <h2 id="contract-details" className="text-lg font-semibold text-content">
            {t('operations.contracts.details')}
          </h2>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {fact(
              t('operations.contracts.term'),
              <TermText startsOn={contract.startsOn} endsOn={contract.endsOn} />,
            )}
            {fact(
              t('operations.contracts.value'),
              contract.value === null ? (
                t('operations.contracts.noValue')
              ) : (
                <span dir="ltr">{contract.value}</span>
              ),
            )}
            {fact(
              t('operations.contracts.callouts'),
              <>
                <CalloutsText contract={contract} />
                {contractYear === null || contract.includedCallouts === null ? null : (
                  <span className="block text-xs text-content-muted">
                    {t('operations.contracts.contractYear', {
                      from: day(contractYear.from),
                      to: day(contractYear.to),
                    })}
                  </span>
                )}
              </>,
            )}
            {fact(
              t('operations.contracts.reminder'),
              t('operations.contracts.reminderOn', { date: day(renewalNoticeDay(contract)) }),
            )}
            {contract.renewedFrom === null
              ? null
              : fact(
                  t('operations.contracts.renewedFrom'),
                  <ContractLink contract={contract.renewedFrom} />,
                )}
            {contract.renewedBy === null
              ? null
              : fact(
                  t('operations.contracts.renewedBy'),
                  <ContractLink contract={contract.renewedBy} />,
                )}
          </dl>
          {contract.notes === null ? null : (
            <p dir="auto" className="whitespace-pre-wrap text-sm text-content">
              {contract.notes}
            </p>
          )}
        </section>

        <section aria-labelledby="contract-covers" className={cardClass}>
          <h2 id="contract-covers" className="text-lg font-semibold text-content">
            {t('operations.contracts.covers')}
          </h2>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            {fact(
              t('operations.contracts.sites'),
              <ScopeText list={contract.sites} all={t('operations.contracts.scope.allSites')} />,
            )}
            {fact(
              t('operations.contracts.assets'),
              <ScopeText list={contract.assets} all={t('operations.contracts.scope.allAssets')} />,
            )}
            {fact(
              t('operations.contracts.jobTypes'),
              <ScopeText
                list={contract.jobTypes}
                all={t('operations.contracts.scope.allJobTypes')}
              />,
            )}
          </dl>
        </section>
      </div>

      <section aria-labelledby="contract-plans" className="flex flex-col gap-3">
        <h2 id="contract-plans" className="text-lg font-semibold text-content">
          {t('operations.contracts.plans')}
        </h2>
        {plans.length === 0 ? (
          <p className="text-sm text-content-muted">{t('operations.contracts.noPlans')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface text-sm">
            {plans.map((plan) => (
              <li
                key={plan.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"
              >
                <span className="flex flex-col">
                  <span dir="auto" className="text-content">
                    {plan.title}
                  </span>
                  <span className="text-xs">
                    {link(paths.asset(plan.asset.id), <span dir="auto">{plan.asset.name}</span>)}
                  </span>
                </span>
                <span className="flex items-center gap-2 text-xs text-content-muted">
                  {plan.status === 'active' ||
                  plan.status === 'paused' ||
                  plan.status === 'ended' ? (
                    <PlanStatusBadge status={plan.status} />
                  ) : null}
                  {plan.nextDueOn === null
                    ? null
                    : t('operations.contracts.nextDue', { date: day(plan.nextDueOn) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="contract-jobs" className="flex flex-col gap-3">
        <h2 id="contract-jobs" className="text-lg font-semibold text-content">
          {t('operations.contracts.jobs')}
        </h2>
        {jobs.length === 0 ? (
          <p className="text-sm text-content-muted">{t('operations.contracts.noJobs')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface text-sm">
            {jobs.map((job) => (
              <li
                key={job.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"
              >
                {link(
                  paths.workOrder(job.id),
                  <>
                    <span dir="ltr">{job.referenceLabel}</span> ·{' '}
                    <span dir="auto">{job.title}</span>
                  </>,
                )}
                <span className="flex flex-wrap items-center gap-2 text-xs text-content-muted">
                  <CoverageBadge coverage={job.coverage} />
                  <StateBadge state={job.state} />
                  {when(job.createdAt, locale)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {action === 'edit' ? (
        <ContractDialog
          contract={contract}
          onClose={() => setAction(undefined)}
          onSaved={() => setAction(undefined)}
        />
      ) : null}
      {action === 'renew' ? (
        <RenewDialog contract={contract} onClose={() => setAction(undefined)} />
      ) : null}
      {action === 'cancel' ? (
        <CancelDialog contract={contract} onClose={() => setAction(undefined)} />
      ) : null}
    </div>
  );
}

/** Renews a contract: the next term, the same coverage, and its plans moved across. */
function RenewDialog({ contract, onClose }: { contract: Contract; onClose: () => void }) {
  const { t } = useTranslation();
  const { client, paths, navigate } = useOperations();
  const queryClient = useQueryClient();
  const next = renewalTerm(contract);
  const [title, setTitle] = useState(contract.title);
  const [startsOn, setStartsOn] = useState(next.startsOn);
  const [endsOn, setEndsOn] = useState(next.endsOn);
  const [value, setValue] = useState(contract.value ?? '');
  const reversed = termReversed(startsOn, endsOn);
  const valueBad = value.trim() !== '' && !moneyValid(value);
  const ready = title.trim() !== '' && startsOn !== '' && endsOn !== '' && !reversed && !valueBad;

  const renew = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/contracts/{contractId}/renew', {
          params: { path: { contractId: contract.id } },
          body: {
            expectedVersion: contract.version,
            title: title.trim(),
            startsOn,
            endsOn,
            value: value.trim() === '' ? null : value.trim(),
          },
        })
      ).data!,
    onSuccess: (renewed) => {
      void queryClient.invalidateQueries({ queryKey: ['contracts'] });
      void queryClient.invalidateQueries({ queryKey: ['maintenance'] });
      onClose();
      navigate(paths.contract(renewed.id));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready && !renew.isPending) {
      renew.mutate();
    }
  };
  const formId = `renew-${contract.id}`;

  return (
    <Dialog
      title={t('operations.contracts.renewTitle', { reference: contract.reference })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            form={formId}
            className={buttonClass.primary}
            disabled={!ready || renew.isPending}
            aria-busy={renew.isPending}
          >
            {t('operations.contracts.renewConfirm')}
          </button>
        </>
      }
    >
      <p className="text-content-muted">{t('operations.contracts.renewHint')}</p>
      <form id={formId} onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label={t('operations.contracts.titleLabel')} className="sm:col-span-2">
          {(id) => (
            <input
              id={id}
              required
              maxLength={200}
              className={inputClass}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('operations.contracts.startsOn')}>
          {(id) => (
            <input
              id={id}
              type="date"
              required
              className={inputClass}
              value={startsOn}
              onChange={(event) => setStartsOn(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('operations.contracts.endsOn')}>
          {(id) => (
            <input
              id={id}
              type="date"
              required
              className={inputClass}
              value={endsOn}
              aria-invalid={reversed}
              onChange={(event) => setEndsOn(event.target.value)}
            />
          )}
        </Field>
        {reversed ? (
          <p className="text-sm text-danger sm:col-span-2">
            {t('operations.contracts.datesReversed')}
          </p>
        ) : null}
        <Field label={t('operations.contracts.value')} hint={t('operations.common.optional')}>
          {(id, describedBy) => (
            <input
              id={id}
              inputMode="decimal"
              dir="ltr"
              className={inputClass}
              value={value}
              aria-invalid={valueBad}
              aria-describedby={describedBy}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
        </Field>
      </form>
      {renew.isError ? <Failure error={renew.error} /> : null}
    </Dialog>
  );
}

/** Cancels a contract from a day, with the reason. Final. */
function CancelDialog({ contract, onClose }: { contract: Contract; onClose: () => void }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queryClient = useQueryClient();
  const [cancelledOn, setCancelledOn] = useState(localDay());
  const [reason, setReason] = useState('');
  const ready = cancelledOn !== '' && reason.trim() !== '';

  const cancel = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/contracts/{contractId}/cancel', {
          params: { path: { contractId: contract.id } },
          body: { expectedVersion: contract.version, cancelledOn, reason: reason.trim() },
        })
      ).data!,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['contracts'] });
      onClose();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready && !cancel.isPending) {
      cancel.mutate();
    }
  };
  const formId = `cancel-${contract.id}`;

  return (
    <Dialog
      title={t('operations.contracts.cancelTitle', { reference: contract.reference })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('operations.contracts.keep')}
          </button>
          <button
            type="submit"
            form={formId}
            className={buttonClass.danger}
            disabled={!ready || cancel.isPending}
            aria-busy={cancel.isPending}
          >
            {t('operations.contracts.cancelConfirm')}
          </button>
        </>
      }
    >
      <p className="text-content">{t('operations.contracts.cancelHint')}</p>
      <form id={formId} onSubmit={submit} className="flex flex-col gap-3">
        <Field label={t('operations.contracts.cancelledOn')}>
          {(id) => (
            <input
              id={id}
              type="date"
              required
              className={inputClass}
              value={cancelledOn}
              onChange={(event) => setCancelledOn(event.target.value)}
            />
          )}
        </Field>
        <Field
          label={t('operations.contracts.cancelReason')}
          hint={t('operations.contracts.cancelReasonHint')}
        >
          {(id, describedBy) => (
            <textarea
              id={id}
              rows={2}
              required
              maxLength={CONTRACT_CANCEL_REASON_MAX}
              className={inputClass}
              value={reason}
              aria-describedby={describedBy}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
      </form>
      {cancel.isError ? <Failure error={cancel.error} /> : null}
    </Dialog>
  );
}
