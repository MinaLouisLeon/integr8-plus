import { DEFAULT_PIPELINE_STAGES, hasFeature, LEAD_SOURCES } from '@integr8/core';
import { formatCalendarDate, formatDate, useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, type Pipeline, type StageValues, useOperations } from '../api.js';
import { formatAmount, memberName, useMembers } from '../crm/lead-parts.js';
import { usePipelines, useStageName } from '../crm/opportunity-parts.js';
import { BackLink, cardClass, Failure, Field, inputClass, Loading } from '../ui.js';
import {
  cellClass,
  DEFAULT_DAYS,
  FiguresTable,
  lastDays,
  numberCellClass,
  type Period,
  PeriodForm,
  shareOf,
  useCount,
  useDays,
} from './analytics-parts.js';

/**
 * The CRM's figures (eighth round; ADR-0012): how issued quotes turned out
 * and how long accepting took, the win rate and time to close of closed
 * opportunities, and what each stage held open at each month's end. Read-only
 * and worked out on request; each currency stays on its own.
 */
export function CrmReportsScreen() {
  const { t } = useTranslation();
  const { client, paths } = useOperations();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });

  const back = (
    <BackLink to={paths.crm} label={t('nav.backTo', { title: t('crm.overview.title') })} />
  );
  if (me.isPending) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Loading />
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Failure error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  const crm = hasFeature(me.data.features, 'crm');
  const sales = hasFeature(me.data.features, 'sales');
  const allowed = me.data.permissions.includes('crm.read');

  return (
    <div className="flex flex-col gap-6 text-start">
      {back}
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content">{t('analytics.crm.title')}</h1>
        <p className="max-w-prose text-sm text-content-muted">{t('analytics.crm.intro')}</p>
      </header>
      {!crm || !allowed ? (
        <p
          role="status"
          className="rounded-lg border border-border-subtle bg-surface-muted p-4 text-sm text-content"
        >
          {crm ? t('errors.forbidden') : t('crm.overview.notEnabled')}
        </p>
      ) : (
        <>
          {sales ? <QuoteFiguresSection /> : null}
          <PipelineFiguresSection />
          <StageValuesSection />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export function QuoteFiguresSection() {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const members = useMembers();
  const count = useCount();
  const days = useDays();
  const [period, setPeriod] = useState<Period>(() => lastDays(DEFAULT_DAYS));
  const figures = useQuery({
    queryKey: keys.analytics('quotes', period),
    queryFn: async () =>
      (await client.GET('/v1/analytics/quotes', { params: { query: period } })).data!.items,
  });
  // Overall first, then each person who issued quotes.
  const rows = [...(figures.data ?? [])].sort(
    (a, b) => Number(a.issuedBy !== null) - Number(b.issuedBy !== null),
  );

  return (
    <section aria-labelledby="analytics-quotes" className={cardClass}>
      <h2 id="analytics-quotes" className="text-lg font-semibold text-content">
        {t('analytics.quotes.title')}
      </h2>
      <p className="text-sm text-content-muted">{t('analytics.quotes.intro')}</p>
      <PeriodForm value={period} onApply={setPeriod} label={t('analytics.quotes.title')} />
      {figures.isPending ? (
        <Loading />
      ) : figures.isError ? (
        <Failure error={figures.error} onRetry={() => void figures.refetch()} />
      ) : rows.every((row) => row.issued === 0) ? (
        <p className="text-sm text-content-muted">{t('analytics.quotes.empty')}</p>
      ) : (
        <FiguresTable
          caption={t('analytics.quotes.title')}
          head={[
            { key: 'issuer', label: t('analytics.quotes.issuer') },
            { key: 'issued', label: t('analytics.quotes.issued'), numeric: true },
            { key: 'accepted', label: t('analytics.quotes.accepted'), numeric: true },
            { key: 'declined', label: t('analytics.quotes.declined'), numeric: true },
            { key: 'expired', label: t('analytics.quotes.expired'), numeric: true },
            { key: 'open', label: t('analytics.quotes.open'), numeric: true },
            { key: 'conversion', label: t('analytics.quotes.conversion'), numeric: true },
            { key: 'median', label: t('analytics.quotes.medianDays'), numeric: true },
          ]}
        >
          {rows.map((row) => (
            <tr
              key={row.issuedBy ?? 'overall'}
              className={row.issuedBy === null ? 'font-semibold' : ''}
            >
              <th scope="row" className={`${cellClass} text-start font-[inherit]`}>
                <span dir="auto">
                  {row.issuedBy === null
                    ? t('analytics.overall')
                    : (memberName(members.data, row.issuedBy) ?? t('analytics.formerMember'))}
                </span>
              </th>
              <td className={numberCellClass}>{count(row.issued)}</td>
              <td className={numberCellClass}>{count(row.accepted)}</td>
              <td className={numberCellClass}>{count(row.declined)}</td>
              <td className={numberCellClass}>{count(row.expired)}</td>
              <td className={numberCellClass}>{count(row.open)}</td>
              <td className={numberCellClass}>{shareOf(row.accepted, row.issued, locale)}</td>
              <td className={numberCellClass}>{days(row.medianDaysToAccept)}</td>
            </tr>
          ))}
        </FiguresTable>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Win rate
// ---------------------------------------------------------------------------

type GroupBy = 'source' | 'owner' | 'stage';
const GROUPS: readonly GroupBy[] = ['source', 'owner', 'stage'];
const SOURCES = new Set<string>(LEAD_SOURCES);
const BUILT_IN_STAGES = new Set<string>(DEFAULT_PIPELINE_STAGES.map((stage) => stage.key));

/** A stage by its key: translated for the standard ones, the company's label for its own. */
function useStageByKey(pipelines: readonly Pipeline[] | undefined): (key: string) => string {
  const stageName = useStageName();
  return (key) => {
    if (BUILT_IN_STAGES.has(key)) {
      return stageName({ key, label: key });
    }
    for (const pipeline of pipelines ?? []) {
      const found = pipeline.stages.find((stage) => stage.key === key);
      if (found !== undefined) {
        return stageName(found);
      }
    }
    return key;
  };
}

export function PipelineFiguresSection() {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const members = useMembers();
  const pipelines = usePipelines();
  const count = useCount();
  const days = useDays();
  const stageByKey = useStageByKey(pipelines.data);
  const [query, setQuery] = useState<Period & { groupBy: GroupBy }>(() => ({
    ...lastDays(DEFAULT_DAYS),
    groupBy: 'source',
  }));
  const [groupBy, setGroupBy] = useState<GroupBy>(query.groupBy);
  const figures = useQuery({
    queryKey: keys.analytics('pipeline', query),
    queryFn: async () => (await client.GET('/v1/analytics/pipeline', { params: { query } })).data!,
  });

  const groupName = (group: string | null): string => {
    if (group === null) {
      return t('analytics.overall');
    }
    switch (figures.data?.groupBy) {
      case 'source':
        return group === 'none'
          ? t('analytics.pipeline.noSource')
          : SOURCES.has(group)
            ? t(`crm.source.${group as (typeof LEAD_SOURCES)[number]}`)
            : group;
      case 'owner':
        return group === 'none'
          ? t('analytics.pipeline.noOwner')
          : (memberName(members.data, group) ?? t('analytics.formerMember'));
      default:
        return group === 'none' ? t('analytics.pipeline.noStage') : stageByKey(group);
    }
  };
  const rows = [...(figures.data?.items ?? [])].sort(
    (a, b) => Number(a.group !== null) - Number(b.group !== null),
  );

  return (
    <section aria-labelledby="analytics-pipeline" className={cardClass}>
      <h2 id="analytics-pipeline" className="text-lg font-semibold text-content">
        {t('analytics.pipeline.title')}
      </h2>
      <p className="text-sm text-content-muted">{t('analytics.pipeline.intro')}</p>
      <PeriodForm
        value={query}
        onApply={(period) => setQuery({ ...period, groupBy })}
        label={t('analytics.pipeline.title')}
      >
        <Field label={t('analytics.groupBy')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={groupBy}
              onChange={(event) => setGroupBy(event.target.value as GroupBy)}
            >
              {GROUPS.map((value) => (
                <option key={value} value={value}>
                  {t(`analytics.pipeline.groups.${value}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </PeriodForm>
      {figures.isPending ? (
        <Loading />
      ) : figures.isError ? (
        <Failure error={figures.error} onRetry={() => void figures.refetch()} />
      ) : rows.every((row) => row.won + row.lost === 0) ? (
        <p className="text-sm text-content-muted">{t('analytics.pipeline.empty')}</p>
      ) : (
        <FiguresTable
          caption={t('analytics.pipeline.title')}
          head={[
            { key: 'group', label: t(`analytics.pipeline.groups.${figures.data.groupBy}`) },
            { key: 'won', label: t('analytics.pipeline.won'), numeric: true },
            { key: 'lost', label: t('analytics.pipeline.lost'), numeric: true },
            { key: 'rate', label: t('analytics.pipeline.winRate'), numeric: true },
            { key: 'median', label: t('analytics.pipeline.medianDays'), numeric: true },
          ]}
        >
          {rows.map((row) => (
            <tr key={row.group ?? 'overall'} className={row.group === null ? 'font-semibold' : ''}>
              <th scope="row" className={`${cellClass} text-start font-[inherit]`}>
                <span dir="auto">{groupName(row.group)}</span>
              </th>
              <td className={numberCellClass}>{count(row.won)}</td>
              <td className={numberCellClass}>{count(row.lost)}</td>
              <td className={numberCellClass}>{shareOf(row.won, row.won + row.lost, locale)}</td>
              <td className={numberCellClass}>{days(row.medianDaysToClose)}</td>
            </tr>
          ))}
        </FiguresTable>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Value by stage at each month's end
// ---------------------------------------------------------------------------

const MONTH_CHOICES = [3, 6, 12, 24] as const;

export function StageValuesSection() {
  const { t } = useTranslation();
  const { client } = useOperations();
  const pipelines = usePipelines();
  const [chosen, setChosen] = useState('');
  const [months, setMonths] = useState<number>(6);
  const [weighted, setWeighted] = useState(false);
  const pipeline =
    pipelines.data?.find((candidate) => candidate.id === chosen) ?? pipelines.data?.[0];
  const values = useQuery({
    queryKey: keys.analytics('stage-values', { pipelineId: pipeline?.id, months }),
    queryFn: async () =>
      (
        await client.GET('/v1/analytics/pipelines/{pipelineId}/stage-values', {
          params: { path: { pipelineId: pipeline!.id }, query: { months } },
        })
      ).data!,
    enabled: pipeline !== undefined,
  });

  return (
    <section aria-labelledby="analytics-stage-values" className={cardClass}>
      <h2 id="analytics-stage-values" className="text-lg font-semibold text-content">
        {t('analytics.stageValues.title')}
      </h2>
      <p className="text-sm text-content-muted">{t('analytics.stageValues.intro')}</p>
      {pipelines.isPending ? (
        <Loading />
      ) : pipelines.isError ? (
        <Failure error={pipelines.error} onRetry={() => void pipelines.refetch()} />
      ) : pipeline === undefined ? (
        <p className="text-sm text-content-muted">{t('crm.pipelines.empty')}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            {pipelines.data.length > 1 ? (
              <Field label={t('analytics.stageValues.pipeline')}>
                {(id) => (
                  <select
                    id={id}
                    className={inputClass}
                    value={pipeline.id}
                    onChange={(event) => setChosen(event.target.value)}
                  >
                    {pipelines.data.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}
            <Field label={t('analytics.stageValues.months')}>
              {(id) => (
                <select
                  id={id}
                  className={inputClass}
                  value={months}
                  onChange={(event) => setMonths(Number(event.target.value))}
                >
                  {MONTH_CHOICES.map((value) => (
                    <option key={value} value={value}>
                      {t('analytics.stageValues.lastMonths', { count: value })}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <label className="flex items-center gap-2 pb-2 text-sm text-content">
              <input
                type="checkbox"
                checked={weighted}
                onChange={(event) => setWeighted(event.target.checked)}
              />
              {t('analytics.stageValues.weighted')}
            </label>
          </div>
          {values.isPending ? (
            <Loading />
          ) : values.isError ? (
            <Failure error={values.error} onRetry={() => void values.refetch()} />
          ) : values.data.items.length === 0 ? (
            <p className="text-sm text-content-muted">{t('analytics.stageValues.empty')}</p>
          ) : (
            <StageValuesFigures pipeline={pipeline} values={values.data} weighted={weighted} />
          )}
        </>
      )}
    </section>
  );
}

/**
 * The day amounts began to be kept (ADR-0013), in the company's calendar, when
 * any figure shown counts a deal at the amount it had then rather than at the
 * month end; null when every figure is from the history.
 */
function useAmountsRecordedFrom(values: StageValues): string | null {
  const { client, locale } = useOperations();
  const from = values.amountsRecordedFrom;
  const needed = from !== null && values.items.some((item) => item.estimated > 0);
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: async () => (await client.GET('/v1/settings')).data!,
    enabled: needed,
  });
  if (!needed || from === null) {
    return null;
  }
  // The company's day when its settings are to hand; the UTC day otherwise.
  const timeZone = settings.data?.timezone;
  return timeZone === undefined
    ? formatCalendarDate(from, { locale })
    : formatDate(from, { locale, timeZone });
}

/** The table, and above it what the figures before amounts were kept stand for. */
function StageValuesFigures({
  pipeline,
  values,
  weighted,
}: {
  pipeline: Pipeline;
  values: StageValues;
  weighted: boolean;
}) {
  const { t } = useTranslation();
  const recordedFrom = useAmountsRecordedFrom(values);
  return (
    <>
      {recordedFrom === null ? null : (
        <p className="text-sm text-content-muted">
          {t('analytics.stageValues.historyNote', { date: recordedFrom })}
        </p>
      )}
      <StageValuesTable
        pipeline={pipeline}
        values={values}
        weighted={weighted}
        recordedFrom={recordedFrom}
      />
    </>
  );
}

function StageValuesTable({
  pipeline,
  values,
  weighted,
  recordedFrom,
}: {
  pipeline: Pipeline;
  values: StageValues;
  weighted: boolean;
  /** When some figures count deals at the amount they had then; null otherwise. */
  recordedFrom: string | null;
}) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const stageName = useStageName();
  // Every stage that held something, in the pipeline's order; archived ones keep their place.
  const held = new Set(values.items.map((item) => item.stageId));
  const stages = [...pipeline.stages]
    .filter((stage) => held.has(stage.id))
    .sort((a, b) => a.position - b.position);
  const last = values.monthEnds.length - 1;
  const estimated =
    recordedFrom === null ? '' : t('analytics.stageValues.estimatedDetail', { date: recordedFrom });

  return (
    <FiguresTable
      caption={t('analytics.stageValues.title')}
      head={[
        { key: 'stage', label: t('analytics.stageValues.stage') },
        ...values.monthEnds.map((monthEnd, index) => ({
          key: monthEnd,
          label:
            index === last
              ? t('analytics.stageValues.today')
              : formatCalendarDate(monthEnd, { locale }),
          numeric: true,
        })),
      ]}
    >
      {stages.map((stage) => (
        <tr key={stage.id}>
          <th scope="row" className={`${cellClass} text-start font-medium text-content`}>
            <span dir="auto">{stageName(stage)}</span>
          </th>
          {values.monthEnds.map((monthEnd) => {
            const cells = values.items.filter(
              (item) => item.stageId === stage.id && item.monthEnd === monthEnd,
            );
            return (
              <td key={monthEnd} className={`${numberCellClass} align-top`}>
                {cells.length === 0 ? (
                  <span className="text-content-muted">—</span>
                ) : (
                  cells.map((cell) => (
                    <span key={cell.currency} className="block whitespace-nowrap">
                      {formatAmount(weighted ? cell.weighted : cell.amount, cell.currency, locale)}
                      <span className="block text-xs text-content-muted">
                        {t('analytics.stageValues.count', { count: cell.count })}
                      </span>
                      {recordedFrom !== null && cell.estimated > 0 ? (
                        <span className="block text-xs text-content-muted" title={estimated}>
                          {t('analytics.stageValues.estimated')}
                          <span className="sr-only">{` ${estimated}`}</span>
                        </span>
                      ) : null}
                    </span>
                  ))
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </FiguresTable>
  );
}
