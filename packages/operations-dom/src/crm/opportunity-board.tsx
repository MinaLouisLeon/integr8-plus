import { useTranslation } from '@integr8/i18n';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { keys, type Opportunity, type Stage, useOperations } from '../api.js';
import { CsvExportButton } from '../exports.js';
import { BackLink, buttonClass, Failure, Field, inputClass, Loading, useRowMenu } from '../ui.js';
import { formatAmount, memberName, useMembers } from './lead-parts.js';
import {
  formatChance,
  MoveControl,
  NewOpportunityDialog,
  StageBadge,
  usePipelines,
  useStageName,
} from './opportunity-parts.js';

/**
 * Opportunities (CRM/ERP plan, phase C3): a board with a column for each open
 * stage, or a list with every opportunity. A card moves with a stage select —
 * keyboard-first, the accessible alternative to dragging — and losing asks why.
 * Amounts are estimates, not revenue.
 */

type View = 'board' | 'list';

interface Filters {
  q: string;
  /** `me`, `none` or '' for anyone. */
  ownerId: string;
  status: Opportunity['status'] | '';
}

const noFilters: Filters = { q: '', ownerId: '', status: '' };

export function OpportunityBoardScreen() {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const stageName = useStageName();
  const [view, setView] = useState<View>('board');
  const [filters, setFilters] = useState<Filters>(noFilters);
  const [applied, setApplied] = useState<Filters>(noFilters);
  const [creating, setCreating] = useState(false);
  const members = useMembers();
  const pipelines = usePipelines();
  const rowMenu = useRowMenu();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const manage = me.data?.permissions.includes('crm.opportunity.manage') ?? false;

  // The board shows open ones; the list whatever the status filter says.
  const status = view === 'board' ? 'open' : applied.status;
  const query = {
    ...(applied.q === '' ? {} : { q: applied.q }),
    ...(applied.ownerId === '' ? {} : { ownerId: applied.ownerId }),
    ...(status === '' ? {} : { status: [status] }),
  };
  const list = useInfiniteQuery({
    queryKey: keys.opportunities({ ...query, view }),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/crm/opportunities', {
          params: {
            query: {
              ...query,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
              limit: 100,
            },
          },
        })
      ).data!,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  const move = useMutation({
    mutationFn: async (input: { item: Opportunity; stageId: string; lostReason?: string }) =>
      (
        await client.POST('/v1/crm/opportunities/{opportunityId}/transitions', {
          params: { path: { opportunityId: input.item.id } },
          body: {
            expectedVersion: input.item.version,
            stageId: input.stageId,
            ...(input.lostReason === undefined ? {} : { lostReason: input.lostReason }),
          },
        })
      ).data!,
    onSettled: async () => {
      await queries.invalidateQueries({ queryKey: ['crm'] });
    },
  });

  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const pipeline = pipelines.data?.[0];
  const openStages = (pipeline?.stages ?? []).filter(
    (stage) => stage.outcome === 'open' && !stage.archived,
  );

  const card = (item: Opportunity, stages: readonly Stage[]) => {
    const owner = memberName(members.data, item.ownerId);
    return (
      <article
        key={item.id}
        className="flex flex-col gap-2 rounded-md border border-border-subtle bg-surface p-3 text-sm"
        onContextMenu={rowMenu({ kind: 'opportunity', id: item.id, label: item.title }, () => [
          {
            key: 'open',
            label: t('operations.rowActions.open'),
            onSelect: () => navigate(paths.crmOpportunity(item.id)),
          },
        ])}
      >
        <a
          href={paths.crmOpportunity(item.id)}
          className="font-medium break-words text-accent underline-offset-4 hover:underline"
          onClick={(event) => {
            event.preventDefault();
            navigate(paths.crmOpportunity(item.id));
          }}
        >
          {item.title}
        </a>
        <span className="text-content-muted">
          {[item.customer?.name ?? item.lead?.displayName, owner].filter(Boolean).join(' · ')}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          {item.amount === null ? null : (
            <span className="text-content tabular-nums">
              {formatAmount(item.amount, item.currencyCode, locale)}
            </span>
          )}
          <span className="text-xs text-content-muted">
            {formatChance(item.probabilityBp, locale)}
          </span>
          {item.expectedCloseDate === null ? null : (
            <span className="text-xs text-content-muted">
              {t('crm.opportunities.closes', { date: item.expectedCloseDate })}
            </span>
          )}
        </span>
        {manage ? (
          <MoveControl
            opportunity={item}
            stages={stages}
            disabled={move.isPending}
            label={t('crm.opportunities.moveTo')}
            onMove={(stageId, lostReason) =>
              move.mutate({ item, stageId, ...(lostReason === undefined ? {} : { lostReason }) })
            }
          />
        ) : null}
      </article>
    );
  };

  const filtered = JSON.stringify(applied) !== JSON.stringify(noFilters);

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink to={paths.crm} label={t('nav.backTo', { title: t('crm.overview.title') })} />
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-content">{t('crm.opportunities.title')}</h1>
          <p className="text-sm text-content-muted">{t('crm.opportunities.estimateNote')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div role="group" aria-label={t('crm.opportunities.view')} className="flex gap-1">
            {(['board', 'list'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                className={view === option ? buttonClass.primary : buttonClass.secondary}
                onClick={() => setView(option)}
              >
                {t(`crm.opportunities.${option}`)}
              </button>
            ))}
          </div>
          <a
            href={paths.crmPipelines}
            className={buttonClass.secondary}
            onClick={(event) => {
              event.preventDefault();
              navigate(paths.crmPipelines);
            }}
          >
            {t('crm.pipelines.title')}
          </a>
          {manage ? (
            <button type="button" className={buttonClass.primary} onClick={() => setCreating(true)}>
              {t('crm.opportunities.new')}
            </button>
          ) : null}
        </div>
      </header>
      <CsvExportButton
        permission="crm.opportunity.manage"
        label={t('crm.opportunities.export')}
        filename="opportunities.csv"
        className="items-end"
        request={() =>
          client.GET('/v1/crm/opportunities.csv', {
            params: {
              query: {
                // The board shows one pipeline's stages; the list, every pipeline.
                ...(view === 'board' && pipeline !== undefined ? { pipelineId: pipeline.id } : {}),
                ...(status === '' ? {} : { status: [status] }),
              },
            },
            parseAs: 'blob',
          })
        }
      />

      <form
        aria-label={t('crm.opportunities.filters')}
        className="grid gap-3 rounded-lg border border-border-subtle bg-surface p-4 sm:grid-cols-3 sm:items-end"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          setApplied(filters);
        }}
      >
        <Field label={t('crm.opportunities.search')}>
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
        <Field label={t('crm.opportunities.fields.owner')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={filters.ownerId}
              onChange={(event) => setFilters({ ...filters, ownerId: event.target.value })}
            >
              <option value="">{t('crm.leads.anyone')}</option>
              <option value="me">{t('crm.leads.me')}</option>
              <option value="none">{t('crm.leads.unassigned')}</option>
            </select>
          )}
        </Field>
        {view === 'list' ? (
          <Field label={t('crm.opportunities.fields.status')}>
            {(id) => (
              <select
                id={id}
                className={inputClass}
                value={filters.status}
                onChange={(event) =>
                  setFilters({ ...filters, status: event.target.value as Filters['status'] })
                }
              >
                <option value="">{t('crm.leads.anyStatus')}</option>
                {(['open', 'won', 'lost'] as const).map((value) => (
                  <option key={value} value={value}>
                    {t(`crm.opportunityStatus.${value}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        <div className="flex flex-wrap gap-2 sm:col-span-3">
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

      {move.isError ? <Failure error={move.error} /> : null}

      {list.isPending || pipelines.isPending ? (
        <Loading />
      ) : list.isError ? (
        <Failure error={list.error} onRetry={() => void list.refetch()} />
      ) : pipelines.isError ? (
        <Failure error={pipelines.error} onRetry={() => void pipelines.refetch()} />
      ) : view === 'board' ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {openStages.map((stage) => {
            const inStage = items.filter((item) => item.stage.id === stage.id);
            return (
              <section
                key={stage.id}
                aria-labelledby={`crm-stage-${stage.id}`}
                className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface-muted p-3"
              >
                <h2
                  id={`crm-stage-${stage.id}`}
                  className="flex items-center justify-between text-sm font-semibold text-content"
                >
                  <span>{stageName(stage)}</span>
                  <span className="text-xs font-normal text-content-muted">
                    {t('crm.opportunities.count', { count: inStage.length })}
                  </span>
                </h2>
                {inStage.length === 0 ? (
                  <p className="text-xs text-content-muted">{t('crm.opportunities.emptyStage')}</p>
                ) : (
                  inStage.map((item) => card(item, pipeline?.stages ?? []))
                )}
              </section>
            );
          })}
        </div>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {filtered ? t('crm.opportunities.empty') : t('crm.opportunities.emptyAll')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <a
                  href={paths.crmOpportunity(item.id)}
                  className="truncate font-medium text-accent underline-offset-4 hover:underline"
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(paths.crmOpportunity(item.id));
                  }}
                >
                  {item.title}
                </a>
                <span className="truncate text-sm text-content-muted">
                  {[
                    item.customer?.name ?? item.lead?.displayName,
                    memberName(members.data, item.ownerId),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {item.amount === null ? null : (
                  <span className="text-sm text-content tabular-nums">
                    {formatAmount(item.amount, item.currencyCode, locale)}
                  </span>
                )}
                <StageBadge stage={item.stage} status={item.status} />
              </div>
            </li>
          ))}
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

      {creating ? <NewOpportunityDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
