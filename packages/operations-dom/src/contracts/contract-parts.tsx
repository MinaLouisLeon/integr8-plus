import { DEFAULT_RENEWAL_NOTICE_DAYS, RENEWAL_NOTICE_DAYS_MAX } from '@integr8/core';
import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import {
  type Contract,
  type ContractStanding,
  type JobCoverage,
  keys,
  useOperations,
} from '../api.js';
import { CustomerPicker } from '../crm/opportunity-parts.js';
import { buttonClass, Dialog, Failure, Field, InlineError, inputClass } from '../ui.js';
import {
  moneyValid,
  scopeBody,
  scopeDraft,
  type ScopeDraft,
  scopeEmpty,
  termReversed,
  wholeNumber,
} from './model.js';

/**
 * The pieces of service contracts (P27) the other screens share: a
 * contract's standing, a job's coverage in a list, a link to a contract, and
 * the form that adds or changes one.
 */

const badge =
  'inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium';

const STANDING_STYLE: Record<ContractStanding, string> = {
  upcoming: 'border-border-subtle bg-surface-muted text-content',
  active: 'border-success bg-success-subtle text-content',
  ending: 'border-warning bg-warning-subtle text-content',
  ended: 'border-danger bg-danger-subtle text-content',
  cancelled: 'border-border-subtle bg-surface-muted text-content-muted line-through',
};

/** In words, never colour alone. */
export function ContractStandingBadge({ standing }: { standing: ContractStanding }) {
  const { t } = useTranslation();
  return (
    <span className={`${badge} ${STANDING_STYLE[standing]}`}>
      {t(`operations.contracts.standing.${standing}`)}
    </span>
  );
}

/**
 * Whether a contract covers a job, small enough for a row. Nothing at all for
 * a customer that never had a contract: every job of theirs is chargeable,
 * and saying so on each would be noise.
 */
export function CoverageBadge({ coverage }: { coverage: JobCoverage | null }) {
  const { t } = useTranslation();
  if (coverage === null) {
    return null;
  }
  const covered = coverage.status === 'covered';
  return (
    <span
      className={`${badge} ${
        covered
          ? 'border-success bg-success-subtle text-content'
          : 'border-warning bg-warning-subtle text-content'
      }`}
      title={
        covered && coverage.contract !== null
          ? t('operations.coverage.coveredBy', { reference: coverage.contract.reference })
          : t(`operations.coverage.reason.${coverage.reason}`)
      }
    >
      {covered
        ? coverage.contract === null
          ? t('operations.coverage.covered')
          : t('operations.coverage.coveredShort', { reference: coverage.contract.reference })
        : t('operations.coverage.chargeable')}
    </span>
  );
}

/** A contract's reference as a link to it. */
export function ContractLink({
  contract,
  children,
}: {
  contract: { id: string; reference: string };
  children?: ReactNode;
}) {
  const { paths, navigate } = useOperations();
  return (
    <a
      href={paths.contract(contract.id)}
      className="text-accent underline-offset-4 hover:underline"
      onClick={(event) => {
        event.preventDefault();
        navigate(paths.contract(contract.id));
      }}
    >
      <span dir="ltr">{contract.reference}</span>
      {children}
    </a>
  );
}

/** `1 Jan 2026 to 31 Dec 2026`. */
export function TermText({ startsOn, endsOn }: { startsOn: string; endsOn: string }) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  return (
    <>
      {t('operations.contracts.termRange', {
        from: formatCalendarDate(startsOn, { locale }),
        to: formatCalendarDate(endsOn, { locale }),
      })}
    </>
  );
}

/** What a coverage list reads as: "All sites", or the names. */
export function ScopeText({
  list,
  all,
}: {
  list: readonly { id: string; name: string }[] | null;
  all: string;
}) {
  const { t } = useTranslation();
  if (list === null) {
    return <>{all}</>;
  }
  if (list.length === 0) {
    return <>{t('operations.contracts.scope.none')}</>;
  }
  return (
    <ul className="flex flex-col">
      {list.map((entry) => (
        <li key={entry.id} dir="auto">
          {entry.name === '' ? '—' : entry.name}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Adding or changing a contract
// ---------------------------------------------------------------------------

function ScopeFieldset({
  legend,
  allLabel,
  choices,
  known,
  value,
  onChange,
  waiting,
  loading,
  failed,
  onRetry,
  name,
}: {
  legend: string;
  allLabel: string;
  choices: readonly { id: string; name: string }[];
  /** Names already known for chosen ones, from the contract as it was loaded. */
  known: readonly { id: string; name: string }[];
  /** Why there is nothing to choose from yet, such as no customer chosen. */
  waiting?: string | undefined;
  value: ScopeDraft;
  onChange: (value: ScopeDraft) => void;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  name: string;
}) {
  const { t } = useTranslation();
  // A chosen one that is no longer offered (archived, moved) still shows, so it can be taken off.
  const offered = [
    ...choices,
    ...value.ids
      .filter((id) => !choices.some((choice) => choice.id === id))
      .map((id) => {
        const name = known.find((entry) => entry.id === id)?.name ?? '';
        return { id, name: name === '' ? '—' : name };
      }),
  ];
  return (
    <fieldset className="flex flex-col gap-2 sm:col-span-2">
      <legend className="text-sm font-medium text-content">{legend}</legend>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm text-content">
          <input
            type="radio"
            name={name}
            checked={value.all}
            onChange={() => onChange({ ...value, all: true })}
          />
          {allLabel}
        </label>
        <label className="flex items-center gap-2 text-sm text-content">
          <input
            type="radio"
            name={name}
            checked={!value.all}
            onChange={() => onChange({ ...value, all: false })}
          />
          {t('operations.contracts.scope.only')}
        </label>
      </div>
      {value.all ? null : waiting !== undefined ? (
        <p className="text-sm text-content-muted">{waiting}</p>
      ) : failed ? (
        <InlineError onRetry={onRetry} />
      ) : loading ? (
        <p className="text-sm text-content-muted">{t('common.loading')}</p>
      ) : offered.length === 0 ? (
        <p className="text-sm text-content-muted">
          {t('operations.contracts.scope.nothingToChoose')}
        </p>
      ) : (
        <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border border-border-subtle p-2">
          {offered.map((choice) => (
            <label key={choice.id} className="flex items-center gap-2 text-sm text-content">
              <input
                type="checkbox"
                checked={value.ids.includes(choice.id)}
                onChange={(event) =>
                  onChange({
                    all: false,
                    ids: event.target.checked
                      ? [...value.ids, choice.id]
                      : value.ids.filter((id) => id !== choice.id),
                  })
                }
              />
              <span dir="auto">{choice.name}</span>
            </label>
          ))}
        </div>
      )}
      {scopeEmpty(value) && !loading && waiting === undefined ? (
        <p className="text-xs text-danger">{t('operations.contracts.scope.chooseOne')}</p>
      ) : null}
    </fieldset>
  );
}

/**
 * Adds a contract, or changes one. A new one starts from a customer — chosen
 * here, or given by the customer screen — and then that customer's sites,
 * assets and job types can be chosen, or all of each.
 */
export function ContractDialog({
  contract,
  customer: presetCustomer,
  renewalNoticeDays = DEFAULT_RENEWAL_NOTICE_DAYS,
  onClose,
  onSaved,
}: {
  contract?: Contract;
  customer?: { id: string; name: string };
  renewalNoticeDays?: number | undefined;
  onClose: () => void;
  onSaved: (saved: Contract) => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queryClient = useQueryClient();
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(
    contract?.customer ?? presetCustomer ?? null,
  );
  const [title, setTitle] = useState(contract?.title ?? '');
  const [startsOn, setStartsOn] = useState(contract?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(contract?.endsOn ?? '');
  const [value, setValue] = useState(contract?.value ?? '');
  const [notice, setNotice] = useState(String(contract?.renewalNoticeDays ?? renewalNoticeDays));
  const [callouts, setCallouts] = useState(
    contract?.includedCallouts === null || contract === undefined
      ? ''
      : String(contract.includedCallouts),
  );
  const [notes, setNotes] = useState(contract?.notes ?? '');
  const [sites, setSites] = useState(scopeDraft(contract?.sites ?? null));
  const [assets, setAssets] = useState(scopeDraft(contract?.assets ?? null));
  const [jobTypes, setJobTypes] = useState(scopeDraft(contract?.jobTypes ?? null));

  const customerId = customer?.id ?? '';
  const siteChoices = useQuery({
    queryKey: ['sites', 'of', customerId],
    queryFn: async () =>
      (await client.GET('/v1/sites', { params: { query: { customerId, limit: 200 } } })).data!
        .items,
    enabled: customerId !== '' && !sites.all,
  });
  const assetChoices = useQuery({
    queryKey: keys.assets({ customerId, limit: 200 }),
    queryFn: async () =>
      (await client.GET('/v1/assets', { params: { query: { customerId, limit: 200 } } })).data!,
    enabled: customerId !== '' && !assets.all,
  });
  const typeChoices = useQuery({
    queryKey: keys.jobTypes(false),
    queryFn: async () => (await client.GET('/v1/job-types')).data!.items,
    enabled: !jobTypes.all,
  });

  const noticeDays = wholeNumber(notice, 0, RENEWAL_NOTICE_DAYS_MAX);
  const included = wholeNumber(callouts, 0, 10_000);
  const reversed = termReversed(startsOn, endsOn);
  const valueBad = value.trim() !== '' && !moneyValid(value);
  const ready =
    customer !== null &&
    title.trim() !== '' &&
    startsOn !== '' &&
    endsOn !== '' &&
    !reversed &&
    !valueBad &&
    noticeDays !== undefined &&
    noticeDays !== null &&
    included !== undefined &&
    !scopeEmpty(sites) &&
    !scopeEmpty(assets) &&
    !scopeEmpty(jobTypes);

  const save = useMutation({
    mutationFn: async () => {
      const fields = {
        title: title.trim(),
        startsOn,
        endsOn,
        value: value.trim() === '' ? null : value.trim(),
        notes: notes.trim() === '' ? null : notes.trim(),
        renewalNoticeDays: noticeDays ?? renewalNoticeDays,
        siteIds: scopeBody(sites),
        assetIds: scopeBody(assets),
        jobTypeIds: scopeBody(jobTypes),
        includedCallouts: included ?? null,
      };
      return contract === undefined
        ? (await client.POST('/v1/contracts', { body: { customerId, ...fields } })).data!
        : (
            await client.PATCH('/v1/contracts/{contractId}', {
              params: { path: { contractId: contract.id } },
              body: { expectedVersion: contract.version, ...fields },
            })
          ).data!;
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['contracts'] });
      onSaved(saved);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready && !save.isPending) {
      save.mutate();
    }
  };
  const formId = `contract-${contract?.id ?? 'new'}`;

  return (
    <Dialog
      wide
      title={
        contract === undefined
          ? t('operations.contracts.add')
          : t('operations.contracts.editTitle', { reference: contract.reference })
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
            {t('operations.contracts.save')}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          {contract !== undefined || presetCustomer !== undefined ? (
            <Field label={t('operations.contracts.customer')}>
              {(id) => (
                <output id={id} dir="auto" className="text-sm text-content">
                  {customer?.name}
                </output>
              )}
            </Field>
          ) : (
            <CustomerPicker
              label={t('operations.contracts.customer')}
              value={customer}
              onChange={(next) => {
                setCustomer(next);
                // Another customer's sites and assets cannot be on it.
                setSites((current) => ({ ...current, ids: [] }));
                setAssets((current) => ({ ...current, ids: [] }));
              }}
            />
          )}
        </div>
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
        <Field label={t('operations.contracts.endsOn')} hint={t('operations.contracts.endsOnHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              type="date"
              required
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
        <Field
          label={t('operations.contracts.includedCallouts')}
          hint={t('operations.contracts.includedCalloutsHint')}
        >
          {(id, describedBy) => (
            <input
              id={id}
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              className={inputClass}
              value={callouts}
              aria-invalid={included === undefined}
              aria-describedby={describedBy}
              onChange={(event) => setCallouts(event.target.value)}
            />
          )}
        </Field>
        <Field
          label={t('operations.contracts.noticeDays')}
          hint={t('operations.contracts.noticeDaysHint')}
        >
          {(id, describedBy) => (
            <input
              id={id}
              type="number"
              inputMode="numeric"
              min={0}
              max={RENEWAL_NOTICE_DAYS_MAX}
              step={1}
              required
              className={inputClass}
              value={notice}
              aria-invalid={noticeDays === undefined || noticeDays === null}
              aria-describedby={describedBy}
              onChange={(event) => setNotice(event.target.value)}
            />
          )}
        </Field>
        <div className="hidden sm:block" />

        <ScopeFieldset
          name={`${formId}-sites`}
          legend={t('operations.contracts.sites')}
          allLabel={t('operations.contracts.scope.allSites')}
          choices={siteChoices.data ?? []}
          value={sites}
          onChange={setSites}
          known={contract?.sites ?? []}
          waiting={customer === null ? t('operations.contracts.scope.customerFirst') : undefined}
          loading={siteChoices.isPending}
          failed={siteChoices.isError}
          onRetry={() => void siteChoices.refetch()}
        />
        <ScopeFieldset
          name={`${formId}-assets`}
          legend={t('operations.contracts.assets')}
          allLabel={t('operations.contracts.scope.allAssets')}
          choices={(assetChoices.data?.items ?? []).map((asset) => ({
            id: asset.id,
            name: `${asset.reference} · ${asset.name}`,
          }))}
          value={assets}
          onChange={setAssets}
          known={contract?.assets ?? []}
          waiting={customer === null ? t('operations.contracts.scope.customerFirst') : undefined}
          loading={assetChoices.isPending}
          failed={assetChoices.isError}
          onRetry={() => void assetChoices.refetch()}
        />
        <ScopeFieldset
          name={`${formId}-types`}
          legend={t('operations.contracts.jobTypes')}
          allLabel={t('operations.contracts.scope.allJobTypes')}
          choices={(typeChoices.data ?? []).filter((type) => !type.archived)}
          value={jobTypes}
          onChange={setJobTypes}
          known={contract?.jobTypes ?? []}
          loading={typeChoices.isPending}
          failed={typeChoices.isError}
          onRetry={() => void typeChoices.refetch()}
        />

        <Field label={t('operations.contracts.notes')} className="sm:col-span-2">
          {(id) => (
            <textarea
              id={id}
              rows={2}
              maxLength={4000}
              className={inputClass}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </Field>
      </form>
      {save.isError ? <Failure error={save.error} /> : null}
    </Dialog>
  );
}
