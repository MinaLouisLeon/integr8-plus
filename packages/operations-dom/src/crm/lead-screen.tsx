import { ApiRequestError } from '@integr8/api-client';
import { OPEN_LEAD_STATUSES } from '@integr8/core';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { keys, type LeadDetail, useOperations } from '../api.js';
import {
  BackLink,
  buttonClass,
  cardClass,
  Failure,
  Field,
  inputClass,
  Loading,
  usePermissions,
} from '../ui.js';
import { ActivityPanel } from './activities.js';
import {
  changedLeadFields,
  formatAmount,
  LeadFields,
  leadDraft,
  LeadStatusBadge,
  memberName,
  type LeadDraft,
  useMembers,
} from './lead-parts.js';
import { NewOpportunityDialog, StageBadge } from './opportunity-parts.js';

/** True when the server refused because somebody else changed the record first. */
function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === 'version_conflict';
}

/**
 * One lead: its details, who has it, where it came from, and — for those who
 * may — editing, a quick status change and archiving (CRM/ERP plan, phase C1).
 */
export function LeadScreen({ leadId }: { leadId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const [editing, setEditing] = useState<LeadDraft | null>(null);
  const [opening, setOpening] = useState(false);
  const permissions = usePermissions();

  const detail = useQuery({
    queryKey: keys.lead(leadId),
    queryFn: async () =>
      (await client.GET('/v1/crm/leads/{leadId}', { params: { path: { leadId } } })).data!,
  });
  const members = useMembers();
  const opportunities = useQuery({
    queryKey: keys.opportunities({ leadId }),
    queryFn: async () =>
      (await client.GET('/v1/crm/opportunities', { params: { query: { leadId, limit: 20 } } }))
        .data!.items,
  });

  const refresh = async (next?: LeadDetail['lead']) => {
    if (next !== undefined) {
      queries.setQueryData<LeadDetail>(keys.lead(leadId), (current) =>
        current === undefined ? current : { ...current, lead: next },
      );
    }
    await queries.invalidateQueries({ queryKey: ['crm', 'leads'] });
    await queries.invalidateQueries({ queryKey: keys.lead(leadId) });
  };

  const save = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      (
        await client.PATCH('/v1/crm/leads/{leadId}', {
          params: { path: { leadId } },
          body: { expectedVersion: detail.data!.lead.version, ...body },
        })
      ).data!,
    onSuccess: async (lead) => {
      setEditing(null);
      await refresh(lead);
    },
  });

  if (detail.isPending) {
    return <Loading />;
  }
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        <BackLink to={paths.crmLeads} label={t('crm.leads.back')} />
        <Failure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { lead, can } = detail.data;
  const converted = lead.status === 'converted';
  const editable = can.edit && !converted;
  const assignee = memberName(members.data, lead.assignedTo);

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink to={paths.crmLeads} label={t('crm.leads.back')} />

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="text-2xl font-semibold break-words text-content">{lead.displayName}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <LeadStatusBadge status={lead.status} />
            {lead.archivedAt === null ? null : (
              <span className="text-xs text-content-muted">{t('crm.leads.archived')}</span>
            )}
          </div>
        </div>
        {(can.edit || can.convert) && editing === null ? (
          <div className="flex flex-wrap gap-2">
            {can.convert ? (
              <button
                type="button"
                className={buttonClass.primary}
                onClick={() => navigate(paths.crmLeadConvert(lead.id))}
              >
                {t('crm.leads.convert')}
              </button>
            ) : null}
            {editable ? (
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => {
                  save.reset();
                  setEditing(leadDraft(lead));
                }}
              >
                {t('crm.leads.edit')}
              </button>
            ) : null}
            {can.edit ? (
              <button
                type="button"
                className={buttonClass.secondary}
                disabled={save.isPending}
                onClick={() => save.mutate({ archived: lead.archivedAt === null })}
              >
                {lead.archivedAt === null ? t('crm.leads.archive') : t('crm.leads.restore')}
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {converted && lead.convertedCustomerId !== null ? (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-success bg-success-subtle p-4 text-sm text-content"
        >
          <span>{t('crm.leads.convertedNotice')}</span>
          <a
            href={paths.customer(lead.convertedCustomerId)}
            className="font-medium text-accent underline-offset-4 hover:underline"
            onClick={(event) => {
              event.preventDefault();
              navigate(paths.customer(lead.convertedCustomerId!));
            }}
          >
            {t('crm.leads.openCustomer')}
          </a>
        </p>
      ) : null}

      {save.isError ? (
        isVersionConflict(save.error) ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-danger bg-danger-subtle p-4 text-sm text-content"
          >
            <span>{t('crm.leads.versionConflict')}</span>
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => {
                save.reset();
                setEditing(null);
                void refresh();
              }}
            >
              {t('crm.leads.reload')}
            </button>
          </div>
        ) : (
          <Failure error={save.error} />
        )
      ) : null}

      {editing !== null ? (
        <form
          aria-label={t('crm.leads.edit')}
          className={cardClass}
          onSubmit={(event) => {
            event.preventDefault();
            const changes = changedLeadFields(leadDraft(lead), editing);
            if (Object.keys(changes).length === 0) {
              setEditing(null);
              return;
            }
            save.mutate(changes);
          }}
        >
          <LeadFields draft={editing} onChange={setEditing} members={members.data ?? []} />
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
              disabled={save.isPending || editing.displayName.trim() === ''}
            >
              {save.isPending ? t('crm.leads.saving') : t('crm.leads.save')}
            </button>
          </div>
        </form>
      ) : (
        <section aria-labelledby="crm-lead-details" className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="crm-lead-details" className="text-base font-semibold text-content">
              {t('crm.leads.details')}
            </h2>
            {editable ? (
              <Field label={t('crm.leads.changeStatus')} className="w-48">
                {(id) => (
                  <select
                    id={id}
                    className={inputClass}
                    value={lead.status}
                    disabled={save.isPending}
                    onChange={(event) => save.mutate({ status: event.target.value })}
                  >
                    {OPEN_LEAD_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {t(`crm.status.${status}`)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}
          </div>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Detail label={t('crm.leads.fields.company')}>{lead.companyName}</Detail>
            <Detail label={t('crm.leads.fields.email')}>
              {lead.email === null ? null : (
                <a dir="ltr" href={`mailto:${lead.email}`} className="text-accent hover:underline">
                  {lead.email}
                </a>
              )}
            </Detail>
            <Detail label={t('crm.leads.fields.phone')}>
              {lead.phone === null ? null : (
                <a dir="ltr" href={`tel:${lead.phone}`} className="text-accent hover:underline">
                  {lead.phone}
                </a>
              )}
            </Detail>
            <Detail label={t('crm.leads.fields.source')}>{t(`crm.source.${lead.source}`)}</Detail>
            <Detail label={t('crm.leads.fields.assignee')}>
              {assignee ?? (lead.assignedTo === null ? t('crm.leads.unassigned') : null)}
            </Detail>
            <Detail label={t('crm.leads.fields.value')}>
              {lead.estimatedValue === null
                ? null
                : formatAmount(lead.estimatedValue, lead.currencyCode, locale)}
            </Detail>
            {lead.status === 'unqualified' ? (
              <Detail label={t('crm.leads.fields.unqualifiedReason')}>
                {lead.unqualifiedReason}
              </Detail>
            ) : null}
            <Detail label={t('crm.leads.created')}>
              {formatDateTime(lead.createdAt, { locale })}
            </Detail>
            <Detail label={t('crm.leads.fields.notes')} wide>
              {lead.notes === null ? null : (
                <span className="whitespace-pre-wrap">{lead.notes}</span>
              )}
            </Detail>
          </dl>
        </section>
      )}

      <section aria-labelledby="crm-lead-opportunities" className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="crm-lead-opportunities" className="text-lg font-semibold text-content">
            {t('crm.opportunities.title')}
          </h2>
          {permissions.includes('crm.opportunity.manage') && lead.archivedAt === null ? (
            <button type="button" className={buttonClass.ghost} onClick={() => setOpening(true)}>
              {t('crm.opportunities.new')}
            </button>
          ) : null}
        </div>
        {opportunities.isPending ? null : opportunities.isError ? (
          <Failure error={opportunities.error} onRetry={() => void opportunities.refetch()} />
        ) : opportunities.data.length === 0 ? (
          <p className="text-sm text-content-muted">{t('crm.leads.noOpportunities')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle text-sm">
            {opportunities.data.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <a
                  href={paths.crmOpportunity(item.id)}
                  className="text-accent underline-offset-4 hover:underline"
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(paths.crmOpportunity(item.id));
                  }}
                >
                  {item.title}
                </a>
                <span className="flex items-center gap-2 text-xs text-content-muted">
                  {item.amount === null
                    ? null
                    : formatAmount(item.amount, item.currencyCode, locale)}
                  <StageBadge stage={item.stage} status={item.status} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ActivityPanel
        links={{ leadIds: [lead.id] }}
        canManage={permissions.includes('crm.activity.manage')}
      />

      {opening ? (
        <NewOpportunityDialog
          lead={lead}
          {...(lead.convertedCustomerId === null
            ? {}
            : {
                customer: {
                  id: lead.convertedCustomerId,
                  name: lead.companyName ?? lead.displayName,
                },
              })}
          onClose={() => setOpening(false)}
        />
      ) : null}
    </div>
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
