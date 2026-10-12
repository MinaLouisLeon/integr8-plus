import { DEFAULT_PIPELINE_STAGES } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { type Customer, keys, type Opportunity, type Stage, useOperations } from '../api.js';
import { buttonClass, Dialog, Failure, Field, inputClass } from '../ui.js';
import { useMembers } from './lead-parts.js';

/**
 * Pieces the opportunity screens share (CRM/ERP plan, phase C3): stage names,
 * a chance as a percentage, the pipeline, and the new-opportunity dialog used
 * from the board, a lead and a customer.
 */

type BuiltInStage = (typeof DEFAULT_PIPELINE_STAGES)[number]['key'];
const BUILT_IN = new Set<string>(DEFAULT_PIPELINE_STAGES.map((stage) => stage.key));
const isBuiltIn = (key: string): key is BuiltInStage => BUILT_IN.has(key);

/** A stage's name: translated for the built-in ones, the company's own label otherwise. */
export function useStageName(): (stage: Pick<Stage, 'key' | 'label'>) => string {
  const { t } = useTranslation();
  return (stage) => (isBuiltIn(stage.key) ? t(`crm.stage.${stage.key}`) : stage.label);
}

const STATUS_STYLE: Record<Opportunity['status'], string> = {
  open: 'border-accent bg-surface text-content',
  won: 'border-success bg-success text-on-accent',
  lost: 'border-border-subtle bg-surface-muted text-content-muted',
};

export function StageBadge({ stage, status }: { stage: Stage; status: Opportunity['status'] }) {
  const stageName = useStageName();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}
    >
      {stageName(stage)}
    </span>
  );
}

/** Basis points as a percentage in the reader's locale: 2500 → "25%". Not money, so a number is fine. */
export function formatChance(basisPoints: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(
    basisPoints / 10_000,
  );
}

/** The company's pipelines; the default one first. */
export function usePipelines() {
  const { client } = useOperations();
  return useQuery({
    queryKey: keys.pipelines,
    queryFn: async () => (await client.GET('/v1/crm/pipelines')).data!.items,
  });
}

/** Finds a customer by name, for linking an opportunity to one. */
export function CustomerPicker({
  value,
  onChange,
  label,
}: {
  value: Pick<Customer, 'id' | 'name'> | null;
  onChange: (customer: Pick<Customer, 'id' | 'name'> | null) => void;
  label: string;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [text, setText] = useState('');
  const [searched, setSearched] = useState('');
  const found = useQuery({
    queryKey: keys.customers({ q: searched, limit: 10 }),
    queryFn: async () =>
      (await client.GET('/v1/customers', { params: { query: { q: searched, limit: 10 } } })).data!
        .items,
    enabled: searched !== '',
  });

  if (value !== null) {
    return (
      <Field label={label}>
        {(id) => (
          <div className="flex items-center gap-2">
            <output id={id} className="flex-1 text-sm text-content">
              {value.name}
            </output>
            <button type="button" className={buttonClass.ghost} onClick={() => onChange(null)}>
              {t('crm.opportunities.changeCustomer')}
            </button>
          </div>
        )}
      </Field>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Field label={label}>
        {(id) => (
          <div className="flex gap-2">
            <input
              id={id}
              type="search"
              className={inputClass}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  setSearched(text.trim());
                }
              }}
            />
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setSearched(text.trim())}
            >
              {t('crm.convert.search')}
            </button>
          </div>
        )}
      </Field>
      {searched === '' || found.isPending ? null : found.isError ? (
        <Failure error={found.error} onRetry={() => void found.refetch()} />
      ) : found.data.length === 0 ? (
        <p className="text-sm text-content-muted">{t('crm.convert.noResults')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {found.data
            .filter((customer) => customer.status !== 'closed')
            .map((customer) => (
              <li key={customer.id}>
                <button
                  type="button"
                  className="w-full rounded-md p-2 text-start text-sm text-content hover:bg-surface-muted"
                  onClick={() => onChange(customer)}
                >
                  {customer.name}
                  {customer.accountNumber === null ? null : (
                    <span className="ms-2 text-content-muted">{customer.accountNumber}</span>
                  )}
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Adds an opportunity, for a customer, a lead or both. Opened from the board
 * (pick a customer), a lead (for that lead) or a customer (for that customer).
 */
export function NewOpportunityDialog({
  customer,
  lead,
  onClose,
}: {
  customer?: Pick<Customer, 'id' | 'name'>;
  lead?: { id: string; displayName: string; assignedTo: string | null };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { client, navigate, paths } = useOperations();
  const queries = useQueryClient();
  const members = useMembers();
  const [chosen, setChosen] = useState<Pick<Customer, 'id' | 'name'> | null>(customer ?? null);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [currencyCode, setCurrencyCode] = useState('');
  const [closeDate, setCloseDate] = useState('');
  const [ownerId, setOwnerId] = useState(lead?.assignedTo ?? '');

  const body = {
    title: title.trim(),
    ...(chosen === null ? {} : { customerId: chosen.id }),
    ...(lead === undefined ? {} : { leadId: lead.id }),
    amount: amount.trim() === '' ? null : amount.trim(),
    ...(currencyCode.trim() === '' ? {} : { currencyCode: currencyCode.trim().toUpperCase() }),
    expectedCloseDate: closeDate === '' ? null : closeDate,
    ownerId: ownerId === '' ? null : ownerId,
  };
  // One key per distinct request: a retry replays, a changed form is a new request.
  const bodyText = JSON.stringify(body);
  const idempotencyKey = useMemo(() => (bodyText === '' ? '' : crypto.randomUUID()), [bodyText]);

  const create = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/crm/opportunities', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body,
        })
      ).data!,
    onSuccess: async (created) => {
      await queries.invalidateQueries({ queryKey: ['crm'] });
      navigate(paths.crmOpportunity(created.id));
    },
  });

  const ready = body.title !== '' && (chosen !== null || lead !== undefined);

  return (
    <Dialog
      title={t('crm.opportunities.new')}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('crm.leads.cancel')}
          </button>
          <button
            type="submit"
            form="crm-new-opportunity"
            className={buttonClass.primary}
            disabled={!ready || create.isPending}
          >
            {create.isPending ? t('crm.leads.creating') : t('crm.opportunities.create')}
          </button>
        </>
      }
    >
      <form
        id="crm-new-opportunity"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            create.mutate();
          }
        }}
      >
        <Field label={t('crm.opportunities.fields.title')} className="sm:col-span-2">
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
        {lead === undefined ? null : (
          <p className="text-sm text-content-muted sm:col-span-2">
            {t('crm.opportunities.forLead', { name: lead.displayName })}
          </p>
        )}
        {customer !== undefined ? (
          <p className="text-sm text-content-muted sm:col-span-2">
            {t('crm.opportunities.forCustomer', { name: customer.name })}
          </p>
        ) : lead === undefined ? (
          <div className="sm:col-span-2">
            <CustomerPicker
              label={t('crm.opportunities.fields.customer')}
              value={chosen}
              onChange={setChosen}
            />
          </div>
        ) : null}
        <Field
          label={t('crm.opportunities.fields.amount')}
          hint={t('crm.opportunities.amountHint')}
        >
          {(id, describedBy) => (
            <input
              id={id}
              inputMode="decimal"
              dir="ltr"
              pattern="\d{1,16}(\.\d{1,4})?"
              aria-describedby={describedBy}
              className={inputClass}
              value={amount}
              onChange={(event) => setAmount(event.target.value.trim())}
            />
          )}
        </Field>
        <Field label={t('crm.leads.fields.currency')} hint={t('crm.leads.currencyHint')}>
          {(id, describedBy) => (
            <input
              id={id}
              dir="ltr"
              maxLength={3}
              pattern="[A-Za-z]{3}"
              aria-describedby={describedBy}
              className={inputClass}
              value={currencyCode}
              onChange={(event) => setCurrencyCode(event.target.value.toUpperCase())}
            />
          )}
        </Field>
        <Field label={t('crm.opportunities.fields.closeDate')}>
          {(id) => (
            <input
              id={id}
              type="date"
              className={inputClass}
              value={closeDate}
              onChange={(event) => setCloseDate(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('crm.opportunities.fields.owner')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={ownerId}
              onChange={(event) => setOwnerId(event.target.value)}
            >
              <option value="">{t('crm.leads.unassigned')}</option>
              {(members.data ?? [])
                .filter((member) => member.status === 'active')
                .map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.displayName}
                  </option>
                ))}
            </select>
          )}
        </Field>
        {create.isError ? (
          <div className="sm:col-span-2">
            <Failure error={create.error} />
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

/**
 * Closing a deal: why, when it was lost; a confirmation, when it was won. The
 * stage select asks it for lost, and dropping a card on won or lost asks it
 * for both; cancelling leaves the deal where it was.
 */
export function CloseDealDialog({
  opportunity,
  stage,
  onConfirm,
  onCancel,
}: {
  opportunity: Pick<Opportunity, 'id' | 'title'>;
  stage: Stage;
  onConfirm: (lostReason?: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const stageName = useStageName();
  const [reason, setReason] = useState('');
  const losing = stage.outcome === 'lost';
  const formId = `crm-close-${opportunity.id}`;

  return (
    <Dialog
      title={losing ? t('crm.opportunities.loseTitle') : t('crm.opportunities.winTitle')}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onCancel}>
            {t('crm.leads.cancel')}
          </button>
          <button
            type="submit"
            form={formId}
            className={buttonClass.primary}
            disabled={losing && reason.trim() === ''}
          >
            {losing ? t('crm.opportunities.markLost') : t('crm.opportunities.markWon')}
          </button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          if (!losing) {
            onConfirm();
          } else if (reason.trim() !== '') {
            onConfirm(reason.trim());
          }
        }}
      >
        {losing ? (
          <Field label={t('crm.opportunities.fields.lostReason')}>
            {(id) => (
              <textarea
                id={id}
                required
                rows={3}
                maxLength={1000}
                className={inputClass}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </Field>
        ) : (
          <p className="text-sm text-content">
            {t('crm.opportunities.winNote', {
              title: opportunity.title,
              stage: stageName(stage),
            })}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/**
 * Moving an opportunity to another stage: a select of its pipeline's live
 * stages, and a reason when the choice is "lost". The keyboard's way, beside
 * dragging a card on the board.
 */
export function MoveControl({
  opportunity,
  stages,
  onMove,
  disabled,
  label,
}: {
  opportunity: Pick<Opportunity, 'id' | 'title' | 'stage'>;
  stages: readonly Stage[];
  onMove: (stageId: string, lostReason?: string) => void;
  disabled?: boolean;
  label: string;
}) {
  const stageName = useStageName();
  const [losing, setLosing] = useState<Stage | null>(null);

  return (
    <>
      <Field label={label}>
        {(id) => (
          <select
            id={id}
            className={inputClass}
            value={opportunity.stage.id}
            disabled={disabled}
            onChange={(event) => {
              const stage = stages.find((candidate) => candidate.id === event.target.value);
              if (stage === undefined) {
                return;
              }
              if (stage.outcome === 'lost') {
                setLosing(stage);
              } else {
                onMove(stage.id);
              }
            }}
          >
            {stages
              .filter((stage) => !stage.archived || stage.id === opportunity.stage.id)
              .map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stageName(stage)}
                </option>
              ))}
          </select>
        )}
      </Field>
      {losing === null ? null : (
        <CloseDealDialog
          opportunity={opportunity}
          stage={losing}
          onCancel={() => setLosing(null)}
          onConfirm={(lostReason) => {
            onMove(losing.id, lostReason);
            setLosing(null);
          }}
        />
      )}
    </>
  );
}
