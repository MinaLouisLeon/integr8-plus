import {
  type Announcements,
  type ClientRect,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  type KeyboardCoordinateGetter,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  type UniqueIdentifier,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from '@integr8/i18n';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { keys, type Opportunity, type OpportunityPage, type Stage, useOperations } from '../api.js';
import { CsvExportButton } from '../exports.js';
import { BackLink, buttonClass, Failure, Field, inputClass, Loading, useRowMenu } from '../ui.js';
import { formatAmount, memberName, useMembers } from './lead-parts.js';
import {
  CloseDealDialog,
  formatChance,
  MoveControl,
  NewOpportunityDialog,
  StageBadge,
  usePipelines,
  useStageName,
} from './opportunity-parts.js';

/**
 * Opportunities (CRM/ERP plan, phase C3): a board with a column for each open
 * stage, or a list with every opportunity. A card is dragged to another open
 * stage and moves at once, with a way to undo; dropped on won or lost, it asks
 * first, and losing asks why (ADR-0013, G1c). The stage select on each card
 * stays, for whoever would rather not drag. Amounts are estimates, not revenue.
 */

type View = 'board' | 'list';

/**
 * What dropping a card on a stage means: nothing on its own stage, a move at
 * once between open stages, and won or lost only once confirmed.
 */
export function boardDrop(
  item: Pick<Opportunity, 'stage'>,
  target: Stage | undefined,
): { kind: 'none' } | { kind: 'move' | 'confirm'; stage: Stage } {
  if (target === undefined || target.archived || target.id === item.stage.id) {
    return { kind: 'none' };
  }
  return { kind: target.outcome === 'open' ? 'move' : 'confirm', stage: target };
}

/** Where the pointer is decides the stage; for the keyboard, where the card is. */
const collision: CollisionDetection = (args) => {
  const under = pointerWithin(args);
  return under.length > 0 ? under : rectIntersection(args);
};

const STEPS: Readonly<Partial<Record<string, { x: number; y: number }>>> = {
  ArrowRight: { x: 1, y: 0 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowDown: { x: 0, y: 1 },
  ArrowUp: { x: 0, y: -1 },
};

const centre = (rect: ClientRect) => ({
  x: rect.left + rect.width / 2,
  y: rect.top + rect.height / 2,
});

/**
 * The arrow keys carry a card from column to column as they are laid out on
 * screen, not a few pixels at a time: the nearest column that way, preferring
 * one in line. Left is the next stage in Arabic and the previous in English,
 * as the eye expects.
 */
const columnCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const step = STEPS[event.code];
  const { collisionRect, droppableRects, droppableContainers } = context;
  if (step === undefined || collisionRect === null) {
    return undefined;
  }
  event.preventDefault();
  const from = centre(collisionRect);
  let best: { rect: ClientRect; score: number } | null = null;
  for (const container of droppableContainers.getEnabled()) {
    const rect = droppableRects.get(container.id);
    if (rect === undefined) {
      continue;
    }
    // How far its near edge lies that way: a column the card is in, or one
    // beside it when going down a tall column, is not that way at all.
    const along =
      step.x > 0
        ? rect.left - from.x
        : step.x < 0
          ? from.x - rect.right
          : step.y > 0
            ? rect.top - from.y
            : from.y - rect.bottom;
    if (along < 0) {
      continue;
    }
    const to = centre(rect);
    const across = step.x === 0 ? Math.abs(to.x - from.x) : Math.abs(to.y - from.y);
    const score = along + across * 2;
    if (best === null || score < best.score) {
      best = { rect, score };
    }
  }
  if (best === null) {
    return undefined;
  }
  return {
    x: best.rect.left + (best.rect.width - collisionRect.width) / 2,
    y: best.rect.top + Math.min(8, (best.rect.height - collisionRect.height) / 2),
  };
};

/** A press on a form control is for the control — the stage select — not a drag. */
const onControl = (target: EventTarget | null) =>
  target instanceof Element && target.closest('select, input, textarea') !== null;

/** A mouse moves a card once it has travelled a little, so a click still opens it. */
class CardMouseSensor extends MouseSensor {
  static override activators = [
    {
      eventName: 'onMouseDown' as const,
      handler: ({ nativeEvent }: ReactMouseEvent) =>
        nativeEvent.button === 0 && !onControl(nativeEvent.target),
    },
  ];
}

/** A finger once it has rested a moment, so a swipe still scrolls the board. */
class CardTouchSensor extends TouchSensor {
  static override activators = [
    {
      eventName: 'onTouchStart' as const,
      handler: ({ nativeEvent }: ReactTouchEvent) =>
        nativeEvent.touches.length <= 1 && !onControl(nativeEvent.target),
    },
  ];
}

type Board = InfiniteData<OpportunityPage>;

/** The board as cached, with one opportunity changed. */
function withItem(
  data: Board | undefined,
  id: string,
  change: (item: Opportunity) => Opportunity,
): Board | undefined {
  return data === undefined
    ? data
    : {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items.map((item) => (item.id === id ? change(item) : item)),
        })),
      };
}

interface MoveInput {
  item: Opportunity;
  stageId: string;
  lostReason?: string;
  /** Set for a drag between open stages, which can be undone. */
  from?: Opportunity['stage'];
}

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
  const listKey = keys.opportunities({ ...query, view });
  const list = useInfiniteQuery({
    queryKey: listKey,
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

  const pipeline = pipelines.data?.[0];
  const stages = pipeline?.stages ?? [];
  const [moved, setMoved] = useState<{
    item: Opportunity;
    from: Opportunity['stage'];
    to: Stage;
  } | null>(null);
  const [closing, setClosing] = useState<{ item: Opportunity; stage: Stage } | null>(null);
  const [refocus, setRefocus] = useState<{ id: string; stageId: string } | null>(null);
  const clearRefocus = useCallback(() => setRefocus(null), []);

  const move = useMutation({
    mutationFn: async (input: MoveInput) =>
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
    // The card moves at once; a refusal puts it back where it was.
    onMutate: async (input) => {
      setMoved(null);
      await queries.cancelQueries({ queryKey: listKey });
      const previous = queries.getQueryData<Board>(listKey);
      const stage = stages.find((candidate) => candidate.id === input.stageId);
      if (stage !== undefined) {
        queries.setQueryData<Board>(listKey, (data) =>
          withItem(data, input.item.id, (item) => ({ ...item, stage, status: stage.outcome })),
        );
      }
      return { key: listKey, previous };
    },
    onError: (_error, _input, context) => {
      setRefocus(null);
      if (context?.previous !== undefined) {
        queries.setQueryData(context.key, context.previous);
      }
    },
    onSuccess: (result, input) => {
      // The server's copy at once, so a second drag before the list reloads
      // carries the version this move left it at.
      queries.setQueryData<Board>(listKey, (data) =>
        withItem(data, result.opportunity.id, () => result.opportunity),
      );
      const to = stages.find((candidate) => candidate.id === input.stageId);
      if (input.from !== undefined && to !== undefined) {
        setMoved({ item: result.opportunity, from: input.from, to });
      }
    },
    onSettled: async () => {
      await queries.invalidateQueries({ queryKey: ['crm'] });
    },
  });

  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const openStages = stages.filter((stage) => stage.outcome === 'open' && !stage.archived);
  const closedStages = stages.filter((stage) => stage.outcome !== 'open' && !stage.archived);

  const sensors = useSensors(
    useSensor(CardMouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(CardTouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: columnCoordinates }),
  );
  const itemFor = (id: UniqueIdentifier) => items.find((candidate) => candidate.id === id);
  const target = (id: UniqueIdentifier | undefined) =>
    stages.find((candidate) => candidate.id === id);
  // The words a screen reader hears while a card moves: its title and stage.
  const dragged = (id: UniqueIdentifier) => {
    const item = itemFor(id);
    return { title: item?.title ?? '', stage: item === undefined ? '' : stageName(item.stage) };
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('crm.opportunities.drag.start', dragged(active.id)),
    onDragOver: ({ active, over }) => {
      const stage = target(over?.id);
      return stage === undefined
        ? t('crm.opportunities.drag.overNothing', dragged(active.id))
        : t('crm.opportunities.drag.over', { ...dragged(active.id), stage: stageName(stage) });
    },
    onDragEnd: ({ active, over }) => {
      const item = itemFor(active.id);
      const { title, stage } = dragged(active.id);
      const drop =
        item === undefined ? { kind: 'none' as const } : boardDrop(item, target(over?.id));
      return drop.kind === 'none'
        ? t('crm.opportunities.drag.stays', { title, stage })
        : t(
            drop.kind === 'move'
              ? 'crm.opportunities.drag.dropMove'
              : 'crm.opportunities.drag.dropClose',
            {
              title,
              stage: stageName(drop.stage),
            },
          );
    },
    onDragCancel: ({ active }) => t('crm.opportunities.drag.cancel', dragged(active.id)),
  };
  const onDragEnd = ({ active, over, activatorEvent }: DragEndEvent) => {
    const item = itemFor(active.id);
    if (item === undefined) {
      return;
    }
    const drop = boardDrop(item, target(over?.id));
    if (drop.kind === 'move') {
      if (activatorEvent instanceof KeyboardEvent) {
        setRefocus({ id: item.id, stageId: drop.stage.id });
      }
      move.mutate({ item, stageId: drop.stage.id, from: item.stage });
    } else if (drop.kind === 'confirm') {
      setClosing({ item, stage: drop.stage });
    }
  };

  const card = (item: Opportunity) => {
    const owner = memberName(members.data, item.ownerId);
    return (
      <BoardCard
        key={item.id}
        item={item}
        movable={manage}
        disabled={move.isPending}
        focusHandle={refocus?.id === item.id && refocus.stageId === item.stage.id}
        onFocused={clearRefocus}
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
          draggable={false}
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
      </BoardCard>
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
      {moved === null ? null : (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface p-3 text-sm text-content"
        >
          <span>
            {t('crm.opportunities.movedTo', {
              title: moved.item.title,
              stage: stageName(moved.to),
            })}
          </span>
          <span className="flex gap-2">
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={move.isPending}
              onClick={() => move.mutate({ item: moved.item, stageId: moved.from.id })}
            >
              {t('crm.opportunities.undo')}
            </button>
            <button type="button" className={buttonClass.ghost} onClick={() => setMoved(null)}>
              {t('crm.opportunities.dismiss')}
            </button>
          </span>
        </div>
      )}

      {list.isPending || pipelines.isPending ? (
        <Loading />
      ) : list.isError ? (
        <Failure error={list.error} onRetry={() => void list.refetch()} />
      ) : pipelines.isError ? (
        <Failure error={pipelines.error} onRetry={() => void pipelines.refetch()} />
      ) : view === 'board' ? (
        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          accessibility={{
            announcements,
            screenReaderInstructions: { draggable: t('crm.opportunities.drag.instructions') },
          }}
          onDragEnd={onDragEnd}
        >
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {openStages.map((stage) => {
              const inStage = items.filter((item) => item.stage.id === stage.id);
              return (
                <StageColumn key={stage.id} stage={stage}>
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
                    <p className="text-xs text-content-muted">
                      {t('crm.opportunities.emptyStage')}
                    </p>
                  ) : (
                    inStage.map(card)
                  )}
                </StageColumn>
              );
            })}
          </div>
          {/* Won and lost take a card only to close it; there is nothing to show in them. */}
          {manage && closedStages.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {closedStages.map((stage) => (
                <CloseZone key={stage.id} stage={stage} />
              ))}
            </div>
          ) : null}
        </DndContext>
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
      {closing === null ? null : (
        <CloseDealDialog
          opportunity={closing.item}
          stage={closing.stage}
          onCancel={() => setClosing(null)}
          onConfirm={(lostReason) => {
            move.mutate({
              item: closing.item,
              stageId: closing.stage.id,
              ...(lostReason === undefined ? {} : { lostReason }),
            });
            setClosing(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * A card on the board. Dragged by any part of it with a mouse or a finger;
 * with the keyboard from its handle, so Enter on the title still opens it.
 */
function BoardCard({
  item,
  movable,
  disabled,
  focusHandle,
  onFocused,
  onContextMenu,
  children,
}: {
  item: Opportunity;
  /** Whoever may move deals gets the handle. */
  movable: boolean;
  /** While a move is on its way, nothing else moves. */
  disabled: boolean;
  /** Just dropped here by keyboard: the handle takes the focus back. */
  focusHandle: boolean;
  onFocused: () => void;
  onContextMenu: ((event: ReactMouseEvent) => void) | undefined;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const handle = useRef<HTMLButtonElement | null>(null);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } =
    useDraggable({
      id: item.id,
      disabled: !movable || disabled,
      attributes: { roleDescription: t('crm.opportunities.dragRole') },
    });
  // A card dropped in another column is drawn afresh there; without this
  // the keyboard's focus would be lost with the old one.
  useEffect(() => {
    if (focusHandle) {
      handle.current?.focus();
      onFocused();
    }
  }, [focusHandle, onFocused]);
  return (
    <article
      ref={setNodeRef}
      {...listeners}
      style={transform === null ? undefined : { transform: CSS.Translate.toString(transform) }}
      className={`flex touch-manipulation flex-col gap-2 rounded-md border border-border-subtle bg-surface p-3 text-sm ${
        isDragging ? 'relative z-10 shadow-lg' : ''
      }`}
      onContextMenu={onContextMenu}
    >
      {movable ? (
        <button
          ref={(node) => {
            handle.current = node;
            setActivatorNodeRef(node);
          }}
          type="button"
          {...attributes}
          aria-label={t('crm.opportunities.dragHandle', { title: item.title })}
          className="-mt-1 -me-1 cursor-grab self-end rounded px-1 text-content-muted hover:bg-surface-muted"
        >
          <span aria-hidden="true">⠿</span>
        </button>
      ) : null}
      {children}
    </article>
  );
}

/** An open stage's column: its cards, and where a card dragged to that stage lands. */
function StageColumn({ stage, children }: { stage: Stage; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  return (
    <section
      ref={setNodeRef}
      aria-labelledby={`crm-stage-${stage.id}`}
      className={`flex flex-col gap-3 rounded-lg border bg-surface-muted p-3 ${
        isOver ? 'border-accent ring-2 ring-accent' : 'border-border-subtle'
      }`}
    >
      {children}
    </section>
  );
}

/** Won or lost: somewhere to drop a card to close it, which asks first. */
function CloseZone({ stage }: { stage: Stage }) {
  const { t } = useTranslation();
  const stageName = useStageName();
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const labelId = `crm-close-zone-${stage.id}`;
  return (
    <div
      ref={setNodeRef}
      role="group"
      aria-labelledby={labelId}
      className={`flex flex-col gap-1 rounded-lg border-2 border-dashed p-3 text-sm ${
        isOver
          ? 'border-accent bg-surface'
          : stage.outcome === 'won'
            ? 'border-success bg-surface-muted'
            : 'border-border-subtle bg-surface-muted'
      }`}
    >
      <span id={labelId} className="font-semibold text-content">
        {stageName(stage)}
      </span>
      <span className="text-xs text-content-muted">{t('crm.opportunities.dropHere')}</span>
    </div>
  );
}
