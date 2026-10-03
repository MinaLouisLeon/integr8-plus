import {
  compileDefinition,
  type Field,
  type FormDefinition,
  reportableFields,
  type ReportableType,
} from '@integr8/form-engine';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useId, useState, type FormEvent as SubmitEvent } from 'react';
import { say } from '../text.js';
import { buttonClass, inputClass } from '../widgets/types.js';
import { keys, type Me, useScreens } from './api.js';
import { Failure, Loading } from './parts.js';

/**
 * Finding submissions: by form, status, person, date, words in the answers,
 * and any reportable answer — "Result is Fail", "Pressure is more than 4".
 *
 * Answer filters are offered only once a form is chosen, and only for the
 * questions its latest version made reportable, each with the comparisons its
 * kind of value allows and a value picked the way the question is answered.
 */

type Operator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains';

const OPERATORS: Record<ReportableType, readonly Operator[]> = {
  text: ['eq', 'ne', 'contains'],
  number: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'],
  date: ['eq', 'lt', 'lte', 'gt', 'gte'],
  time: ['eq', 'lt', 'lte', 'gt', 'gte'],
  datetime: ['lt', 'lte', 'gt', 'gte'],
  boolean: ['eq'],
};

interface AnswerFilter {
  field: string;
  operator: Operator;
  value: string;
}

interface Filters {
  formId: string;
  /** Filled for a job, for a job at a site, or for a job for a customer (P10). */
  workOrderId: string;
  siteId: string;
  customerId: string;
  status: '' | 'submitted' | 'reopened';
  mine: boolean;
  from: string;
  to: string;
  q: string;
  answers: AnswerFilter[];
}

const EMPTY: Filters = {
  formId: '',
  workOrderId: '',
  siteId: '',
  customerId: '',
  status: '',
  mine: false,
  from: '',
  to: '',
  q: '',
  answers: [],
};

export function SubmissionListScreen({
  initialFilters = {},
}: {
  /** Where the list is opened from: a job's "all submissions" link names the job. */
  initialFilters?: Partial<Pick<Filters, 'formId' | 'workOrderId' | 'siteId' | 'customerId'>>;
} = {}) {
  const { t } = useTranslation();
  const { client, locale, navigate, paths, download } = useScreens();
  const [draft, setDraft] = useState<Filters>({ ...EMPTY, ...initialFilters });
  const [applied, setApplied] = useState<Filters>({ ...EMPTY, ...initialFilters });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(undefined);

  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const forms = useQuery({
    queryKey: keys.forms,
    queryFn: async () => (await client.GET('/v1/forms')).data!.items,
  });
  const form = useQuery({
    queryKey: keys.form(draft.formId),
    queryFn: async () =>
      (await client.GET('/v1/forms/{formId}', { params: { path: { formId: draft.formId } } }))
        .data!,
    enabled: draft.formId !== '',
  });

  const customers = useQuery({
    queryKey: ['customers', 'list', { limit: 200 }],
    queryFn: async () =>
      (await client.GET('/v1/customers', { params: { query: { limit: 200 } } })).data!.items,
  });
  const sites = useQuery({
    queryKey: ['sites', 'list', draft.customerId],
    queryFn: async () =>
      (
        await client.GET('/v1/sites', {
          params: { query: { customerId: draft.customerId, limit: 200 } },
        })
      ).data!.items,
    enabled: draft.customerId !== '',
  });

  const questions = reportableQuestions(form.data?.live?.definition as FormDefinition | undefined);

  const query = toQuery(applied);
  const list = useInfiniteQuery({
    queryKey: keys.list(query),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/submissions', {
          params: {
            query: { ...query, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
          },
        })
      ).data!,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  const apply = (event: SubmitEvent) => {
    event.preventDefault();
    setApplied(draft);
  };

  const exportCsv = async () => {
    if (applied.formId === '') {
      return;
    }
    setExporting(true);
    setExportError(undefined);
    try {
      const { data } = await client.GET('/v1/submissions/export', {
        params: { query: { ...query, formId: applied.formId } },
        parseAs: 'blob',
      });
      const title =
        forms.data?.find((candidate) => candidate.id === applied.formId)?.title ?? 'submissions';
      download(data as unknown as Blob, `${title.replace(/[^\w.-]+/gu, '-')}.csv`);
    } catch (error) {
      setExportError(error);
    } finally {
      setExporting(false);
    }
  };

  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const readsAll =
    (me.data as Me | undefined)?.permissions.includes('submission.read_all') ?? false;

  return (
    <div className="flex flex-col gap-6 text-start">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl font-semibold text-content">{t('submissions.list.title')}</h1>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={applied.formId === '' || exporting}
            aria-busy={exporting}
            aria-describedby={applied.formId === '' ? 'export-hint' : undefined}
            onClick={() => void exportCsv()}
          >
            {t('submissions.list.export')}
          </button>
          {applied.formId === '' ? (
            <span id="export-hint" className="text-xs text-content-muted">
              {t('submissions.list.exportNeedsForm')}
            </span>
          ) : null}
        </div>
      </header>

      {exportError === undefined ? null : <Failure error={exportError} />}

      <form
        onSubmit={apply}
        className="flex flex-col gap-4 rounded-lg border border-border-subtle bg-surface p-4"
        aria-label={t('submissions.list.title')}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Labelled label={t('submissions.list.form')}>
            {(id) => (
              <select
                id={id}
                value={draft.formId}
                onChange={(event) =>
                  setDraft({ ...draft, formId: event.target.value, answers: [] })
                }
                className={inputClass}
              >
                <option value="">{t('submissions.list.anyForm')}</option>
                {forms.data?.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.title}
                  </option>
                ))}
              </select>
            )}
          </Labelled>
          <Labelled label={t('submissions.list.status')}>
            {(id) => (
              <select
                id={id}
                value={draft.status}
                onChange={(event) =>
                  setDraft({ ...draft, status: event.target.value as Filters['status'] })
                }
                className={inputClass}
              >
                <option value="">
                  {`${t('submissions.status.submitted')} / ${t('submissions.status.reopened')}`}
                </option>
                <option value="submitted">{t('submissions.status.submitted')}</option>
                <option value="reopened">{t('submissions.status.reopened')}</option>
              </select>
            )}
          </Labelled>
          <Labelled label={t('submissions.list.from')}>
            {(id) => (
              <input
                id={id}
                type="date"
                value={draft.from}
                onChange={(event) => setDraft({ ...draft, from: event.target.value })}
                className={inputClass}
              />
            )}
          </Labelled>
          <Labelled label={t('submissions.list.to')}>
            {(id) => (
              <input
                id={id}
                type="date"
                value={draft.to}
                onChange={(event) => setDraft({ ...draft, to: event.target.value })}
                className={inputClass}
              />
            )}
          </Labelled>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Labelled label={t('submissions.list.customer')}>
            {(id) => (
              <select
                id={id}
                value={draft.customerId}
                onChange={(event) =>
                  setDraft({ ...draft, customerId: event.target.value, siteId: '' })
                }
                className={inputClass}
              >
                <option value="">{t('submissions.list.anyCustomer')}</option>
                {customers.data?.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                  </option>
                ))}
              </select>
            )}
          </Labelled>
          <Labelled label={t('submissions.list.site')}>
            {(id) => (
              <select
                id={id}
                value={draft.siteId}
                disabled={draft.customerId === ''}
                onChange={(event) => setDraft({ ...draft, siteId: event.target.value })}
                className={inputClass}
              >
                <option value="">{t('submissions.list.anySite')}</option>
                {sites.data?.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </select>
            )}
          </Labelled>
          {draft.workOrderId === '' ? null : (
            <div className="flex items-end gap-2 lg:col-span-2">
              <span className="rounded-full border border-accent px-3 py-1.5 text-sm text-content">
                {items[0]?.workOrder?.referenceLabel === undefined
                  ? t('submissions.list.thisWorkOrder')
                  : t('submissions.list.workOrder', {
                      reference: items[0].workOrder.referenceLabel,
                    })}
              </span>
              <button
                type="button"
                className={buttonClass.ghost}
                onClick={() => {
                  setDraft({ ...draft, workOrderId: '' });
                  setApplied({ ...applied, workOrderId: '' });
                }}
              >
                {t('submissions.list.removeWorkOrder')}
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[14rem] flex-1">
            <Labelled label={t('submissions.list.search')}>
              {(id) => (
                <input
                  id={id}
                  type="search"
                  value={draft.q}
                  onChange={(event) => setDraft({ ...draft, q: event.target.value })}
                  className={inputClass}
                />
              )}
            </Labelled>
          </div>
          {readsAll ? (
            <label className="flex items-center gap-2 pb-2 text-sm text-content">
              <input
                type="checkbox"
                checked={draft.mine}
                onChange={(event) => setDraft({ ...draft, mine: event.target.checked })}
              />
              {t('submissions.list.mine')}
            </label>
          ) : null}
        </div>

        {draft.formId === '' || questions.length === 0 ? null : (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-content">
              {t('submissions.list.filterBy')}
            </legend>
            {draft.answers.map((filter, index) => (
              <AnswerFilterRow
                // Filters have no identity beyond their position in the list a person is editing.
                key={index}
                filter={filter}
                questions={questions}
                locale={locale}
                onChange={(next) =>
                  setDraft({
                    ...draft,
                    answers: draft.answers.map((current, at) => (at === index ? next : current)),
                  })
                }
                onRemove={() =>
                  setDraft({ ...draft, answers: draft.answers.filter((_, at) => at !== index) })
                }
              />
            ))}
            <div>
              <button
                type="button"
                className={buttonClass.ghost}
                disabled={draft.answers.length >= 10}
                onClick={() =>
                  setDraft({
                    ...draft,
                    answers: [
                      ...draft.answers,
                      {
                        field: questions[0]!.field.id,
                        operator: OPERATORS[questions[0]!.type][0]!,
                        value: '',
                      },
                    ],
                  })
                }
              >
                {`+ ${t('submissions.list.addFilter')}`}
              </button>
            </div>
          </fieldset>
        )}

        <div className="flex flex-wrap gap-2">
          <button type="submit" className={buttonClass.primary}>
            {t('submissions.list.apply')}
          </button>
          <button
            type="button"
            className={buttonClass.ghost}
            onClick={() => {
              setDraft(EMPTY);
              setApplied(EMPTY);
            }}
          >
            {t('submissions.list.clear')}
          </button>
        </div>
      </form>

      {list.isPending ? <Loading /> : null}
      {list.isError ? <Failure error={list.error} onRetry={() => void list.refetch()} /> : null}
      {list.isSuccess && items.length === 0 ? (
        <p className="text-sm text-content-muted">{t('submissions.list.empty')}</p>
      ) : null}

      {items.length === 0 ? null : (
        <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-xs uppercase tracking-wide text-content-muted">
                <th scope="col" className="px-4 py-3 text-start font-medium">
                  {t('submissions.list.form')}
                </th>
                <th scope="col" className="px-4 py-3 text-start font-medium">
                  {t('submissions.list.status')}
                </th>
                <th scope="col" className="px-4 py-3 text-start font-medium">
                  {t('submissions.list.submittedBy')}
                </th>
                <th scope="col" className="px-4 py-3 text-start font-medium">
                  {t('submissions.list.submittedAt')}
                </th>
                <th scope="col" className="px-4 py-3">
                  <span className="sr-only">{t('submissions.list.open')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-border-subtle last:border-b-0">
                  <td className="px-4 py-3 text-content">
                    {item.formTitle}
                    {item.versionNumber === null ? null : (
                      <span className="ms-2 text-xs text-content-muted">
                        {t('submissions.list.version', { number: item.versionNumber })}
                      </span>
                    )}
                    {item.workOrder === null ? null : (
                      <span className="block font-mono text-xs text-content-muted">
                        {item.workOrder.referenceLabel}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-content">
                    {t(`submissions.status.${item.status}`)}
                    {item.amendedAt === null ? null : (
                      <span className="block text-xs text-content-muted">
                        {t('submissions.list.amended', {
                          when: formatDateTime(item.amendedAt, { locale }),
                        })}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-content">{item.submittedBy.name}</td>
                  <td className="px-4 py-3 text-content-muted">
                    {item.submittedAt === null ? '—' : formatDateTime(item.submittedAt, { locale })}
                  </td>
                  <td className="px-4 py-3 text-end">
                    <button
                      type="button"
                      className={buttonClass.secondary}
                      aria-label={`${t('submissions.list.open')}: ${item.formTitle}, ${item.submittedBy.name}`}
                      onClick={() => navigate(paths.submission(item.id))}
                    >
                      {t('submissions.list.open')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list.hasNextPage ? (
        <div>
          <button
            type="button"
            className={buttonClass.secondary}
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {t('submissions.list.more')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Labelled({
  label,
  children,
}: {
  label: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-content-muted">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

interface Question {
  field: Field;
  type: ReportableType;
}

function reportableQuestions(definition: FormDefinition | undefined): Question[] {
  if (definition === undefined) {
    return [];
  }
  const compiled = compileDefinition(definition);
  if (!compiled.ok) {
    return [];
  }
  return reportableFields(compiled.form.definition).flatMap((spec) => {
    const field = compiled.form.elements.get(spec.field)?.field;
    return field === undefined ? [] : [{ field, type: spec.type }];
  });
}

function AnswerFilterRow({
  filter,
  questions,
  locale,
  onChange,
  onRemove,
}: {
  filter: AnswerFilter;
  questions: readonly Question[];
  locale: string;
  onChange: (filter: AnswerFilter) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const question =
    questions.find((candidate) => candidate.field.id === filter.field) ?? questions[0]!;
  const field = question.field;
  const choices =
    field.type === 'dropdown' || field.type === 'radio' || field.type === 'multi_select'
      ? field.options.map((option) => ({ value: option.value, label: say(option.label, locale) }))
      : field.type === 'yes_no'
        ? [
            { value: 'yes', label: t('fill.yes') },
            { value: 'no', label: t('fill.no') },
            { value: 'not_applicable', label: t('fill.notApplicable') },
          ]
        : question.type === 'boolean'
          ? [
              { value: 'true', label: t('fill.ticked') },
              { value: 'false', label: t('fill.notTicked') },
            ]
          : undefined;

  const small =
    'rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-sm text-content';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label={t('submissions.list.question')}
        value={field.id}
        onChange={(event) => {
          const next = questions.find((candidate) => candidate.field.id === event.target.value)!;
          onChange({ field: next.field.id, operator: OPERATORS[next.type][0]!, value: '' });
        }}
        className={`${small} max-w-[16rem]`}
      >
        {questions.map((candidate) => (
          <option key={candidate.field.id} value={candidate.field.id}>
            {say(candidate.field.label, locale) || candidate.field.id}
          </option>
        ))}
      </select>
      <select
        aria-label={t('submissions.list.operator')}
        value={filter.operator}
        onChange={(event) => onChange({ ...filter, operator: event.target.value as Operator })}
        className={small}
      >
        {OPERATORS[question.type].map((operator) => (
          <option key={operator} value={operator}>
            {t(`submissions.operator.${operator}`)}
          </option>
        ))}
      </select>
      {choices === undefined || filter.operator === 'contains' ? (
        <input
          aria-label={t('submissions.list.value')}
          type={
            question.type === 'date'
              ? 'date'
              : question.type === 'time'
                ? 'time'
                : question.type === 'datetime'
                  ? 'datetime-local'
                  : 'text'
          }
          inputMode={question.type === 'number' ? 'decimal' : undefined}
          value={question.type === 'datetime' ? filter.value.slice(0, 16) : filter.value}
          onChange={(event) =>
            onChange({
              ...filter,
              value:
                question.type === 'datetime' && event.target.value !== ''
                  ? new Date(event.target.value).toISOString()
                  : event.target.value,
            })
          }
          className={small}
        />
      ) : (
        <select
          aria-label={t('submissions.list.value')}
          value={filter.value}
          onChange={(event) => onChange({ ...filter, value: event.target.value })}
          className={small}
        >
          <option value="">{t('fill.choose')}</option>
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        className={buttonClass.ghost}
        aria-label={t('submissions.list.removeFilter')}
        onClick={onRemove}
      >
        ✕
      </button>
    </div>
  );
}

function toQuery(filters: Filters) {
  const answers = filters.answers
    .filter((filter) => filter.value !== '')
    .map((filter) => `${filter.field}:${filter.operator}:${filter.value}`);
  return {
    ...(filters.formId === '' ? {} : { formId: filters.formId }),
    ...(filters.status === '' ? {} : { status: filters.status }),
    ...(filters.mine ? { mine: 'true' as const } : {}),
    ...(filters.from === '' ? {} : { from: filters.from }),
    ...(filters.to === '' ? {} : { to: filters.to }),
    ...(filters.q.trim() === '' ? {} : { q: filters.q.trim() }),
    ...(filters.workOrderId === '' ? {} : { workOrderId: filters.workOrderId }),
    ...(filters.siteId === '' ? {} : { siteId: filters.siteId }),
    ...(filters.customerId === '' ? {} : { customerId: filters.customerId }),
    ...(answers.length === 0 || filters.formId === '' ? {} : { filter: answers }),
    limit: 50,
  };
}
