import {
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { DEFAULT_VISIT_DURATION_MINUTES } from '@integr8/core';
import { apiErrorCodeMessage, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type BulkVisitResult,
  keys,
  type Schedule,
  type ScheduleJob,
  type SchedulePerson,
  type ScheduleVisit,
  type UnscheduledJob,
  useOperations,
} from '../api.js';
import {
  buttonClass,
  DashboardBackLink,
  Failure,
  InlineError,
  inputClass,
  Loading,
  PriorityBadge,
  useDuration,
  usePermissions,
} from '../ui.js';
import {
  isUnqualified,
  type UnqualifiedDetail,
  unqualifiedDetails,
} from '../qualifications/model.js';
import { GapList, gapsFromDetails, UnqualifiedPrompt } from '../qualifications/override.js';
import {
  addDays,
  addMinutes,
  DAY_MINUTES,
  dayKey,
  firstDayOfWeek,
  fromDayKey,
  initials,
  layoutLanes,
  personColour,
  PX_PER_MINUTE,
  rangeFor,
  sameDay,
  segmentOn,
  snapMinutes,
  startOfDay,
  stepAnchor,
  VIEW_MODES,
  type ViewMode,
} from './model.js';
import { VisitDialog, type VisitDialogTarget } from './visit-dialog.js';

/**
 * The scheduling board (P25): a calendar of engineers' visits.
 *
 * Day, week and month views. Visits are coloured by the people on them, and
 * the sidebar shows or hides people. Dragging a visit moves it; dragging its
 * bottom edge changes when it ends; dragging a job from "Needs a visit" onto a
 * day plans one there. Ctrl- or Shift-clicking visits selects several, to hand
 * them to someone else, move them or cancel them at once — which is how an
 * unavailable engineer's day is redistributed.
 *
 * A move shows at once and is undone if the server refuses it, with the
 * reason: most often that someone would be on another job at the same time,
 * which the database never allows. Work at any hour is fine: the company's
 * working day only shades the grid. A move that would leave nobody on the
 * visit holding a qualification the job needs (P26) stays on screen while the
 * dispatcher is asked why; cancelling puts it back.
 *
 * Everything dragging does, the visit dialog also does from the keyboard.
 */

const PREFS_KEY = 'integr8.schedule.v1';

interface Prefs {
  mode: ViewMode;
  /** People hidden from the board; `undefined` until the person first chooses. */
  hidden?: string[];
  showNobody: boolean;
  showCancelled: boolean;
}

const DEFAULT_PREFS: Prefs = { mode: 'week', showNobody: true, showCancelled: false };

function readPrefs(): Prefs {
  try {
    const stored = globalThis.localStorage?.getItem(PREFS_KEY);
    if (stored == null) {
      return DEFAULT_PREFS;
    }
    const parsed = JSON.parse(stored) as Partial<Prefs>;
    return {
      mode: VIEW_MODES.find((mode) => mode === parsed.mode) ?? 'week',
      ...(Array.isArray(parsed.hidden)
        ? { hidden: parsed.hidden.filter((id) => typeof id === 'string') }
        : {}),
      showNobody: parsed.showNobody !== false,
      showCancelled: parsed.showCancelled === true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writePrefs(prefs: Prefs) {
  try {
    globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private windows and full storage: the board still works, it just forgets.
  }
}

/** What is being dragged, for the overlay and the drop. */
type Dragging =
  | { kind: 'visit'; visit: ScheduleVisit; day: string }
  | { kind: 'resize'; visit: ScheduleVisit }
  | { kind: 'job'; entry: UnscheduledJob };

/** A move on the calendar, and on its second try the reason for going ahead (P26). */
interface MoveChange {
  visit: ScheduleVisit;
  startsAt: Date;
  endsAt: Date;
  reason?: string;
  /** The board before the first try, to put back if the move is given up. */
  before?: Schedule | undefined;
}

export function ScheduleScreen() {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  const canPlan = permissions.includes('work_order.manage');

  const [prefs, setPrefsState] = useState<Prefs>(readPrefs);
  const setPrefs = (next: Prefs) => {
    setPrefsState(next);
    writePrefs(next);
  };
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const firstDay = useMemo(() => firstDayOfWeek(locale), [locale]);
  const range = rangeFor(prefs.mode, anchor, firstDay);
  const rangeKey = {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    cancelled: prefs.showCancelled,
  };

  const schedule = useQuery({
    queryKey: keys.schedule(rangeKey),
    queryFn: async () =>
      (
        await client.GET('/v1/schedule', {
          params: {
            query: {
              from: rangeKey.from,
              to: rangeKey.to,
              ...(prefs.showCancelled ? { includeCancelled: 'true' as const } : {}),
            },
          },
        })
      ).data!,
    placeholderData: (previous) => previous,
  });
  const unscheduled = useQuery({
    queryKey: keys.unscheduled,
    queryFn: async () => (await client.GET('/v1/schedule/unscheduled')).data!.items,
  });

  const [dialog, setDialog] = useState<VisitDialogTarget | undefined>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [selectionFrom, setSelectionFrom] = useState<string | undefined>();
  const [dragging, setDragging] = useState<Dragging | undefined>();
  const [resizeBy, setResizeBy] = useState(0);
  const [moveError, setMoveError] = useState<unknown>();
  /** A move the server refused for want of a qualification, waiting for a reason. */
  const [unqualifiedMove, setUnqualifiedMove] = useState<
    { change: MoveChange; details: UnqualifiedDetail[] } | undefined
  >();

  const people = useMemo(
    () => [...(schedule.data?.people ?? [])].sort((a, b) => a.name.localeCompare(b.name, locale)),
    [schedule.data?.people, locale],
  );
  const colourIndex = useMemo(
    () => new Map(people.map((person, index) => [person.id, index])),
    [people],
  );
  const colourOf = (personId: string) => colourIndex.get(personId) ?? 0;
  const hasEngineers = people.some((person) => person.role === 'engineer');
  const isShown = (personId: string) =>
    prefs.hidden === undefined
      ? !hasEngineers || people.find((person) => person.id === personId)?.role === 'engineer'
      : !prefs.hidden.includes(personId);

  const jobs = useMemo(() => {
    const byId = new Map<string, ScheduleJob>();
    for (const entry of unscheduled.data ?? []) {
      byId.set(entry.workOrder.id, entry.workOrder);
    }
    for (const job of schedule.data?.workOrders ?? []) {
      byId.set(job.id, job);
    }
    return byId;
  }, [schedule.data?.workOrders, unscheduled.data]);
  const referenceOf = (workOrderId: string) => jobs.get(workOrderId)?.referenceLabel ?? '';
  const personName = (id: string) =>
    people.find((person) => person.id === id)?.name ??
    (schedule.data?.visits ?? [])
      .flatMap((visit) => visit.assignees)
      .find((person) => person.id === id)?.name ??
    '';

  const allVisits = schedule.data?.visits ?? [];
  const visits = allVisits.filter(
    (visit) =>
      (visit.status !== 'cancelled' || prefs.showCancelled) &&
      (visit.assignees.length === 0
        ? prefs.showNobody
        : visit.assignees.some((person) => isShown(person.id))),
  );

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['work-orders'] });
  };

  // ---- Moving one visit ---------------------------------------------------

  const scheduleKey = keys.schedule(rangeKey);
  const move = useMutation({
    mutationFn: async (change: MoveChange) =>
      (
        await client.PATCH('/v1/visits/{visitId}', {
          params: { path: { visitId: change.visit.id } },
          body: {
            expectedRevision: change.visit.revision,
            startsAt: change.startsAt.toISOString(),
            endsAt: change.endsAt.toISOString(),
            ...(change.reason === undefined
              ? {}
              : { qualificationOverride: { reason: change.reason } }),
          },
        })
      ).data!.visit,
    onMutate: async (change) => {
      setMoveError(undefined);
      await queryClient.cancelQueries({ queryKey: scheduleKey });
      const before = change.before ?? queryClient.getQueryData<Schedule>(scheduleKey);
      queryClient.setQueryData<Schedule>(scheduleKey, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              visits: current.visits.map((visit) =>
                visit.id === change.visit.id
                  ? {
                      ...visit,
                      startsAt: change.startsAt.toISOString(),
                      endsAt: change.endsAt.toISOString(),
                    }
                  : visit,
              ),
            },
      );
      return { before };
    },
    onError: (error, change, context) => {
      if (change.reason === undefined && isUnqualified(error)) {
        // Keep the move on screen and ask why; cancelling puts it back.
        setUnqualifiedMove({
          change: { ...change, before: context?.before },
          details: unqualifiedDetails(error),
        });
        return;
      }
      if (context?.before !== undefined) {
        queryClient.setQueryData(scheduleKey, context.before);
      }
      setMoveError(error);
      refresh();
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<Schedule>(scheduleKey, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              visits: current.visits.map((visit) => (visit.id === saved.id ? saved : visit)),
            },
      );
    },
  });

  // ---- Dragging -------------------------------------------------------------

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );

  const onDragStart = ({ active }: DragStartEvent) => {
    setResizeBy(0);
    setDragging(active.data.current as Dragging | undefined);
  };

  const onDragMove = ({ active, delta }: DragMoveEvent) => {
    if ((active.data.current as Dragging | undefined)?.kind === 'resize') {
      setResizeBy(snapMinutes(delta.y / PX_PER_MINUTE));
    }
  };

  const onDragEnd = ({ active, over, delta }: DragEndEvent) => {
    const what = active.data.current as Dragging | undefined;
    setDragging(undefined);
    setResizeBy(0);
    if (what === undefined) {
      return;
    }
    if (what.kind === 'resize') {
      const start = new Date(what.visit.startsAt);
      const end = new Date(what.visit.endsAt);
      const next = addMinutes(end, snapMinutes(delta.y / PX_PER_MINUTE));
      const earliest = addMinutes(start, 15);
      const endsAt = next.getTime() < earliest.getTime() ? earliest : next;
      if (endsAt.getTime() !== end.getTime()) {
        move.mutate({ visit: what.visit, startsAt: start, endsAt });
      }
      return;
    }
    if (over === null) {
      return;
    }
    const [target, key] = String(over.id).split(':') as ['day' | 'month', string];
    const day = fromDayKey(key);
    if (what.kind === 'visit') {
      const days = Math.round(
        (startOfDay(day).getTime() - startOfDay(fromDayKey(what.day)).getTime()) / 86_400_000,
      );
      const minutes = target === 'day' ? snapMinutes(delta.y / PX_PER_MINUTE) : 0;
      if (days === 0 && minutes === 0) {
        return;
      }
      move.mutate({
        visit: what.visit,
        startsAt: addMinutes(addDays(new Date(what.visit.startsAt), days), minutes),
        endsAt: addMinutes(addDays(new Date(what.visit.endsAt), days), minutes),
      });
      return;
    }
    // A job dropped on a day: plan a visit there, after asking who goes.
    let startsAt: Date;
    if (target === 'day') {
      const top = (active.rect.current.translated?.top ?? over.rect.top) - over.rect.top;
      const minutes = Math.min(Math.max(snapMinutes(top / PX_PER_MINUTE), 0), DAY_MINUTES - 15);
      startsAt = addMinutes(startOfDay(day), minutes);
    } else {
      startsAt = addMinutes(startOfDay(day), schedule.data?.settings.workDayStarts ?? 8 * 60);
    }
    openNew(what.entry, startsAt);
  };

  const openNew = (entry: UnscheduledJob, startsAt: Date) => {
    setDialog({
      kind: 'new',
      job: entry.workOrder,
      startsAt,
      endsAt: addMinutes(startsAt, entry.expectedDurationMinutes ?? DEFAULT_VISIT_DURATION_MINUTES),
    });
  };

  /** Where "Plan a visit" starts: now, rounded up, on today; else the shown day's working start. */
  const suggestedStart = (): Date => {
    const now = new Date();
    if (now.getTime() >= range.from.getTime() && now.getTime() < range.to.getTime()) {
      return addMinutes(
        startOfDay(now),
        Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15,
      );
    }
    return addMinutes(range.from, schedule.data?.settings.workDayStarts ?? 8 * 60);
  };

  // ---- Clicking -------------------------------------------------------------

  const onVisitClick = (visit: ScheduleVisit, event: ReactMouseEvent) => {
    if (canPlan && (event.ctrlKey || event.metaKey || event.shiftKey)) {
      event.preventDefault();
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(visit.id)) {
          next.delete(visit.id);
        } else if (visit.status === 'planned') {
          next.add(visit.id);
        }
        return next;
      });
      return;
    }
    const job = jobs.get(visit.workOrderId);
    if (job !== undefined) {
      setDialog({ kind: 'edit', job, visit });
    }
  };

  const selectVisitsOf = (personId: string) => {
    setSelected(
      new Set(
        visits
          .filter(
            (visit) =>
              visit.status === 'planned' &&
              visit.assignees.some((person) => person.id === personId),
          )
          .map((visit) => visit.id),
      ),
    );
    setSelectionFrom(personId);
  };

  const togglePerson = (personId: string, show: boolean) => {
    const hidden = new Set(
      prefs.hidden ?? people.filter((person) => !isShown(person.id)).map((person) => person.id),
    );
    if (show) {
      hidden.delete(personId);
    } else {
      hidden.add(personId);
    }
    setPrefs({ ...prefs, hidden: [...hidden] });
  };

  // ---- Drawing --------------------------------------------------------------

  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const title = rangeTitle(prefs.mode, range.days, locale);

  return (
    <div className="flex flex-col gap-4">
      <DashboardBackLink />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-content">{t('operations.schedule.title')}</h1>
          <p className="text-sm text-content-muted">
            {canPlan ? t('operations.schedule.intro') : t('operations.schedule.readOnly')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => setAnchor(startOfDay(new Date()))}
          >
            {t('operations.schedule.today')}
          </button>
          <div className="flex items-center">
            <button
              type="button"
              className={buttonClass.ghost}
              aria-label={t('operations.schedule.previous')}
              onClick={() => setAnchor(stepAnchor(prefs.mode, anchor, -1))}
            >
              <span aria-hidden="true" className="inline-block rtl:rotate-180">
                ‹
              </span>
            </button>
            <button
              type="button"
              className={buttonClass.ghost}
              aria-label={t('operations.schedule.next')}
              onClick={() => setAnchor(stepAnchor(prefs.mode, anchor, 1))}
            >
              <span aria-hidden="true" className="inline-block rtl:rotate-180">
                ›
              </span>
            </button>
          </div>
          <h2 aria-live="polite" className="min-w-40 text-lg font-medium text-content">
            {title}
          </h2>
          <div
            role="group"
            aria-label={t('operations.schedule.view')}
            className="inline-flex rounded-md border border-border-subtle"
          >
            {VIEW_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={prefs.mode === mode}
                className={`px-3 py-1.5 text-sm ${
                  prefs.mode === mode
                    ? 'bg-accent text-on-accent'
                    : 'bg-surface text-content hover:bg-surface-muted'
                } first:rounded-s-md last:rounded-e-md`}
                onClick={() => setPrefs({ ...prefs, mode })}
              >
                {t(`operations.schedule.views.${mode}`)}
              </button>
            ))}
          </div>
        </div>
      </header>

      {schedule.data !== undefined && schedule.data.settings.timezone !== deviceZone ? (
        <p className="text-xs text-content-muted">
          {t('operations.schedule.timeZone', {
            zone: deviceZone,
            company: schedule.data.settings.timezone,
          })}
        </p>
      ) : null}

      {moveError !== undefined ? (
        <Failure
          error={moveError}
          actions={
            <button
              type="button"
              className={buttonClass.ghost}
              onClick={() => setMoveError(undefined)}
            >
              {t('operations.schedule.dialog.close')}
            </button>
          }
        />
      ) : null}

      {selected.size > 0 ? (
        <SelectionBar
          // A new "select their visits" starts the bar afresh, with that person to replace.
          key={selectionFrom ?? ''}
          selected={[...selected]}
          visits={allVisits}
          people={people}
          from={selectionFrom}
          referenceOf={referenceOf}
          personName={personName}
          onClear={() => {
            setSelected(new Set());
            setSelectionFrom(undefined);
          }}
          onDone={refresh}
        />
      ) : null}

      {schedule.isError && schedule.data === undefined ? (
        <Failure error={schedule.error} onRetry={() => void schedule.refetch()} />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onDragCancel={() => {
            setDragging(undefined);
            setResizeBy(0);
          }}
        >
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
            <aside className="flex w-full shrink-0 flex-col gap-4 lg:w-72">
              <PeoplePanel
                people={people}
                colourOf={colourOf}
                isShown={isShown}
                prefs={prefs}
                canPlan={canPlan}
                onToggle={togglePerson}
                onAll={(show) =>
                  setPrefs({ ...prefs, hidden: show ? [] : people.map((person) => person.id) })
                }
                onPrefs={setPrefs}
                onSelectVisits={selectVisitsOf}
              />
              <UnscheduledPanel
                query={unscheduled}
                canPlan={canPlan}
                onPlan={(entry) => openNew(entry, suggestedStart())}
              />
            </aside>
            <section
              aria-label={title}
              className="min-w-0 flex-1 overflow-hidden rounded-lg border border-border-subtle bg-surface"
            >
              {schedule.data === undefined ? (
                <Loading />
              ) : prefs.mode === 'month' ? (
                <MonthGrid
                  days={range.days}
                  anchor={anchor}
                  visits={visits}
                  jobs={jobs}
                  colourOf={colourOf}
                  canPlan={canPlan}
                  selected={selected}
                  onVisitClick={onVisitClick}
                  onShowDay={(day) => {
                    setAnchor(day);
                    setPrefs({ ...prefs, mode: 'day' });
                  }}
                />
              ) : (
                <TimeGrid
                  days={range.days}
                  visits={visits}
                  jobs={jobs}
                  settings={schedule.data.settings}
                  colourOf={colourOf}
                  canPlan={canPlan}
                  selected={selected}
                  resizing={
                    dragging?.kind === 'resize'
                      ? { id: dragging.visit.id, by: resizeBy }
                      : undefined
                  }
                  onVisitClick={onVisitClick}
                />
              )}
            </section>
          </div>
          <DragOverlay dropAnimation={null}>
            {dragging === undefined || dragging.kind === 'resize' ? null : dragging.kind ===
              'job' ? (
              <JobCard entry={dragging.entry} overlay />
            ) : (
              <div className="w-40 rounded-md border border-accent bg-surface px-2 py-1 text-xs text-content shadow-lg">
                {referenceOf(dragging.visit.workOrderId)}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {unqualifiedMove === undefined ? null : (
        <UnqualifiedPrompt
          intro={t('operations.qualifications.override.moveIntro', {
            reference: referenceOf(unqualifiedMove.change.visit.workOrderId),
          })}
          cancelLabel={t('operations.qualifications.override.undoMove')}
          pending={move.isPending}
          onCancel={() => {
            const { before } = unqualifiedMove.change;
            if (before !== undefined) {
              queryClient.setQueryData(scheduleKey, before);
            }
            setUnqualifiedMove(undefined);
            refresh();
          }}
          onConfirm={(reason) => {
            const { change } = unqualifiedMove;
            setUnqualifiedMove(undefined);
            move.mutate({ ...change, reason });
          }}
        >
          <GapList gaps={gapsFromDetails(unqualifiedMove.details, personName)} />
        </UnqualifiedPrompt>
      )}

      {dialog === undefined ? null : (
        <VisitDialog
          key={dialog.kind === 'edit' ? dialog.visit.id : `new-${dialog.job.id}`}
          target={dialog}
          people={people}
          colourOf={colourOf}
          visits={allVisits}
          referenceOf={referenceOf}
          canPlan={canPlan}
          onClose={() => setDialog(undefined)}
          onSaved={() => {
            setDialog(undefined);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function rangeTitle(mode: ViewMode, days: readonly Date[], locale: string): string {
  const first = days[0]!;
  if (mode === 'day') {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(first);
  }
  if (mode === 'month') {
    // The month the middle of the grid belongs to.
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
      days[Math.floor(days.length / 2)],
    );
  }
  const format = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return format.formatRange(first, days.at(-1)!);
}

// ---------------------------------------------------------------------------
// The sidebar
// ---------------------------------------------------------------------------

function PeoplePanel({
  people,
  colourOf,
  isShown,
  prefs,
  canPlan,
  onToggle,
  onAll,
  onPrefs,
  onSelectVisits,
}: {
  people: readonly SchedulePerson[];
  colourOf: (id: string) => number;
  isShown: (id: string) => boolean;
  prefs: Prefs;
  canPlan: boolean;
  onToggle: (id: string, show: boolean) => void;
  onAll: (show: boolean) => void;
  onPrefs: (prefs: Prefs) => void;
  onSelectVisits: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-labelledby="schedule-people"
      className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="schedule-people" className="text-sm font-semibold text-content">
          {t('operations.schedule.people')}
        </h2>
        <div className="flex gap-1">
          <button type="button" className={buttonClass.ghost} onClick={() => onAll(true)}>
            {t('operations.schedule.allPeople')}
          </button>
          <button type="button" className={buttonClass.ghost} onClick={() => onAll(false)}>
            {t('operations.schedule.noPeople')}
          </button>
        </div>
      </div>
      <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
        {people.map((person) => (
          <li key={person.id} className="group flex items-center gap-1">
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-surface-muted">
              <input
                type="checkbox"
                checked={isShown(person.id)}
                onChange={(event) => onToggle(person.id, event.target.checked)}
              />
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: personColour(colourOf(person.id)) }}
              />
              <span dir="auto" className="truncate text-content">
                {person.name}
              </span>
            </label>
            {canPlan ? (
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-xs text-accent hover:bg-surface-muted"
                aria-label={t('operations.schedule.selectVisits', { name: person.name })}
                title={t('operations.schedule.selectVisits', { name: person.name })}
                onClick={() => onSelectVisits(person.id)}
              >
                <span aria-hidden="true">☑</span>
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <label className="flex items-center gap-2 px-1.5 text-sm text-content">
        <input
          type="checkbox"
          checked={prefs.showNobody}
          onChange={(event) => onPrefs({ ...prefs, showNobody: event.target.checked })}
        />
        {t('operations.schedule.nobodyOnVisit')}
      </label>
      <label className="flex items-center gap-2 px-1.5 text-sm text-content">
        <input
          type="checkbox"
          checked={prefs.showCancelled}
          onChange={(event) => onPrefs({ ...prefs, showCancelled: event.target.checked })}
        />
        {t('operations.schedule.showCancelled')}
      </label>
    </section>
  );
}

function UnscheduledPanel({
  query,
  canPlan,
  onPlan,
}: {
  query: { data?: UnscheduledJob[] | undefined; isError: boolean; refetch: () => unknown };
  canPlan: boolean;
  onPlan: (entry: UnscheduledJob) => void;
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-labelledby="schedule-unscheduled"
      className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface p-3"
    >
      <h2 id="schedule-unscheduled" className="text-sm font-semibold text-content">
        {t('operations.schedule.unscheduled')}
      </h2>
      <p className="text-xs text-content-muted">{t('operations.schedule.unscheduledHint')}</p>
      {query.isError ? (
        <InlineError onRetry={() => void query.refetch()} />
      ) : query.data === undefined ? (
        <Loading />
      ) : query.data.length === 0 ? (
        <p className="text-sm text-content-muted">{t('operations.schedule.unscheduledEmpty')}</p>
      ) : (
        <ul className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto">
          {query.data.map((entry) => (
            <li key={entry.workOrder.id}>
              <DraggableJob entry={entry} canPlan={canPlan} onPlan={onPlan} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DraggableJob({
  entry,
  canPlan,
  onPlan,
}: {
  entry: UnscheduledJob;
  canPlan: boolean;
  onPlan: (entry: UnscheduledJob) => void;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `job:${entry.workOrder.id}`,
    data: { kind: 'job', entry } satisfies Dragging,
    disabled: !canPlan,
  });
  return (
    <div className={isDragging ? 'opacity-40' : ''}>
      <div ref={setNodeRef} {...listeners} {...attributes} tabIndex={-1} role="presentation">
        <JobCard entry={entry} />
      </div>
      {canPlan ? (
        <button
          type="button"
          className="mt-1 text-xs font-medium text-accent underline-offset-4 hover:underline"
          onClick={() => onPlan(entry)}
        >
          {t('operations.schedule.plan')}{' '}
          <span className="sr-only">{entry.workOrder.referenceLabel}</span>
        </button>
      ) : null}
    </div>
  );
}

function JobCard({ entry, overlay = false }: { entry: UnscheduledJob; overlay?: boolean }) {
  const { t } = useTranslation();
  const duration = useDuration();
  const job = entry.workOrder;
  return (
    <div
      className={`flex cursor-grab flex-col gap-0.5 rounded-md border border-border-subtle bg-surface-muted px-2 py-1.5 text-start text-xs ${
        overlay ? 'w-56 shadow-lg' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-content">{job.referenceLabel}</span>
        <PriorityBadge priority={job.priority} />
      </div>
      <span dir="auto" className="truncate text-content">
        {job.title}
      </span>
      <span dir="auto" className="truncate text-content-muted">
        {job.site.name}
      </span>
      {entry.expectedDurationMinutes === null ? null : (
        <span className="text-content-muted">
          {t('operations.schedule.expected', {
            duration: duration(entry.expectedDurationMinutes * 60_000),
          })}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The day and week grid
// ---------------------------------------------------------------------------

const GRID_HEIGHT = DAY_MINUTES * PX_PER_MINUTE;

function TimeGrid({
  days,
  visits,
  jobs,
  settings,
  colourOf,
  canPlan,
  selected,
  resizing,
  onVisitClick,
}: {
  days: readonly Date[];
  visits: readonly ScheduleVisit[];
  jobs: ReadonlyMap<string, ScheduleJob>;
  settings: Schedule['settings'];
  colourOf: (id: string) => number;
  canPlan: boolean;
  selected: ReadonlySet<string>;
  resizing: { id: string; by: number } | undefined;
  onVisitClick: (visit: ScheduleVisit, event: ReactMouseEvent) => void;
}) {
  const { locale } = useOperations();
  const scroller = useRef<HTMLDivElement>(null);
  const startsAt = settings.workDayStarts;
  useEffect(() => {
    if (scroller.current !== null) {
      scroller.current.scrollTop = Math.max(startsAt - 60, 0) * PX_PER_MINUTE;
    }
  }, [startsAt, days.length]);

  const hourFormat = new Intl.DateTimeFormat(locale, { hour: 'numeric' });
  const dayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric' });
  const today = new Date();

  return (
    <div className="flex flex-col">
      <div className="flex border-b border-border-subtle">
        <div className="w-14 shrink-0" />
        {days.map((day) => (
          <div
            key={dayKey(day)}
            className={`flex-1 border-s border-border-subtle px-2 py-1.5 text-center text-sm ${
              sameDay(day, today) ? 'font-semibold text-accent' : 'text-content'
            }`}
          >
            {dayFormat.format(day)}
          </div>
        ))}
      </div>
      <div ref={scroller} className="relative max-h-[70dvh] overflow-y-auto">
        <div className="flex" style={{ height: GRID_HEIGHT }}>
          <div aria-hidden="true" className="relative w-14 shrink-0">
            {Array.from({ length: 24 }, (_, hour) => (
              <span
                key={hour}
                className="absolute end-1 -translate-y-1/2 text-[0.65rem] text-content-muted"
                style={{ top: hour * 60 * PX_PER_MINUTE }}
              >
                {hour === 0 ? '' : hourFormat.format(new Date(2000, 0, 1, hour))}
              </span>
            ))}
          </div>
          {days.map((day) => (
            <DayColumn
              key={dayKey(day)}
              day={day}
              visits={visits}
              jobs={jobs}
              settings={settings}
              colourOf={colourOf}
              canPlan={canPlan}
              selected={selected}
              resizing={resizing}
              onVisitClick={onVisitClick}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DayColumn({
  day,
  visits,
  jobs,
  settings,
  colourOf,
  canPlan,
  selected,
  resizing,
  onVisitClick,
}: {
  day: Date;
  visits: readonly ScheduleVisit[];
  jobs: ReadonlyMap<string, ScheduleJob>;
  settings: Schedule['settings'];
  colourOf: (id: string) => number;
  canPlan: boolean;
  selected: ReadonlySet<string>;
  resizing: { id: string; by: number } | undefined;
  onVisitClick: (visit: ScheduleVisit, event: ReactMouseEvent) => void;
}) {
  const { locale } = useOperations();
  const key = dayKey(day);
  const { setNodeRef, isOver } = useDroppable({ id: `day:${key}` });
  const isoWeekday = day.getDay() === 0 ? 7 : day.getDay();
  const working = settings.workingDays.includes(isoWeekday);

  const placed = visits.flatMap((visit) => {
    const end = new Date(visit.endsAt);
    const span = {
      id: visit.id,
      start: new Date(visit.startsAt),
      end: resizing?.id === visit.id ? addMinutes(end, resizing.by) : end,
    };
    const segment = segmentOn(span, day);
    return segment === undefined ? [] : [{ visit, span, segment }];
  });
  const lanes = layoutLanes(
    placed.map(({ span, segment }) => ({
      id: span.id,
      start: addMinutes(startOfDay(day), segment.top),
      end: addMinutes(startOfDay(day), segment.top + segment.length),
    })),
  );
  const now = new Date();
  const nowMinutes = sameDay(now, day) ? now.getHours() * 60 + now.getMinutes() : undefined;
  const dayLabel = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(day);

  return (
    <div
      ref={setNodeRef}
      role="group"
      aria-label={dayLabel}
      className={`relative flex-1 border-s border-border-subtle ${isOver ? 'bg-accent/5' : ''}`}
    >
      {/* The company's working day, shaded: a guide, never a rule. */}
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 bg-surface-muted/60"
        style={{ height: working ? settings.workDayStarts * PX_PER_MINUTE : GRID_HEIGHT }}
      />
      {working ? (
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 bg-surface-muted/60"
          style={{ height: Math.max(DAY_MINUTES - settings.workDayEnds, 0) * PX_PER_MINUTE }}
        />
      ) : null}
      {Array.from({ length: 23 }, (_, hour) => (
        <div
          key={hour}
          aria-hidden="true"
          className="absolute inset-x-0 border-t border-border-subtle/60"
          style={{ top: (hour + 1) * 60 * PX_PER_MINUTE }}
        />
      ))}
      {nowMinutes === undefined ? null : (
        <div
          aria-hidden="true"
          className="absolute inset-x-0 z-20 border-t-2 border-danger"
          style={{ top: nowMinutes * PX_PER_MINUTE }}
        />
      )}
      {placed.map(({ visit, segment }) => {
        const lane = lanes.get(visit.id) ?? { lane: 0, lanes: 1 };
        return (
          <VisitBlock
            key={visit.id}
            visit={visit}
            job={jobs.get(visit.workOrderId)}
            day={key}
            colourOf={colourOf}
            canPlan={canPlan}
            selected={selected.has(visit.id)}
            onClick={onVisitClick}
            style={{
              top: segment.top * PX_PER_MINUTE,
              height: Math.max(segment.length * PX_PER_MINUTE, 18),
              insetInlineStart: `calc(${String((lane.lane / lane.lanes) * 100)}% + 2px)`,
              width: `calc(${String(100 / lane.lanes)}% - 4px)`,
            }}
            resizable={!segment.continuesTo}
            continuesFrom={segment.continuesFrom}
            continuesTo={segment.continuesTo}
          />
        );
      })}
    </div>
  );
}

function useVisitText(visit: ScheduleVisit, job: ScheduleJob | undefined) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  const times = time.formatRange(new Date(visit.startsAt), new Date(visit.endsAt));
  const names =
    visit.assignees.length === 0
      ? t('operations.schedule.nobody')
      : visit.assignees.map((person) => person.name).join(', ');
  const status =
    visit.status === 'done'
      ? t('operations.schedule.done')
      : visit.status === 'cancelled'
        ? t('operations.schedule.cancelled')
        : '';
  const warnings = visit.warnings.map((warning) =>
    warning === 'unqualified' && visit.qualificationGaps.length > 0
      ? t('operations.schedule.warning.unqualifiedNamed', {
          list: visit.qualificationGaps
            .map((gap) => gap.name)
            .join(t('operations.qualifications.listSeparator')),
        })
      : t(`operations.schedule.warning.${warning}`),
  );
  const label = [
    t('operations.schedule.visitLabel', {
      reference: job?.referenceLabel ?? '',
      title: job?.title ?? '',
      time: times,
      people: names,
    }),
    status,
    ...warnings,
  ]
    .filter((part) => part !== '')
    .join('. ');
  return { times, names, label, warnings };
}

function VisitBlock({
  visit,
  job,
  day,
  colourOf,
  canPlan,
  selected,
  onClick,
  style,
  resizable,
  continuesFrom,
  continuesTo,
}: {
  visit: ScheduleVisit;
  job: ScheduleJob | undefined;
  day: string;
  colourOf: (id: string) => number;
  canPlan: boolean;
  selected: boolean;
  onClick: (visit: ScheduleVisit, event: ReactMouseEvent) => void;
  style: CSSProperties;
  resizable: boolean;
  continuesFrom: boolean;
  continuesTo: boolean;
}) {
  const { t } = useTranslation();
  const movable = canPlan && visit.status === 'planned';
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `visit:${visit.id}:${day}`,
    data: { kind: 'visit', visit, day } satisfies Dragging,
    disabled: !movable,
  });
  const {
    attributes: resizeAttributes,
    listeners: resizeListeners,
    setNodeRef: setResizeRef,
  } = useDraggable({
    id: `resize:${visit.id}`,
    data: { kind: 'resize', visit } satisfies Dragging,
    disabled: !movable || !resizable,
  });
  const text = useVisitText(visit, job);
  const first = visit.assignees[0];
  return (
    <div className={`absolute z-10 ${isDragging ? 'opacity-40' : ''}`} style={style}>
      <button
        ref={setNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={text.label}
        aria-pressed={selected}
        onClick={(event) => onClick(visit, event)}
        className={`flex size-full flex-col overflow-hidden rounded-md border border-border-subtle bg-surface px-1.5 py-1 text-start text-xs shadow-sm ${
          movable ? 'cursor-grab' : 'cursor-pointer'
        } ${selected ? 'ring-2 ring-accent' : ''} ${
          visit.status === 'cancelled' ? 'line-through opacity-60' : ''
        } ${visit.status === 'done' ? 'opacity-70' : ''} ${continuesFrom ? 'rounded-t-none' : ''} ${
          continuesTo ? 'rounded-b-none' : ''
        }`}
        style={{
          borderInlineStartWidth: 4,
          borderInlineStartColor:
            first === undefined ? 'var(--color-border-subtle)' : personColour(colourOf(first.id)),
        }}
      >
        <span className="flex items-center gap-1 font-medium text-content">
          {visit.status === 'done' ? <span aria-hidden="true">✓</span> : null}
          {text.warnings.length > 0 ? (
            <span aria-hidden="true" className="text-warning" title={text.warnings.join('\n')}>
              ⚠
            </span>
          ) : null}
          <span className="truncate">{job?.referenceLabel}</span>
        </span>
        <span dir="auto" className="truncate text-content">
          {job?.title}
        </span>
        <span className="truncate text-content-muted">{text.times}</span>
        <span className="mt-auto flex flex-wrap gap-0.5">
          {visit.assignees.map((person) => (
            <span
              key={person.id}
              aria-hidden="true"
              className="rounded px-1 text-[0.6rem] font-semibold text-white"
              style={{ backgroundColor: personColour(colourOf(person.id)) }}
              title={person.name}
            >
              {initials(person.name)}
            </span>
          ))}
        </span>
      </button>
      {movable && resizable ? (
        <div
          ref={setResizeRef}
          {...resizeListeners}
          {...resizeAttributes}
          // A pointer's shortcut only: the visit's dialog sets the end from the keyboard.
          role={undefined}
          tabIndex={-1}
          aria-hidden="true"
          title={t('operations.schedule.resize', { reference: job?.referenceLabel ?? '' })}
          className="absolute inset-x-1 bottom-0 h-2 cursor-ns-resize rounded-b-md hover:bg-accent/40"
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The month grid
// ---------------------------------------------------------------------------

const MONTH_SHOWN = 3;

function MonthGrid({
  days,
  anchor,
  visits,
  jobs,
  colourOf,
  canPlan,
  selected,
  onVisitClick,
  onShowDay,
}: {
  days: readonly Date[];
  anchor: Date;
  visits: readonly ScheduleVisit[];
  jobs: ReadonlyMap<string, ScheduleJob>;
  colourOf: (id: string) => number;
  canPlan: boolean;
  selected: ReadonlySet<string>;
  onVisitClick: (visit: ScheduleVisit, event: ReactMouseEvent) => void;
  onShowDay: (day: Date) => void;
}) {
  const { locale } = useOperations();
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-7 border-b border-border-subtle">
        {days.slice(0, 7).map((day) => (
          <div
            key={dayKey(day)}
            className="px-2 py-1.5 text-center text-xs font-medium text-content-muted"
          >
            {weekday.format(day)}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day) => (
          <MonthCell
            key={dayKey(day)}
            day={day}
            inMonth={day.getMonth() === anchor.getMonth()}
            visits={visits.filter(
              (visit) =>
                segmentOn(
                  { id: visit.id, start: new Date(visit.startsAt), end: new Date(visit.endsAt) },
                  day,
                ) !== undefined,
            )}
            jobs={jobs}
            colourOf={colourOf}
            canPlan={canPlan}
            selected={selected}
            onVisitClick={onVisitClick}
            onShowDay={onShowDay}
          />
        ))}
      </div>
    </div>
  );
}

function MonthCell({
  day,
  inMonth,
  visits,
  jobs,
  colourOf,
  canPlan,
  selected,
  onVisitClick,
  onShowDay,
}: {
  day: Date;
  inMonth: boolean;
  visits: readonly ScheduleVisit[];
  jobs: ReadonlyMap<string, ScheduleJob>;
  colourOf: (id: string) => number;
  canPlan: boolean;
  selected: ReadonlySet<string>;
  onVisitClick: (visit: ScheduleVisit, event: ReactMouseEvent) => void;
  onShowDay: (day: Date) => void;
}) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const key = dayKey(day);
  const { setNodeRef, isOver } = useDroppable({ id: `month:${key}` });
  const label = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(day);
  const sorted = [...visits].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  return (
    <div
      ref={setNodeRef}
      role="group"
      aria-label={label}
      className={`flex min-h-28 flex-col gap-1 border-b border-s border-border-subtle p-1 ${
        inMonth ? '' : 'bg-surface-muted/60'
      } ${isOver ? 'bg-accent/5' : ''}`}
    >
      <button
        type="button"
        className={`self-start rounded px-1 text-xs ${
          sameDay(day, new Date()) ? 'bg-accent font-semibold text-on-accent' : 'text-content-muted'
        } hover:underline`}
        onClick={() => onShowDay(day)}
      >
        {new Intl.DateTimeFormat(locale, { day: 'numeric' }).format(day)}
      </button>
      {sorted.slice(0, MONTH_SHOWN).map((visit) => (
        <MonthChip
          key={visit.id}
          visit={visit}
          job={jobs.get(visit.workOrderId)}
          day={key}
          colourOf={colourOf}
          canPlan={canPlan}
          selected={selected.has(visit.id)}
          onClick={onVisitClick}
        />
      ))}
      {sorted.length > MONTH_SHOWN ? (
        <button
          type="button"
          className="self-start px-1 text-xs text-accent hover:underline"
          onClick={() => onShowDay(day)}
        >
          {t('operations.schedule.more', { count: sorted.length - MONTH_SHOWN })}
        </button>
      ) : null}
    </div>
  );
}

function MonthChip({
  visit,
  job,
  day,
  colourOf,
  canPlan,
  selected,
  onClick,
}: {
  visit: ScheduleVisit;
  job: ScheduleJob | undefined;
  day: string;
  colourOf: (id: string) => number;
  canPlan: boolean;
  selected: boolean;
  onClick: (visit: ScheduleVisit, event: ReactMouseEvent) => void;
}) {
  const { locale } = useOperations();
  const movable = canPlan && visit.status === 'planned';
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `visit:${visit.id}:${day}`,
    data: { kind: 'visit', visit, day } satisfies Dragging,
    disabled: !movable,
  });
  const text = useVisitText(visit, job);
  const first = visit.assignees[0];
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      aria-label={text.label}
      aria-pressed={selected}
      onClick={(event) => onClick(visit, event)}
      className={`flex items-center gap-1 truncate rounded border border-border-subtle bg-surface px-1 py-0.5 text-start text-[0.7rem] text-content ${
        selected ? 'ring-2 ring-accent' : ''
      } ${isDragging ? 'opacity-40' : ''} ${visit.status === 'cancelled' ? 'line-through opacity-60' : ''}`}
      style={{
        borderInlineStartWidth: 3,
        ...(first === undefined
          ? {}
          : { borderInlineStartColor: personColour(colourOf(first.id)) }),
      }}
    >
      {visit.status === 'done' ? <span aria-hidden="true">✓</span> : null}
      <span className="shrink-0 text-content-muted">
        {new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(
          new Date(visit.startsAt),
        )}
      </span>
      <span className="truncate">{job?.referenceLabel}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Many at once
// ---------------------------------------------------------------------------

const SHIFTS = [
  ['m15', 15],
  ['m30', 30],
  ['h1', 60],
  ['h2', 120],
  ['d1', 24 * 60],
  ['w1', 7 * 24 * 60],
] as const;

function SelectionBar({
  selected,
  visits,
  people,
  from,
  referenceOf,
  personName,
  onClear,
  onDone,
}: {
  selected: readonly string[];
  visits: readonly ScheduleVisit[];
  people: readonly SchedulePerson[];
  from: string | undefined;
  referenceOf: (workOrderId: string) => string;
  personName: (id: string) => string;
  onClear: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const [action, setAction] = useState<'reassign' | 'move' | 'cancel'>('reassign');
  const [replace, setReplace] = useState(from ?? '');
  const [withPerson, setWithPerson] = useState('');
  const [shift, setShift] = useState<number>(60);
  const [reason, setReason] = useState('');
  const [results, setResults] = useState<BulkVisitResult[] | undefined>();
  /** Visits refused for want of a qualification (P26), waiting for one reason for them all. */
  const [asking, setAsking] = useState<{ visitIds: string[]; direction: 1 | -1 } | undefined>();

  const run = useMutation({
    mutationFn: async (input: {
      direction: 1 | -1;
      visitIds?: readonly string[];
      overrideReason?: string;
    }) => {
      const header = { 'Idempotency-Key': crypto.randomUUID() };
      const visitIds = [...(input.visitIds ?? selected)];
      const override =
        input.overrideReason === undefined
          ? {}
          : { qualificationOverrideReason: input.overrideReason };
      const body =
        action === 'reassign'
          ? {
              action: 'reassign' as const,
              visitIds,
              toUserId: withPerson,
              ...(replace === '' ? {} : { fromUserId: replace }),
              ...override,
            }
          : action === 'move'
            ? {
                action: 'shift' as const,
                visitIds,
                shiftMinutes: shift * input.direction,
                ...override,
              }
            : {
                action: 'cancel' as const,
                visitIds,
                reason: reason.trim() === '' ? null : reason.trim(),
              };
      return (await client.POST('/v1/visits/bulk', { params: { header }, body })).data!.results;
    },
    onSuccess: (outcome, input) => {
      // A second try for some visits replaces what the first said about them.
      const merged =
        input.visitIds === undefined || results === undefined
          ? outcome
          : results.map(
              (result) => outcome.find((next) => next.visitId === result.visitId) ?? result,
            );
      setResults(merged);
      onDone();
      const unqualified = outcome
        .filter((result) => result.outcome === 'refused' && result.code === 'visit_unqualified')
        .map((result) => result.visitId);
      if (input.overrideReason === undefined && unqualified.length > 0) {
        setAsking({ visitIds: unqualified, direction: input.direction });
      }
      if (merged.every((result) => result.outcome === 'changed')) {
        onClear();
      }
    },
  });
  const time = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  const refused = (results ?? []).filter((result) => result.outcome === 'refused');
  const workOrderOf = (visitId: string) =>
    visits.find((visit) => visit.id === visitId)?.workOrderId ?? '';

  return (
    <section
      aria-label={t('operations.schedule.selection.count', { count: selected.length })}
      className="flex flex-col gap-2 rounded-lg border border-accent bg-surface p-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-content">
          {t('operations.schedule.selection.count', { count: selected.length })}
        </span>
        <div role="group" className="inline-flex rounded-md border border-border-subtle">
          {(['reassign', 'move', 'cancel'] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={action === key}
              className={`px-3 py-1 text-sm first:rounded-s-md last:rounded-e-md ${
                action === key
                  ? 'bg-accent text-on-accent'
                  : 'bg-surface text-content hover:bg-surface-muted'
              }`}
              onClick={() => setAction(key)}
            >
              {t(`operations.schedule.selection.${key}`)}
            </button>
          ))}
        </div>
        <button type="button" className={`${buttonClass.ghost} ms-auto`} onClick={onClear}>
          {t('operations.schedule.selection.clear')}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-2 text-sm">
        {action === 'reassign' ? (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-content-muted">
                {t('operations.schedule.selection.replace')}
              </span>
              <select
                className={inputClass}
                value={replace}
                onChange={(event) => setReplace(event.target.value)}
              >
                <option value="">{t('operations.schedule.selection.everyone')}</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-content-muted">
                {t('operations.schedule.selection.with')}
              </span>
              <select
                className={inputClass}
                value={withPerson}
                onChange={(event) => setWithPerson(event.target.value)}
              >
                <option value="" disabled>
                  —
                </option>
                {people
                  .filter((person) => person.id !== replace)
                  .map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              className={buttonClass.primary}
              disabled={withPerson === '' || run.isPending}
              onClick={() => run.mutate({ direction: 1 })}
            >
              {t('operations.schedule.selection.apply')}
            </button>
          </>
        ) : action === 'move' ? (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-content-muted">
                {t('operations.schedule.selection.moveBy')}
              </span>
              <select
                className={inputClass}
                value={shift}
                onChange={(event) => setShift(Number(event.target.value))}
              >
                {SHIFTS.map(([key, minutes]) => (
                  <option key={key} value={minutes}>
                    {t(`operations.schedule.selection.shift.${key}`)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={run.isPending}
              onClick={() => run.mutate({ direction: -1 })}
            >
              {t('operations.schedule.selection.earlier')}
            </button>
            <button
              type="button"
              className={buttonClass.secondary}
              disabled={run.isPending}
              onClick={() => run.mutate({ direction: 1 })}
            >
              {t('operations.schedule.selection.later')}
            </button>
          </>
        ) : (
          <>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs text-content-muted">
                {t('operations.schedule.selection.cancelReason')}
              </span>
              <input
                className={inputClass}
                value={reason}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <button
              type="button"
              className={buttonClass.danger}
              disabled={run.isPending}
              onClick={() => run.mutate({ direction: 1 })}
            >
              {t('operations.schedule.selection.cancel')}
            </button>
          </>
        )}
      </div>

      {run.isError ? <Failure error={run.error} /> : null}
      {results === undefined ? null : (
        <div role="status" className="flex flex-col gap-1 text-sm text-content">
          <p>
            {t('operations.schedule.selection.result', {
              changed: results.length - refused.length,
              refused: refused.length,
            })}
          </p>
          {refused.length > 0 ? (
            <ul className="list-disc ps-5">
              {refused.map((result) => (
                <li key={result.visitId}>
                  <RefusedLine
                    reference={referenceOf(workOrderOf(result.visitId))}
                    code={result.code}
                    message={result.message}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      {asking === undefined ? null : (
        <UnqualifiedPrompt
          intro={t('operations.qualifications.override.bulkIntro', {
            count: asking.visitIds.length,
          })}
          confirmLabel={t('operations.qualifications.override.confirmBulk')}
          pending={run.isPending}
          onCancel={() => setAsking(undefined)}
          onConfirm={(overrideReason) => {
            const { visitIds, direction } = asking;
            setAsking(undefined);
            run.mutate({ direction, visitIds, overrideReason });
          }}
        >
          <ul className="flex flex-col gap-1">
            {asking.visitIds.map((visitId) => {
              const visit = visits.find((entry) => entry.id === visitId);
              return (
                <li key={visitId} dir="auto">
                  {t('operations.qualifications.override.bulkLine', {
                    reference: referenceOf(visit?.workOrderId ?? ''),
                    time: visit === undefined ? '' : time.format(new Date(visit.startsAt)),
                    people:
                      action === 'reassign'
                        ? personName(withPerson)
                        : (visit?.assignees ?? []).map((person) => person.name).join(', '),
                  })}
                </li>
              );
            })}
          </ul>
        </UnqualifiedPrompt>
      )}
    </section>
  );
}

/** A refusal from the bulk endpoint, in the reader's language where the code is known. */
function RefusedLine({
  reference,
  code,
  message,
}: {
  reference: string;
  code: string | null;
  message: string | null;
}): ReactNode {
  const { t } = useTranslation();
  // The server's English is never shown when the catalogue has the code (ADR-0012).
  const text = (code === null ? undefined : apiErrorCodeMessage(code, t)) ?? message ?? '';
  return t('operations.schedule.selection.refused', { reference, message: text });
}
