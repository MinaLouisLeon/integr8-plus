import {
  INTERVAL_UNITS,
  PLAN_INTERVAL_MAX,
  PLAN_LEAD_DAYS_MAX,
  PLAN_WINDOW_DAYS_MAX,
} from '@integr8/core';
import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { type AssetDetail, keys, type MaintenancePlan, useOperations } from '../api.js';
import { localDay, termReversed, wholeNumber } from '../contracts/model.js';
import { ContractLink } from '../contracts/contract-parts.js';
import {
  buttonClass,
  cardClass,
  Dialog,
  Failure,
  Field,
  InlineError,
  inputClass,
  Loading,
} from '../ui.js';
import { PlanStatusBadge, useIntervalText } from './maintenance-parts.js';

/** What the plans section needs to know about its asset. */
type PlanAsset = Pick<AssetDetail['asset'], 'id' | 'status' | 'customer'>;

/**
 * An asset's maintenance plans (P27), on the asset screen: each says how
 * often the asset is serviced, when next, and what it made last. Whoever
 * manages assets adds, changes, pauses and ends them. Changing a plan only
 * moves what has not been made yet; jobs already created stay as they are.
 */
export function AssetPlansSection({ asset }: { asset: PlanAsset }) {
  const { t } = useTranslation();
  const { client, locale, paths, navigate } = useOperations();
  const intervalText = useIntervalText();
  const [editing, setEditing] = useState<MaintenancePlan | 'new' | undefined>();
  const [ending, setEnding] = useState<MaintenancePlan | undefined>();
  const queryClient = useQueryClient();

  const query = { assetId: asset.id, includeEnded: true };
  const plans = useQuery({
    queryKey: keys.maintenancePlans(query),
    queryFn: async () =>
      (
        await client.GET('/v1/maintenance-plans', {
          params: { query: { assetId: asset.id, includeEnded: 'true' } },
        })
      ).data!,
  });
  const manage = plans.data?.can.manage ?? false;

  const status = useMutation({
    mutationFn: async ({
      plan,
      next,
    }: {
      plan: MaintenancePlan;
      next: MaintenancePlan['status'];
    }) =>
      (
        await client.POST('/v1/maintenance-plans/{planId}/status', {
          params: { path: { planId: plan.id } },
          body: { expectedVersion: plan.version, status: next },
        })
      ).data!,
    onSuccess: () => {
      setEnding(undefined);
      void queryClient.invalidateQueries({ queryKey: ['maintenance'] });
    },
  });

  const day = (value: string) => formatCalendarDate(value, { locale });

  return (
    <section aria-labelledby="asset-plans" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="asset-plans" className="text-lg font-semibold text-content">
          {t('operations.maintenance.plans.title')}
        </h2>
        {manage && asset.status !== 'retired' ? (
          <button type="button" className={buttonClass.secondary} onClick={() => setEditing('new')}>
            {t('operations.maintenance.plans.add')}
          </button>
        ) : null}
      </div>
      {plans.isError ? (
        <Failure error={plans.error} onRetry={() => void plans.refetch()} />
      ) : plans.data === undefined ? (
        <Loading />
      ) : plans.data.items.length === 0 ? (
        <p className="text-sm text-content-muted">{t('operations.maintenance.plans.empty')}</p>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {plans.data.items.map((plan) => (
            <li key={plan.id} className={cardClass}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 dir="auto" className="font-semibold text-content">
                    {plan.title}
                  </h3>
                  <p className="text-sm text-content">{intervalText(plan)}</p>
                </div>
                <PlanStatusBadge status={plan.status} />
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div className="flex flex-col">
                  <dt className="text-content-muted">
                    {t('operations.maintenance.plans.nextDue')}
                  </dt>
                  <dd className="text-content">
                    {plan.status === 'ended'
                      ? t('operations.maintenance.plans.noneEnded')
                      : plan.nextDueOn === null
                        ? t('operations.maintenance.plans.waiting')
                        : day(plan.nextDueOn)}
                  </dd>
                </div>
                <div className="flex flex-col">
                  <dt className="text-content-muted">
                    {t('operations.maintenance.fields.jobType')}
                  </dt>
                  <dd dir="auto" className="text-content">
                    {plan.jobType.name}
                  </dd>
                </div>
                {plan.upcoming.length > 1 ? (
                  <div className="col-span-2 flex flex-col">
                    <dt className="text-content-muted">
                      {t('operations.maintenance.plans.upcoming')}
                    </dt>
                    <dd className="text-content">
                      {plan.upcoming.map(day).join(t('operations.qualifications.listSeparator'))}
                    </dd>
                  </div>
                ) : null}
                <div className="flex flex-col">
                  <dt className="text-content-muted">{t('operations.maintenance.plans.last')}</dt>
                  <dd className="text-content">
                    {plan.last === null ? (
                      t('operations.maintenance.plans.noneYet')
                    ) : plan.last.workOrder === null ? (
                      day(plan.last.dueOn)
                    ) : (
                      <a
                        href={paths.workOrder(plan.last.workOrder.id)}
                        className="text-accent underline-offset-4 hover:underline"
                        onClick={(event) => {
                          event.preventDefault();
                          navigate(paths.workOrder(plan.last!.workOrder!.id));
                        }}
                      >
                        <span dir="ltr">{plan.last.workOrder.reference}</span> ·{' '}
                        {day(plan.last.dueOn)}
                      </a>
                    )}
                  </dd>
                </div>
                <div className="flex flex-col">
                  <dt className="text-content-muted">
                    {t('operations.maintenance.fields.contract')}
                  </dt>
                  <dd className="text-content">
                    {plan.contract === null ? (
                      t('operations.maintenance.plans.noContract')
                    ) : (
                      <ContractLink contract={plan.contract} />
                    )}
                  </dd>
                </div>
                <div className="flex flex-col">
                  <dt className="text-content-muted">{t('operations.maintenance.plans.window')}</dt>
                  <dd className="text-content">
                    {t('operations.maintenance.plans.windowText', {
                      before: plan.windowBeforeDays,
                      after: plan.windowAfterDays,
                    })}
                  </dd>
                </div>
                <div className="flex flex-col">
                  <dt className="text-content-muted">{t('operations.maintenance.fields.lead')}</dt>
                  <dd className="text-content">{plan.leadDays}</dd>
                </div>
              </dl>
              <p className="text-xs text-content-muted">
                {plan.canShare
                  ? t('operations.maintenance.plans.shares')
                  : t('operations.maintenance.plans.ownJob')}
              </p>
              {manage && plan.status !== 'ended' ? (
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    className={buttonClass.ghost}
                    onClick={() => setEditing(plan)}
                  >
                    {t('operations.common.edit')} <span className="sr-only">{plan.title}</span>
                  </button>
                  <button
                    type="button"
                    className={buttonClass.ghost}
                    disabled={status.isPending}
                    onClick={() =>
                      status.mutate({ plan, next: plan.status === 'active' ? 'paused' : 'active' })
                    }
                  >
                    {plan.status === 'active'
                      ? t('operations.maintenance.plans.pause')
                      : t('operations.maintenance.plans.resume')}{' '}
                    <span className="sr-only">{plan.title}</span>
                  </button>
                  <button
                    type="button"
                    className={buttonClass.ghost}
                    onClick={() => setEnding(plan)}
                  >
                    {t('operations.maintenance.plans.end')}{' '}
                    <span className="sr-only">{plan.title}</span>
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {status.isError && ending === undefined ? <Failure error={status.error} /> : null}

      {editing === undefined || plans.data === undefined ? null : (
        <PlanDialog
          asset={asset}
          plan={editing === 'new' ? undefined : editing}
          defaults={plans.data.defaults}
          onClose={() => setEditing(undefined)}
        />
      )}
      {ending === undefined ? null : (
        <Dialog
          title={t('operations.maintenance.plans.endTitle', { title: ending.title })}
          onClose={() => setEnding(undefined)}
          footer={
            <>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setEnding(undefined)}
              >
                {t('operations.maintenance.plans.keep')}
              </button>
              <button
                type="button"
                className={buttonClass.danger}
                disabled={status.isPending}
                aria-busy={status.isPending}
                onClick={() => status.mutate({ plan: ending, next: 'ended' })}
              >
                {t('operations.maintenance.plans.confirmEnd')}
              </button>
            </>
          }
        >
          <p className="text-content">{t('operations.maintenance.plans.endHint')}</p>
          {status.isError ? <Failure error={status.error} /> : null}
        </Dialog>
      )}
    </section>
  );
}

function PlanDialog({
  asset,
  plan,
  defaults,
  onClose,
}: {
  asset: PlanAsset;
  plan: MaintenancePlan | undefined;
  defaults: { leadDays: number; windowDays: number };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queryClient = useQueryClient();
  const formId = `plan-${plan?.id ?? 'new'}`;

  const [title, setTitle] = useState(plan?.title ?? '');
  const [jobTypeId, setJobTypeId] = useState(plan?.jobType.id ?? '');
  const [count, setCount] = useState(String(plan?.intervalCount ?? 3));
  const [unit, setUnit] = useState<MaintenancePlan['intervalUnit']>(plan?.intervalUnit ?? 'month');
  const [counting, setCounting] = useState<MaintenancePlan['counting']>(
    plan?.counting ?? 'calendar',
  );
  const [startsOn, setStartsOn] = useState(plan?.startsOn ?? localDay());
  const [endsOn, setEndsOn] = useState(plan?.endsOn ?? '');
  const [before, setBefore] = useState(String(plan?.windowBeforeDays ?? defaults.windowDays));
  const [after, setAfter] = useState(String(plan?.windowAfterDays ?? defaults.windowDays));
  const [lead, setLead] = useState(String(plan?.leadDays ?? defaults.leadDays));
  const [canShare, setCanShare] = useState(plan?.canShare ?? true);
  const [contractId, setContractId] = useState(plan?.contract?.id ?? '');
  const [instructions, setInstructions] = useState(plan?.instructions ?? '');

  const jobTypes = useQuery({
    queryKey: keys.jobTypes(false),
    queryFn: async () => (await client.GET('/v1/job-types')).data!.items,
  });
  const contracts = useQuery({
    queryKey: keys.contracts({ customerId: asset.customer.id }),
    queryFn: async () =>
      (
        await client.GET('/v1/contracts', {
          params: { query: { customerId: asset.customer.id } },
        })
      ).data!,
    // Someone who keeps assets but may not read contracts simply has no choice to make.
    retry: false,
  });
  const contractChoices = (contracts.data?.items ?? []).filter(
    (contract) =>
      contract.id === contractId ||
      contract.standing === 'active' ||
      contract.standing === 'ending' ||
      contract.standing === 'upcoming',
  );

  const interval = wholeNumber(count, 1, PLAN_INTERVAL_MAX);
  const windowBefore = wholeNumber(before, 0, PLAN_WINDOW_DAYS_MAX);
  const windowAfter = wholeNumber(after, 0, PLAN_WINDOW_DAYS_MAX);
  const leadDays = wholeNumber(lead, 0, PLAN_LEAD_DAYS_MAX);
  const reversed = termReversed(startsOn, endsOn);
  const ready =
    title.trim() !== '' &&
    jobTypeId !== '' &&
    typeof interval === 'number' &&
    startsOn !== '' &&
    !reversed &&
    typeof windowBefore === 'number' &&
    typeof windowAfter === 'number' &&
    typeof leadDays === 'number';

  const save = useMutation({
    mutationFn: async () => {
      const fields = {
        title: title.trim(),
        jobTypeId,
        contractId: contractId === '' ? null : contractId,
        instructions: instructions.trim() === '' ? null : instructions.trim(),
        intervalCount: interval!,
        intervalUnit: unit,
        counting,
        startsOn,
        endsOn: endsOn === '' ? null : endsOn,
        windowBeforeDays: windowBefore!,
        windowAfterDays: windowAfter!,
        leadDays: leadDays!,
        canShare,
      };
      return plan === undefined
        ? (await client.POST('/v1/maintenance-plans', { body: { assetId: asset.id, ...fields } }))
            .data!
        : (
            await client.PATCH('/v1/maintenance-plans/{planId}', {
              params: { path: { planId: plan.id } },
              body: { expectedVersion: plan.version, ...fields },
            })
          ).data!;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['maintenance'] });
      onClose();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready && !save.isPending) {
      save.mutate();
    }
  };

  const numberBox = (
    id: string,
    value: string,
    set: (value: string) => void,
    max: number,
    valid: boolean,
    describedBy?: string,
    min = 0,
  ) => (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      required
      className={inputClass}
      value={value}
      aria-invalid={!valid}
      aria-describedby={describedBy}
      onChange={(event) => set(event.target.value)}
    />
  );

  return (
    <Dialog
      wide
      title={
        plan === undefined
          ? t('operations.maintenance.plans.add')
          : t('operations.maintenance.plans.editTitle', { title: plan.title })
      }
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
            disabled={!ready || save.isPending}
            aria-busy={save.isPending}
          >
            {t('operations.maintenance.plans.save')}
          </button>
        </>
      }
    >
      {plan === undefined ? null : (
        <p className="text-content-muted">{t('operations.maintenance.plans.editHint')}</p>
      )}
      <form id={formId} onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label={t('operations.maintenance.fields.title')} className="sm:col-span-2">
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
        <Field label={t('operations.maintenance.fields.jobType')}>
          {(id) => (
            <select
              id={id}
              required
              className={inputClass}
              value={jobTypeId}
              onChange={(event) => setJobTypeId(event.target.value)}
            >
              <option value="" disabled>
                {t('operations.maintenance.fields.chooseJobType')}
              </option>
              {(jobTypes.data ?? [])
                .filter((type) => !type.archived || type.id === jobTypeId)
                .map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
            </select>
          )}
        </Field>
        <Field
          label={t('operations.maintenance.fields.contract')}
          hint={t('operations.maintenance.fields.contractHint')}
        >
          {(id, describedBy) => (
            <select
              id={id}
              className={inputClass}
              value={contractId}
              aria-describedby={describedBy}
              onChange={(event) => setContractId(event.target.value)}
            >
              <option value="">{t('operations.maintenance.fields.noContract')}</option>
              {contractChoices.map((contract) => (
                <option key={contract.id} value={contract.id}>
                  {`${contract.reference} · ${contract.title}`}
                </option>
              ))}
            </select>
          )}
        </Field>
        {jobTypes.isError ? (
          <div className="sm:col-span-2">
            <InlineError onRetry={() => void jobTypes.refetch()} />
          </div>
        ) : null}

        <fieldset className="flex flex-col gap-2 sm:col-span-2">
          <legend className="text-sm font-medium text-content">
            {t('operations.maintenance.fields.interval')}
          </legend>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('operations.maintenance.fields.every')}>
              {(id) =>
                numberBox(
                  id,
                  count,
                  setCount,
                  PLAN_INTERVAL_MAX,
                  interval !== undefined && interval !== null,
                  undefined,
                  1,
                )
              }
            </Field>
            <Field label={t('operations.maintenance.fields.unit')}>
              {(id) => (
                <select
                  id={id}
                  className={inputClass}
                  value={unit}
                  onChange={(event) =>
                    setUnit(event.target.value as MaintenancePlan['intervalUnit'])
                  }
                >
                  {INTERVAL_UNITS.map((option) => (
                    <option key={option} value={option}>
                      {t(`operations.maintenance.unit.${option}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-1 sm:col-span-2">
          <legend className="text-sm font-medium text-content">
            {t('operations.maintenance.fields.counting')}
          </legend>
          {(['calendar', 'completion'] as const).map((option) => (
            <div key={option} className="flex flex-col">
              <label className="flex items-center gap-2 text-sm text-content">
                <input
                  type="radio"
                  name={`${formId}-counting`}
                  value={option}
                  checked={counting === option}
                  aria-describedby={`${formId}-${option}-hint`}
                  onChange={() => setCounting(option)}
                />
                {t(`operations.maintenance.counting.${option}.label`)}
              </label>
              <span id={`${formId}-${option}-hint`} className="ps-6 text-xs text-content-muted">
                {t(`operations.maintenance.counting.${option}.hint`)}
              </span>
            </div>
          ))}
        </fieldset>

        <Field label={t('operations.maintenance.fields.startsOn')}>
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
        <Field
          label={t('operations.maintenance.fields.endsOn')}
          hint={t('operations.maintenance.fields.endsOnHint')}
        >
          {(id, describedBy) => (
            <input
              id={id}
              type="date"
              className={inputClass}
              value={endsOn}
              aria-invalid={reversed}
              aria-describedby={describedBy}
              onChange={(event) => setEndsOn(event.target.value)}
            />
          )}
        </Field>
        {reversed ? (
          <p className="text-sm text-danger sm:col-span-2">
            {t('operations.maintenance.fields.datesReversed')}
          </p>
        ) : null}

        <fieldset className="flex flex-col gap-2 sm:col-span-2">
          <legend className="text-sm font-medium text-content">
            {t('operations.maintenance.fields.window')}
          </legend>
          <p className="text-xs text-content-muted">
            {t('operations.maintenance.fields.windowHint')}
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('operations.maintenance.fields.before')}>
              {(id) =>
                numberBox(
                  id,
                  before,
                  setBefore,
                  PLAN_WINDOW_DAYS_MAX,
                  typeof windowBefore === 'number',
                )
              }
            </Field>
            <Field label={t('operations.maintenance.fields.after')}>
              {(id) =>
                numberBox(
                  id,
                  after,
                  setAfter,
                  PLAN_WINDOW_DAYS_MAX,
                  typeof windowAfter === 'number',
                )
              }
            </Field>
            <Field
              label={t('operations.maintenance.fields.lead')}
              hint={t('operations.maintenance.fields.leadHint')}
            >
              {(id, describedBy) =>
                numberBox(
                  id,
                  lead,
                  setLead,
                  PLAN_LEAD_DAYS_MAX,
                  typeof leadDays === 'number',
                  describedBy,
                )
              }
            </Field>
          </div>
        </fieldset>

        <div className="flex flex-col sm:col-span-2">
          <label className="flex items-center gap-2 text-sm text-content">
            <input
              type="checkbox"
              checked={canShare}
              aria-describedby={`${formId}-share-hint`}
              onChange={(event) => setCanShare(event.target.checked)}
            />
            {t('operations.maintenance.fields.canShare')}
          </label>
          <span id={`${formId}-share-hint`} className="ps-6 text-xs text-content-muted">
            {t('operations.maintenance.fields.canShareHint')}
          </span>
        </div>

        <Field
          label={t('operations.maintenance.fields.instructions')}
          hint={t('operations.common.optional')}
          className="sm:col-span-2"
        >
          {(id, describedBy) => (
            <textarea
              id={id}
              rows={3}
              maxLength={10_000}
              className={inputClass}
              value={instructions}
              aria-describedby={describedBy}
              onChange={(event) => setInstructions(event.target.value)}
            />
          )}
        </Field>
      </form>
      {save.isError ? <Failure error={save.error} /> : null}
    </Dialog>
  );
}
