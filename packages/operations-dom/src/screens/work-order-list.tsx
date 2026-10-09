import { useTranslation } from '@integr8/i18n';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { keys, type Priority, type SavedView, useOperations, type WorkOrderState } from '../api.js';
import { CrewPicker, type CrewMember } from '../crew.js';
import {
  buttonClass,
  copyText,
  DashboardBackLink,
  Dialog,
  Failure,
  Field,
  fromLocalInput,
  InlineError,
  inputClass,
  Loading,
  PriorityBadge,
  StateBadge,
  toLocalInput,
  useRowMenu,
  when,
} from '../ui.js';

/**
 * Finding and managing jobs: tabs by state with counts, filters, saved views,
 * and bulk reassign, reschedule or cancel.
 *
 * Every filter is a query parameter of `GET /v1/work-orders`, so a saved view is
 * exactly a set of those parameters. A bulk change reports each job it could
 * not change and why; the others go ahead.
 */

const STATES: readonly WorkOrderState[] = [
  'scheduled',
  'dispatched',
  'travelling',
  'on_site',
  'in_progress',
  'awaiting_parts',
  'complete',
  'reviewed',
  'cancelled',
];

const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];

export interface WorkOrderFilters {
  state?: WorkOrderState[];
  priority?: Priority[];
  jobTypeId?: string[];
  customerId?: string;
  siteId?: string;
  assigneeId?: string;
  unassigned?: 'true';
  overdue?: 'true';
  dueFrom?: string;
  dueBefore?: string;
  q?: string;
}

function clean(filters: WorkOrderFilters): WorkOrderFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(
      ([, value]) =>
        value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0),
    ),
  );
}

export function WorkOrderListScreen({
  initialFilters = {},
}: {
  initialFilters?: WorkOrderFilters;
}) {
  const { t } = useTranslation();
  const { client, locale, navigate, paths } = useOperations();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<WorkOrderFilters>(initialFilters);
  const [applied, setApplied] = useState<WorkOrderFilters>(clean(initialFilters));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<'reassign' | 'reschedule' | 'cancel' | undefined>(undefined);
  const [bulkResult, setBulkResult] = useState<
    { changed: number; refused: { id: string; label: string; message: string }[] } | undefined
  >(undefined);

  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const jobTypes = useQuery({
    queryKey: keys.jobTypes(false),
    queryFn: async () => (await client.GET('/v1/job-types')).data!.items,
  });
  const list = useInfiniteQuery({
    queryKey: keys.workOrders(applied as Record<string, unknown>),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/work-orders', {
          params: {
            query: {
              ...applied,
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
              limit: 50,
            },
          },
        })
      ).data!,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  const permissions = me.data?.permissions ?? [];
  const manage = permissions.includes('work_order.manage');
  const readAll = permissions.includes('work_order.read_all');
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const counts = list.data?.pages[0]?.counts;

  const apply = (event?: FormEvent) => {
    event?.preventDefault();
    setSelected(new Set());
    setApplied(clean(draft));
  };

  const chooseState = (state: WorkOrderState | undefined) => {
    const next = { ...draft, state: state === undefined ? [] : [state] };
    setDraft(next);
    setSelected(new Set());
    setApplied(clean(next));
  };

  const rowMenu = useRowMenu();
  const bulkOne = (id: string, action: 'reassign' | 'reschedule' | 'cancel') => {
    setSelected(new Set([id]));
    setBulk(action);
  };

  const activeState = applied.state?.length === 1 ? applied.state[0] : undefined;
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  const selectAllId = useId();

  return (
    <div className="flex flex-col gap-6 text-start">
      <DashboardBackLink />
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-content">{t('operations.workOrders.title')}</h1>
        {manage ? (
          <button
            type="button"
            className={buttonClass.primary}
            onClick={() => navigate(paths.newWorkOrder())}
          >
            {t('operations.workOrders.new')}
          </button>
        ) : null}
      </header>

      <nav
        aria-label={t('operations.workOrders.states')}
        className="flex flex-wrap gap-1 border-b border-border-subtle"
      >
        {[undefined, ...STATES].map((state) => {
          const active =
            state === activeState && (state !== undefined || (applied.state?.length ?? 0) === 0);
          const count =
            state === undefined
              ? Object.values(counts ?? {}).reduce((sum, value) => sum + value, 0)
              : (counts?.[state] ?? 0);
          return (
            <button
              key={state ?? 'all'}
              type="button"
              aria-pressed={active}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${active ? 'border-accent font-medium text-content' : 'border-transparent text-content-muted hover:text-content'}`}
              onClick={() => chooseState(state)}
            >
              {state === undefined
                ? t('operations.workOrders.allStates')
                : t(`operations.state.${state}`)}{' '}
              <span className="text-xs text-content-muted">
                {counts === undefined ? '' : count}
              </span>
            </button>
          );
        })}
      </nav>

      <form
        onSubmit={apply}
        aria-label={t('operations.workOrders.title')}
        className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface p-4"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t('operations.workOrders.search')} className="sm:col-span-2">
            {(id) => (
              <input
                id={id}
                type="search"
                className={inputClass}
                value={draft.q ?? ''}
                onChange={(event) => setDraft({ ...draft, q: event.target.value })}
              />
            )}
          </Field>
          <Field label={t('operations.priority.label')}>
            {(id) => (
              <select
                id={id}
                className={inputClass}
                value={draft.priority?.[0] ?? ''}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    priority: event.target.value === '' ? [] : [event.target.value as Priority],
                  })
                }
              >
                <option value="">{t('operations.workOrders.anyPriority')}</option>
                {PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {t(`operations.priority.${priority}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('operations.workOrders.jobType')}>
            {(id) => (
              <select
                id={id}
                className={inputClass}
                value={draft.jobTypeId?.[0] ?? ''}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    jobTypeId: event.target.value === '' ? [] : [event.target.value],
                  })
                }
              >
                <option value="">{t('operations.workOrders.anyJobType')}</option>
                {jobTypes.data?.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {readAll ? (
            <Field label={t('operations.workOrders.assignee')}>
              {(id) => (
                <select
                  id={id}
                  className={inputClass}
                  value={draft.unassigned === 'true' ? 'nobody' : (draft.assigneeId ?? '')}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDraft({
                      ...draft,
                      assigneeId: value === '' || value === 'nobody' ? undefined : value,
                      unassigned: value === 'nobody' ? 'true' : undefined,
                    } as WorkOrderFilters);
                  }}
                >
                  <option value="">{t('operations.workOrders.anyone')}</option>
                  <option value="me">{t('operations.workOrders.me')}</option>
                  <option value="nobody">{t('operations.workOrders.unassigned')}</option>
                </select>
              )}
            </Field>
          ) : null}
          <Field label={t('operations.workOrders.dueFrom')}>
            {(id) => (
              <input
                id={id}
                type="datetime-local"
                className={inputClass}
                value={toLocalInput(draft.dueFrom)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    dueFrom: fromLocalInput(event.target.value) ?? undefined,
                  } as WorkOrderFilters)
                }
              />
            )}
          </Field>
          <Field label={t('operations.workOrders.dueBefore')}>
            {(id) => (
              <input
                id={id}
                type="datetime-local"
                className={inputClass}
                value={toLocalInput(draft.dueBefore)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    dueBefore: fromLocalInput(event.target.value) ?? undefined,
                  } as WorkOrderFilters)
                }
              />
            )}
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm text-content">
            <input
              type="checkbox"
              checked={draft.overdue === 'true'}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  overdue: event.target.checked ? 'true' : undefined,
                } as WorkOrderFilters)
              }
            />
            {t('operations.workOrders.overdue')}
          </label>
        </div>
        {me.isError ? <InlineError onRetry={() => void me.refetch()} /> : null}
        {jobTypes.isError ? <InlineError onRetry={() => void jobTypes.refetch()} /> : null}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex gap-2">
            <button type="submit" className={buttonClass.primary}>
              {t('operations.workOrders.apply')}
            </button>
            <button
              type="button"
              className={buttonClass.ghost}
              onClick={() => {
                setDraft({});
                setApplied({});
                setSelected(new Set());
              }}
            >
              {t('operations.workOrders.clear')}
            </button>
          </div>
          <SavedViews
            current={applied}
            onChoose={(filters) => {
              setDraft(filters);
              setApplied(clean(filters));
              setSelected(new Set());
            }}
          />
        </div>
      </form>

      {manage && selected.size > 0 ? (
        <div
          role="region"
          aria-label={t('operations.workOrders.selected', { count: selected.size })}
          className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-accent bg-surface p-3"
        >
          <span className="text-sm font-medium text-content">
            {t('operations.workOrders.selected', { count: selected.size })}
          </span>
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => setBulk('reassign')}
          >
            {t('operations.workOrders.bulk.reassign')}
          </button>
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => setBulk('reschedule')}
          >
            {t('operations.workOrders.bulk.reschedule')}
          </button>
          <button type="button" className={buttonClass.danger} onClick={() => setBulk('cancel')}>
            {t('operations.workOrders.bulk.cancel')}
          </button>
        </div>
      ) : null}

      {bulkResult === undefined ? null : (
        <div
          role="status"
          className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-surface p-3 text-sm"
        >
          <p className="text-content">
            {t('operations.workOrders.bulk.done', { count: bulkResult.changed })}
          </p>
          {bulkResult.refused.length === 0 ? null : (
            <>
              <p className="text-danger">
                {t('operations.workOrders.bulk.refused', { count: bulkResult.refused.length })}
              </p>
              <ul className="list-disc ps-5 text-content">
                {bulkResult.refused.map((entry) => (
                  <li key={entry.id}>
                    {entry.label}: {entry.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <Failure error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {t('operations.workOrders.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-subtle">
          <table className="w-full min-w-[48rem] text-sm">
            <thead className="bg-surface-muted text-start text-content-muted">
              <tr>
                {manage ? (
                  <th scope="col" className="w-10 px-3 py-2">
                    <label htmlFor={selectAllId} className="sr-only">
                      {t('operations.workOrders.selectAll')}
                    </label>
                    <input
                      id={selectAllId}
                      type="checkbox"
                      checked={allSelected}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked ? new Set(items.map((item) => item.id)) : new Set(),
                        )
                      }
                    />
                  </th>
                ) : null}
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.workOrders.job')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.workOrders.customerSite')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.workOrders.due')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.workOrders.crew')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle bg-surface">
              {items.map((item) => (
                <tr
                  key={item.id}
                  className="align-top hover:bg-surface-muted"
                  onContextMenu={rowMenu(
                    {
                      kind: 'workOrder',
                      id: item.id,
                      label: `${item.referenceLabel} · ${item.title}`,
                    },
                    () => [
                      {
                        key: 'open',
                        label: t('operations.rowActions.open'),
                        onSelect: () => navigate(paths.workOrder(item.id)),
                      },
                      {
                        key: 'copyId',
                        label: t('operations.rowActions.copyId'),
                        onSelect: () => copyText(item.id),
                      },
                      ...(manage
                        ? [
                            {
                              key: 'reassign',
                              label: t('operations.workOrders.bulk.reassign'),
                              onSelect: () => bulkOne(item.id, 'reassign'),
                            },
                            {
                              key: 'reschedule',
                              label: t('operations.workOrders.bulk.reschedule'),
                              onSelect: () => bulkOne(item.id, 'reschedule'),
                            },
                            {
                              key: 'cancel',
                              label: t('operations.rowActions.cancelJob'),
                              destructive: true,
                              disabled: item.state === 'cancelled' || item.state === 'reviewed',
                              onSelect: () => bulkOne(item.id, 'cancel'),
                            },
                          ]
                        : []),
                    ],
                  )}
                >
                  {manage ? (
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={t('operations.workOrders.select', {
                          reference: item.referenceLabel,
                        })}
                        checked={selected.has(item.id)}
                        onChange={(event) => {
                          const next = new Set(selected);
                          if (event.target.checked) {
                            next.add(item.id);
                          } else {
                            next.delete(item.id);
                          }
                          setSelected(next);
                        }}
                      />
                    </td>
                  ) : null}
                  <td className="px-3 py-2">
                    <a
                      href={paths.workOrder(item.id)}
                      className="font-medium text-accent underline-offset-4 hover:underline"
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(paths.workOrder(item.id));
                      }}
                    >
                      <span className="font-mono text-xs text-content-muted">
                        {item.referenceLabel}
                      </span>{' '}
                      {item.title}
                    </a>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <StateBadge state={item.state} />
                      <PriorityBadge priority={item.priority} />
                      <span className="text-xs text-content-muted">{item.jobType.name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-content">
                    {item.customer.name}
                    <span className="block text-xs text-content-muted">
                      {item.site.name}
                      {item.site.city === null ? '' : `, ${item.site.city}`}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-content">
                    {item.dueBy === null ? (
                      <span className="text-content-muted">{t('operations.workOrders.noDue')}</span>
                    ) : (
                      when(item.dueBy, locale)
                    )}
                  </td>
                  <td className="px-3 py-2 text-content">
                    {item.crew.length === 0 ? (
                      <span className="text-content-muted">
                        {t('operations.workOrders.noCrew')}
                      </span>
                    ) : (
                      item.crew.map((member) => (
                        <span key={member.id} className="block">
                          {member.lead && item.crew.length > 1
                            ? t('operations.workOrders.leadMember', { name: member.name })
                            : member.name}
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list.hasNextPage ? (
        <button
          type="button"
          className={`${buttonClass.secondary} self-center`}
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('operations.workOrders.more')}
        </button>
      ) : null}

      {bulk === undefined ? null : (
        <BulkDialog
          action={bulk}
          ids={[...selected]}
          onClose={() => setBulk(undefined)}
          onDone={(results) => {
            setBulk(undefined);
            setSelected(new Set());
            const labels = new Map(items.map((item) => [item.id, item.referenceLabel]));
            setBulkResult({
              changed: results.filter((result) => result.outcome === 'changed').length,
              refused: results
                .filter((result) => result.outcome === 'refused')
                .map((result) => ({
                  id: result.workOrderId,
                  label: labels.get(result.workOrderId) ?? result.workOrderId,
                  message: result.message ?? '',
                })),
            });
            void queryClient.invalidateQueries({ queryKey: ['work-orders'] });
          }}
        />
      )}
    </div>
  );
}

interface BulkResult {
  workOrderId: string;
  outcome: 'changed' | 'refused';
  code: string | null;
  message: string | null;
}

function BulkDialog({
  action,
  ids,
  onClose,
  onDone,
}: {
  action: 'reassign' | 'reschedule' | 'cancel';
  ids: string[];
  onClose: () => void;
  onDone: (results: BulkResult[]) => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [shiftDays, setShiftDays] = useState('');
  const [dueFrom, setDueFrom] = useState('');
  const [dueBy, setDueBy] = useState('');
  const [reason, setReason] = useState('');

  const run = useMutation({
    mutationFn: async () => {
      const header = { 'Idempotency-Key': crypto.randomUUID() };
      const body =
        action === 'reassign'
          ? { action, workOrderIds: ids, crew }
          : action === 'cancel'
            ? { action, workOrderIds: ids, reason }
            : {
                action,
                workOrderIds: ids,
                ...(shiftDays === ''
                  ? { dueFrom: fromLocalInput(dueFrom), dueBy: fromLocalInput(dueBy) }
                  : { shiftMinutes: Math.round(Number(shiftDays) * 24 * 60) }),
                ...(reason === '' ? {} : { reason }),
              };
      return (await client.POST('/v1/work-orders/bulk', { params: { header }, body })).data!
        .results;
    },
    onSuccess: onDone,
  });

  const ready =
    action === 'reassign'
      ? true
      : action === 'cancel'
        ? reason.trim() !== ''
        : shiftDays !== '' || dueFrom !== '' || dueBy !== '';

  return (
    <Dialog
      title={t(`operations.workOrders.bulk.${action}Title`, { count: ids.length })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={action === 'cancel' ? buttonClass.danger : buttonClass.primary}
            disabled={!ready || run.isPending}
            aria-busy={run.isPending}
            onClick={() => run.mutate()}
          >
            {t('operations.transition.confirm')}
          </button>
        </>
      }
    >
      {action === 'reassign' ? <CrewPicker value={crew} onChange={setCrew} /> : null}
      {action === 'reschedule' ? (
        <>
          <Field
            label={t('operations.workOrders.bulk.shiftDays')}
            hint={t('operations.workOrders.bulk.shiftHint')}
          >
            {(id, describedBy) => (
              <input
                id={id}
                type="number"
                step="1"
                aria-describedby={describedBy}
                className={inputClass}
                value={shiftDays}
                onChange={(event) => setShiftDays(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('operations.workOrderForm.dueFrom')}>
            {(id) => (
              <input
                id={id}
                type="datetime-local"
                disabled={shiftDays !== ''}
                className={inputClass}
                value={dueFrom}
                onChange={(event) => setDueFrom(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('operations.workOrderForm.dueBy')}>
            {(id) => (
              <input
                id={id}
                type="datetime-local"
                disabled={shiftDays !== ''}
                className={inputClass}
                value={dueBy}
                onChange={(event) => setDueBy(event.target.value)}
              />
            )}
          </Field>
        </>
      ) : null}
      {action === 'reassign' ? null : (
        <Field
          label={t('operations.transition.reasonLabel')}
          hint={t('operations.transition.reasonHint')}
        >
          {(id, describedBy) => (
            <textarea
              id={id}
              rows={2}
              required={action === 'cancel'}
              aria-describedby={describedBy}
              className={inputClass}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
      )}
      {run.isError ? <Failure error={run.error} /> : null}
    </Dialog>
  );
}

function SavedViews({
  current,
  onChoose,
}: {
  current: WorkOrderFilters;
  onChoose: (filters: WorkOrderFilters) => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [chosen, setChosen] = useState('');

  const views = useQuery({
    queryKey: keys.views,
    queryFn: async () => (await client.GET('/v1/saved-views')).data!.items,
  });
  const save = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/saved-views', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: { name, filters: current, shared },
        })
      ).data!,
    onSuccess: (view) => {
      setSaving(false);
      setName('');
      setChosen(view.id);
      void queryClient.invalidateQueries({ queryKey: keys.views });
    },
  });
  const remove = useMutation({
    mutationFn: async (viewId: string) =>
      client.DELETE('/v1/saved-views/{viewId}', { params: { path: { viewId } } }),
    onSuccess: () => {
      setChosen('');
      void queryClient.invalidateQueries({ queryKey: keys.views });
    },
  });

  const selectedView: SavedView | undefined = views.data?.find((view) => view.id === chosen);

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label={t('operations.workOrders.views.label')}>
        {(id) => (
          <select
            id={id}
            className={inputClass}
            value={chosen}
            onChange={(event) => {
              setChosen(event.target.value);
              const view = views.data?.find((candidate) => candidate.id === event.target.value);
              if (view !== undefined) {
                onChoose(view.filters);
              }
            }}
          >
            <option value="">
              {(views.data?.length ?? 0) === 0
                ? t('operations.workOrders.views.none')
                : t('operations.workOrders.views.choose')}
            </option>
            {views.data?.map((view) => (
              <option key={view.id} value={view.id}>
                {view.mine
                  ? view.name
                  : t('operations.workOrders.views.sharedOption', {
                      name: view.name,
                      owner: view.owner.name,
                    })}
              </option>
            ))}
          </select>
        )}
      </Field>
      {selectedView?.mine === true ? (
        <button
          type="button"
          className={buttonClass.ghost}
          onClick={() => remove.mutate(selectedView.id)}
        >
          {t('operations.workOrders.views.delete')}
        </button>
      ) : null}
      <button type="button" className={buttonClass.secondary} onClick={() => setSaving(true)}>
        {t('operations.workOrders.views.save')}
      </button>
      {views.isError ? <InlineError onRetry={() => void views.refetch()} /> : null}
      {remove.isError ? <Failure error={remove.error} /> : null}
      {saving ? (
        <Dialog
          title={t('operations.workOrders.views.saveTitle')}
          onClose={() => setSaving(false)}
          footer={
            <>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setSaving(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={buttonClass.primary}
                disabled={name.trim() === '' || save.isPending}
                onClick={() => save.mutate()}
              >
                {t('common.save')}
              </button>
            </>
          }
        >
          <Field label={t('operations.workOrders.views.name')}>
            {(id) => (
              <input
                id={id}
                className={inputClass}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </Field>
          <label className="flex items-center gap-2 text-sm text-content">
            <input
              type="checkbox"
              checked={shared}
              onChange={(event) => setShared(event.target.checked)}
            />
            {t('operations.workOrders.views.share')}
          </label>
          {save.isError ? <Failure error={save.error} /> : null}
        </Dialog>
      ) : null}
    </div>
  );
}
