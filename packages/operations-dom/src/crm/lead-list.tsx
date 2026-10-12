import { LEAD_SOURCES, LEAD_STATUSES } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { keys, type LeadSource, type LeadStatus, useOperations } from '../api.js';
import { CsvExportButton } from '../exports.js';
import {
  BackLink,
  buttonClass,
  Dialog,
  Failure,
  Field,
  InlineError,
  inputClass,
  Loading,
  useRowMenu,
} from '../ui.js';
import {
  emptyLead,
  formatAmount,
  LeadFields,
  LeadStatusBadge,
  memberName,
  toLeadBody,
  type LeadDraft,
  useMembers,
} from './lead-parts.js';

interface Filters {
  q: string;
  status: LeadStatus | '';
  source: LeadSource | '';
  /** A member id, `me`, `none`, or '' for anyone. */
  assignedTo: string;
  includeArchived: boolean;
}

const noFilters: Filters = {
  q: '',
  status: '',
  source: '',
  assignedTo: '',
  includeArchived: false,
};

/** Leads, newest first: found by any word of their details, a status, a source or an assignee. */
export function LeadListScreen() {
  const { t } = useTranslation();
  const { client, navigate, paths, locale } = useOperations();
  const [filters, setFilters] = useState<Filters>(noFilters);
  const [applied, setApplied] = useState<Filters>(noFilters);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<LeadDraft>(emptyLead);

  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const members = useMembers();

  const query = {
    ...(applied.q === '' ? {} : { q: applied.q }),
    ...(applied.status === '' ? {} : { status: [applied.status] }),
    ...(applied.source === '' ? {} : { source: [applied.source] }),
    ...(applied.assignedTo === '' ? {} : { assignedTo: applied.assignedTo }),
    ...(applied.includeArchived ? { includeArchived: 'true' as const } : {}),
  };
  const list = useInfiniteQuery({
    queryKey: keys.leads(query),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/crm/leads', {
          params: {
            query: {
              ...query,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
              limit: 50,
            },
          },
        })
      ).data!,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const create = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/crm/leads', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: toLeadBody(draft),
        })
      ).data!,
    onSuccess: (lead) => navigate(paths.crmLead(lead.id)),
  });

  const manage = me.data?.permissions.includes('crm.lead.manage') ?? false;
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const rowMenu = useRowMenu();
  const filtered = JSON.stringify(applied) !== JSON.stringify(noFilters);

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink to={paths.crm} label={t('nav.backTo', { title: t('crm.overview.title') })} />
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-content">{t('crm.leads.title')}</h1>
        <div className="flex flex-wrap items-start gap-2">
          <CsvExportButton
            permission="crm.lead.manage"
            label={t('crm.leads.export')}
            filename="leads.csv"
            request={() =>
              client.GET('/v1/crm/leads.csv', {
                params: {
                  query: {
                    ...(applied.status === '' ? {} : { status: [applied.status] }),
                    ...(applied.source === '' ? {} : { source: [applied.source] }),
                    ...(applied.includeArchived ? { includeArchived: 'true' as const } : {}),
                  },
                },
                parseAs: 'blob',
              })
            }
          />
          {manage ? (
            <button
              type="button"
              className={buttonClass.primary}
              onClick={() => {
                create.reset();
                setDraft(emptyLead);
                setCreating(true);
              }}
            >
              {t('crm.leads.new')}
            </button>
          ) : null}
        </div>
      </header>

      <form
        aria-label={t('crm.leads.filters')}
        className="grid gap-3 rounded-lg border border-border-subtle bg-surface p-4 sm:grid-cols-4 sm:items-end"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          setApplied(filters);
        }}
      >
        <Field label={t('crm.leads.search')} className="sm:col-span-4">
          {(id) => (
            <input
              id={id}
              type="search"
              className={inputClass}
              value={filters.q}
              onChange={(event) => setFilters({ ...filters, q: event.target.value })}
            />
          )}
        </Field>
        <Field label={t('crm.leads.fields.status')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={filters.status}
              onChange={(event) =>
                setFilters({ ...filters, status: event.target.value as LeadStatus | '' })
              }
            >
              <option value="">{t('crm.leads.anyStatus')}</option>
              {LEAD_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`crm.status.${status}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('crm.leads.fields.source')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={filters.source}
              onChange={(event) =>
                setFilters({ ...filters, source: event.target.value as LeadSource | '' })
              }
            >
              <option value="">{t('crm.leads.anySource')}</option>
              {LEAD_SOURCES.map((source) => (
                <option key={source} value={source}>
                  {t(`crm.source.${source}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('crm.leads.fields.assignee')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={filters.assignedTo}
              onChange={(event) => setFilters({ ...filters, assignedTo: event.target.value })}
            >
              <option value="">{t('crm.leads.anyone')}</option>
              <option value="me">{t('crm.leads.me')}</option>
              <option value="none">{t('crm.leads.unassigned')}</option>
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
        <label className="flex items-center gap-2 text-sm text-content">
          <input
            type="checkbox"
            checked={filters.includeArchived}
            onChange={(event) => setFilters({ ...filters, includeArchived: event.target.checked })}
          />
          {t('crm.leads.includeArchived')}
        </label>
        {me.isError || members.isError ? (
          <div className="sm:col-span-4">
            <InlineError
              onRetry={() => {
                if (me.isError) {
                  void me.refetch();
                }
                if (members.isError) {
                  void members.refetch();
                }
              }}
            />
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2 sm:col-span-4">
          <button type="submit" className={buttonClass.primary}>
            {t('crm.leads.apply')}
          </button>
          {filtered ? (
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => {
                setFilters(noFilters);
                setApplied(noFilters);
              }}
            >
              {t('crm.leads.clear')}
            </button>
          ) : null}
        </div>
      </form>

      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <Failure error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {filtered ? t('crm.leads.empty') : t('crm.leads.emptyAll')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
          {items.map((lead) => {
            const assignee = memberName(members.data, lead.assignedTo);
            return (
              <li
                key={lead.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                onContextMenu={rowMenu(
                  { kind: 'lead', id: lead.id, label: lead.displayName },
                  () => [
                    {
                      key: 'open',
                      label: t('operations.rowActions.open'),
                      onSelect: () => navigate(paths.crmLead(lead.id)),
                    },
                  ],
                )}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <a
                    href={paths.crmLead(lead.id)}
                    className="truncate font-medium text-accent underline-offset-4 hover:underline"
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(paths.crmLead(lead.id));
                    }}
                  >
                    {lead.displayName}
                  </a>
                  <span className="truncate text-sm text-content-muted">
                    {[lead.companyName, t(`crm.source.${lead.source}`), assignee]
                      .filter((part) => part !== null && part !== '')
                      .join(' · ')}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {lead.estimatedValue === null ? null : (
                    <span className="text-sm text-content tabular-nums">
                      {formatAmount(lead.estimatedValue, lead.currencyCode, locale)}
                    </span>
                  )}
                  {lead.archivedAt === null ? null : (
                    <span className="text-xs text-content-muted">{t('crm.leads.archived')}</span>
                  )}
                  <LeadStatusBadge status={lead.status} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {list.hasNextPage ? (
        <button
          type="button"
          className={`${buttonClass.secondary} self-center`}
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('crm.leads.loadMore')}
        </button>
      ) : null}

      {creating ? (
        <Dialog
          title={t('crm.leads.new')}
          wide
          onClose={() => setCreating(false)}
          footer={
            <>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setCreating(false)}
              >
                {t('crm.leads.cancel')}
              </button>
              <button
                type="submit"
                form="crm-new-lead"
                className={buttonClass.primary}
                disabled={create.isPending || draft.displayName.trim() === ''}
              >
                {create.isPending ? t('crm.leads.creating') : t('crm.leads.create')}
              </button>
            </>
          }
        >
          <form
            id="crm-new-lead"
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <LeadFields draft={draft} onChange={setDraft} members={members.data ?? []} />
            {create.isError ? <Failure error={create.error} /> : null}
          </form>
        </Dialog>
      ) : null}
    </div>
  );
}
