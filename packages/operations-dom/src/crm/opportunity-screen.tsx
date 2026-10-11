import { ApiRequestError } from '@integr8/api-client';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { keys, type OpportunityDetail, useOperations } from '../api.js';
import { BackLink, buttonClass, cardClass, Failure, Field, inputClass, Loading } from '../ui.js';
import { ActivityPanel } from './activities.js';
import { formatAmount, memberName, useMembers } from './lead-parts.js';
import { formatChance, MoveControl, StageBadge, useStageName } from './opportunity-parts.js';

/**
 * One opportunity (CRM/ERP plan, phase C3): what it is worth and to whom, its
 * stage with a way to move it, its history, and its follow-ups. The amount is
 * an estimate; winning it books nothing.
 */

interface Draft {
  title: string;
  amount: string;
  currencyCode: string;
  expectedCloseDate: string;
  probabilityPercent: string;
  ownerId: string;
  description: string;
}

function draftOf(item: OpportunityDetail['opportunity']): Draft {
  return {
    title: item.title,
    amount: item.amount ?? '',
    currencyCode: item.currencyCode,
    expectedCloseDate: item.expectedCloseDate ?? '',
    // Whole basis points shown as a percentage with up to two decimals: 2550 → "25.5".
    probabilityPercent: (item.probabilityBp / 100).toString(),
    ownerId: item.ownerId ?? '',
    description: item.description ?? '',
  };
}

/** The percentage typed, as whole basis points, or undefined when it is not one. */
function basisPoints(percent: string): number | undefined {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/u.exec(percent.trim());
  if (match === null) {
    return undefined;
  }
  const value = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return value <= 10_000 ? value : undefined;
}

function changes(before: Draft, after: Draft) {
  const body: Record<string, unknown> = {};
  if (after.title.trim() !== before.title) body.title = after.title.trim();
  if (after.amount.trim() !== before.amount)
    body.amount = after.amount.trim() === '' ? null : after.amount.trim();
  if (after.currencyCode.trim().toUpperCase() !== before.currencyCode)
    body.currencyCode = after.currencyCode.trim().toUpperCase();
  if (after.expectedCloseDate !== before.expectedCloseDate)
    body.expectedCloseDate = after.expectedCloseDate === '' ? null : after.expectedCloseDate;
  if (after.probabilityPercent.trim() !== before.probabilityPercent)
    body.probabilityBp = basisPoints(after.probabilityPercent);
  if (after.ownerId !== before.ownerId) body.ownerId = after.ownerId === '' ? null : after.ownerId;
  if (after.description.trim() !== before.description)
    body.description = after.description.trim() === '' ? null : after.description.trim();
  return body;
}

export function OpportunityScreen({ opportunityId }: { opportunityId: string }) {
  const { t } = useTranslation();
  const { client, paths, locale } = useOperations();
  const queries = useQueryClient();
  const stageName = useStageName();
  const members = useMembers();
  const [editing, setEditing] = useState<Draft | null>(null);
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const canManageActivities = me.data?.permissions.includes('crm.activity.manage') ?? false;

  const detail = useQuery({
    queryKey: keys.opportunity(opportunityId),
    queryFn: async () =>
      (
        await client.GET('/v1/crm/opportunities/{opportunityId}', {
          params: { path: { opportunityId } },
        })
      ).data!,
  });

  const settle = async () => {
    await queries.invalidateQueries({ queryKey: ['crm'] });
  };
  const save = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (
        await client.PATCH('/v1/crm/opportunities/{opportunityId}', {
          params: { path: { opportunityId } },
          body: { expectedVersion: detail.data!.opportunity.version, ...body },
        })
      ).data!,
    onSuccess: async () => {
      setEditing(null);
      await settle();
    },
  });
  const move = useMutation({
    mutationFn: async (input: { stageId: string; lostReason?: string }) =>
      (
        await client.POST('/v1/crm/opportunities/{opportunityId}/transitions', {
          params: { path: { opportunityId } },
          body: { expectedVersion: detail.data!.opportunity.version, ...input },
        })
      ).data!,
    onSuccess: async (next) => {
      queries.setQueryData(keys.opportunity(opportunityId), next);
      await settle();
    },
  });

  if (detail.isPending) {
    return <Loading />;
  }
  const back = <BackLink to={paths.crmOpportunities} label={t('crm.opportunities.back')} />;
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Failure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { opportunity: item, events, stages, can } = detail.data;
  const conflict = [save.error, move.error].find(
    (error) => error instanceof ApiRequestError && error.code === 'version_conflict',
  );
  const otherError = [save.error, move.error].find((error) => error !== null && error !== conflict);
  const draftInvalid =
    editing !== null &&
    (editing.title.trim() === '' || basisPoints(editing.probabilityPercent) === undefined);

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-2xl font-semibold break-words text-content">{item.title}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <StageBadge stage={item.stage} status={item.status} />
            {item.archivedAt === null ? null : (
              <span className="text-xs text-content-muted">{t('crm.leads.archived')}</span>
            )}
          </div>
        </div>
        {can.edit && editing === null ? (
          <div className="flex flex-wrap items-end gap-2">
            {item.archivedAt === null ? (
              <div className="w-48">
                <MoveControl
                  opportunity={item}
                  stages={stages}
                  disabled={move.isPending}
                  label={t('crm.opportunities.moveTo')}
                  onMove={(stageId, lostReason) =>
                    move.mutate({ stageId, ...(lostReason === undefined ? {} : { lostReason }) })
                  }
                />
              </div>
            ) : null}
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => {
                save.reset();
                setEditing(draftOf(item));
              }}
            >
              {t('crm.leads.edit')}
            </button>
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={save.isPending}
              onClick={() => save.mutate({ archived: item.archivedAt === null })}
            >
              {item.archivedAt === null ? t('crm.leads.archive') : t('crm.leads.restore')}
            </button>
          </div>
        ) : null}
      </header>

      {conflict === undefined ? null : (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-danger bg-danger-subtle p-4 text-sm text-content"
        >
          <span>{t('crm.opportunities.versionConflict')}</span>
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => {
              save.reset();
              move.reset();
              setEditing(null);
              void detail.refetch();
            }}
          >
            {t('crm.leads.reload')}
          </button>
        </div>
      )}
      {otherError === undefined ? null : <Failure error={otherError} />}

      {editing !== null ? (
        <form
          aria-label={t('crm.leads.edit')}
          className={cardClass}
          onSubmit={(event) => {
            event.preventDefault();
            const body = changes(draftOf(item), editing);
            if (Object.keys(body).length === 0) {
              setEditing(null);
              return;
            }
            save.mutate(body);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('crm.opportunities.fields.title')} className="sm:col-span-2">
              {(id) => (
                <input
                  id={id}
                  required
                  maxLength={200}
                  className={inputClass}
                  value={editing.title}
                  onChange={(event) => setEditing({ ...editing, title: event.target.value })}
                />
              )}
            </Field>
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
                  value={editing.amount}
                  onChange={(event) =>
                    setEditing({ ...editing, amount: event.target.value.trim() })
                  }
                />
              )}
            </Field>
            <Field label={t('crm.leads.fields.currency')}>
              {(id) => (
                <input
                  id={id}
                  dir="ltr"
                  required
                  maxLength={3}
                  pattern="[A-Za-z]{3}"
                  className={inputClass}
                  value={editing.currencyCode}
                  onChange={(event) =>
                    setEditing({ ...editing, currencyCode: event.target.value.toUpperCase() })
                  }
                />
              )}
            </Field>
            <Field
              label={t('crm.opportunities.fields.chance')}
              hint={t('crm.opportunities.chanceHint')}
            >
              {(id, describedBy) => (
                <input
                  id={id}
                  inputMode="decimal"
                  dir="ltr"
                  aria-describedby={describedBy}
                  className={inputClass}
                  value={editing.probabilityPercent}
                  onChange={(event) =>
                    setEditing({ ...editing, probabilityPercent: event.target.value })
                  }
                />
              )}
            </Field>
            <Field label={t('crm.opportunities.fields.closeDate')}>
              {(id) => (
                <input
                  id={id}
                  type="date"
                  className={inputClass}
                  value={editing.expectedCloseDate}
                  onChange={(event) =>
                    setEditing({ ...editing, expectedCloseDate: event.target.value })
                  }
                />
              )}
            </Field>
            <Field label={t('crm.opportunities.fields.owner')}>
              {(id) => (
                <select
                  id={id}
                  className={inputClass}
                  value={editing.ownerId}
                  onChange={(event) => setEditing({ ...editing, ownerId: event.target.value })}
                >
                  <option value="">{t('crm.leads.unassigned')}</option>
                  {(members.data ?? [])
                    .filter(
                      (member) => member.status === 'active' || member.userId === editing.ownerId,
                    )
                    .map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {member.displayName}
                      </option>
                    ))}
                </select>
              )}
            </Field>
            <Field label={t('crm.opportunities.fields.description')} className="sm:col-span-2">
              {(id) => (
                <textarea
                  id={id}
                  rows={4}
                  maxLength={10_000}
                  className={inputClass}
                  value={editing.description}
                  onChange={(event) => setEditing({ ...editing, description: event.target.value })}
                />
              )}
            </Field>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setEditing(null)}
            >
              {t('crm.leads.cancel')}
            </button>
            <button
              type="submit"
              className={buttonClass.primary}
              disabled={save.isPending || draftInvalid}
            >
              {save.isPending ? t('crm.leads.saving') : t('crm.leads.save')}
            </button>
          </div>
        </form>
      ) : (
        <section aria-labelledby="crm-opportunity-details" className={cardClass}>
          <h2 id="crm-opportunity-details" className="text-base font-semibold text-content">
            {t('crm.leads.details')}
          </h2>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Detail label={t('crm.opportunities.fields.customer')}>
              {item.customer === null ? null : (
                <Link to={paths.customer(item.customer.id)}>{item.customer.name}</Link>
              )}
            </Detail>
            <Detail label={t('crm.opportunities.fields.lead')}>
              {item.lead === null ? null : (
                <Link to={paths.crmLead(item.lead.id)}>{item.lead.displayName}</Link>
              )}
            </Detail>
            <Detail label={t('crm.opportunities.fields.amount')}>
              {item.amount === null ? null : formatAmount(item.amount, item.currencyCode, locale)}
            </Detail>
            <Detail label={t('crm.opportunities.fields.chance')}>
              {formatChance(item.probabilityBp, locale)}
            </Detail>
            <Detail label={t('crm.opportunities.fields.closeDate')}>
              {item.expectedCloseDate}
            </Detail>
            <Detail label={t('crm.opportunities.fields.owner')}>
              {memberName(members.data, item.ownerId)}
            </Detail>
            {item.status === 'lost' ? (
              <Detail label={t('crm.opportunities.fields.lostReason')}>{item.lostReason}</Detail>
            ) : null}
            <Detail label={t('crm.opportunities.fields.description')} wide>
              {item.description === null ? null : (
                <span className="whitespace-pre-wrap">{item.description}</span>
              )}
            </Detail>
          </dl>
          <p className="text-xs text-content-muted">{t('crm.opportunities.estimateNote')}</p>
        </section>
      )}

      <ActivityPanel links={{ opportunityIds: [item.id] }} canManage={canManageActivities} />

      <section aria-labelledby="crm-opportunity-history" className={cardClass}>
        <h2 id="crm-opportunity-history" className="text-lg font-semibold text-content">
          {t('crm.opportunities.history')}
        </h2>
        <ol className="flex flex-col gap-2 text-sm">
          {events.map((event, index) => (
            <li key={`${event.occurredAt}-${index}`} className="flex flex-col">
              <span className="text-content">
                {t(`crm.opportunityEvent.${event.kind}`, {
                  from: event.fromStage === null ? '' : stageName(event.fromStage),
                  to: event.toStage === null ? '' : stageName(event.toStage),
                })}
                {event.reason === null ? null : (
                  <span className="text-content-muted"> — {event.reason}</span>
                )}
              </span>
              <span className="text-xs text-content-muted">
                {[
                  memberName(members.data, event.actorId),
                  formatDateTime(event.occurredAt, { locale }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/** A link inside the app, followed without a page load. */
function Link({ to, children }: { to: string; children: ReactNode }) {
  const { navigate } = useOperations();
  return (
    <a
      href={to}
      className="text-accent underline-offset-4 hover:underline"
      onClick={(event) => {
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

function Detail({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className={`flex flex-col gap-0.5 ${wide ? 'sm:col-span-2' : ''}`}>
      <dt className="text-content-muted">{label}</dt>
      <dd className="break-words text-content">{children ?? t('crm.leads.none')}</dd>
    </div>
  );
}
