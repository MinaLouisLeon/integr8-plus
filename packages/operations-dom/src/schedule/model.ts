/**
 * The calendar's arithmetic (P25), kept apart from React so it can be tested
 * on its own: which days a view shows, where a visit sits in a day, and how
 * overlapping visits share a day's width.
 *
 * Everything is in the device's own time zone, like every other date on these
 * screens. A dispatcher plans in the time they see on the wall.
 */

export type ViewMode = 'day' | 'week' | 'month';

export const VIEW_MODES: readonly ViewMode[] = ['day', 'week', 'month'];

export const MINUTE_MS = 60_000;
export const DAY_MINUTES = 24 * 60;

/** Pixels per minute in the day and week grids: 48 px an hour. */
export const PX_PER_MINUTE = 0.8;

export function startOfDay(date: Date): Date {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

/** Calendar days, not 24-hour steps, so a clock change does not shift the grid. */
export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** `2026-11-02`, in the device's time zone: a stable key for a day. */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

export function fromDayKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year!, month! - 1, day);
}

/**
 * The first day of the week where the reader is, as `Date#getDay()` numbers
 * it (0 is Sunday). From the browser where it knows; otherwise Saturday for
 * Arabic and Monday for everyone else.
 */
export function firstDayOfWeek(locale: string): number {
  try {
    // Newer engines have getWeekInfo(); some shipped it as a weekInfo property.
    // Both number Monday 1 to Sunday 7.
    const known = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = known.getWeekInfo?.() ?? known.weekInfo;
    if (info !== undefined) {
      return info.firstDay % 7;
    }
  } catch {
    // An unknown locale: fall through to the defaults.
  }
  return locale.startsWith('ar') ? 6 : 1;
}

export function startOfWeek(date: Date, firstDay: number): Date {
  const day = startOfDay(date);
  return addDays(day, -((day.getDay() - firstDay + 7) % 7));
}

export interface ViewRange {
  /** The first instant shown. */
  from: Date;
  /** The instant after the last one shown. */
  to: Date;
  /** Each day shown, in order. */
  days: Date[];
}

/**
 * The days a view shows around `anchor`: one day, the week containing it, or
 * the whole weeks covering its month.
 */
export function rangeFor(mode: ViewMode, anchor: Date, firstDay: number): ViewRange {
  let from: Date;
  let count: number;
  if (mode === 'day') {
    from = startOfDay(anchor);
    count = 1;
  } else if (mode === 'week') {
    from = startOfWeek(anchor, firstDay);
    count = 7;
  } else {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    from = startOfWeek(first, firstDay);
    const end = addDays(startOfWeek(last, firstDay), 7);
    count = Math.round((end.getTime() - from.getTime()) / (DAY_MINUTES * MINUTE_MS));
  }
  const days = Array.from({ length: count }, (_, index) => addDays(from, index));
  return { from, to: addDays(from, count), days };
}

/** Where the view moves on Previous and Next. */
export function stepAnchor(mode: ViewMode, anchor: Date, direction: -1 | 1): Date {
  if (mode === 'day') {
    return addDays(anchor, direction);
  }
  if (mode === 'week') {
    return addDays(anchor, 7 * direction);
  }
  return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
}

export interface Span {
  id: string;
  start: Date;
  end: Date;
}

export interface DaySegment {
  /** Minutes from the day's midnight to where the visit starts on this day. */
  top: number;
  /** Minutes it lasts on this day. */
  length: number;
  /** It began on an earlier day. */
  continuesFrom: boolean;
  /** It goes on into a later day. */
  continuesTo: boolean;
}

/** The part of a span that falls on `day`, or nothing. A night shift shows on both days. */
export function segmentOn(span: Span, day: Date): DaySegment | undefined {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  if (span.end.getTime() <= dayStart.getTime() || span.start.getTime() >= dayEnd.getTime()) {
    return undefined;
  }
  const start = Math.max(span.start.getTime(), dayStart.getTime());
  const end = Math.min(span.end.getTime(), dayEnd.getTime());
  return {
    top: (start - dayStart.getTime()) / MINUTE_MS,
    length: Math.max((end - start) / MINUTE_MS, 1),
    continuesFrom: span.start.getTime() < dayStart.getTime(),
    continuesTo: span.end.getTime() > dayEnd.getTime(),
  };
}

export interface Lane {
  /** Which lane, from the inline start. */
  lane: number;
  /** How many lanes its cluster of overlapping visits needs. */
  lanes: number;
}

/**
 * Shares a day's width between overlapping visits, as calendars do: each
 * cluster of visits that overlap one another gets as many lanes as it needs at
 * its busiest, and each visit takes the first lane free when it starts.
 */
export function layoutLanes(spans: readonly Span[]): Map<string, Lane> {
  const sorted = [...spans].sort(
    (a, b) =>
      a.start.getTime() - b.start.getTime() ||
      b.end.getTime() - a.end.getTime() ||
      a.id.localeCompare(b.id),
  );
  const result = new Map<string, Lane>();
  let cluster: { id: string; lane: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;

  const close = () => {
    for (const member of cluster) {
      result.set(member.id, { lane: member.lane, lanes: laneEnds.length });
    }
    cluster = [];
    laneEnds = [];
  };

  for (const span of sorted) {
    if (span.start.getTime() >= clusterEnd) {
      close();
      clusterEnd = -Infinity;
    }
    let lane = laneEnds.findIndex((end) => end <= span.start.getTime());
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(span.end.getTime());
    } else {
      laneEnds[lane] = span.end.getTime();
    }
    cluster.push({ id: span.id, lane });
    clusterEnd = Math.max(clusterEnd, span.end.getTime());
  }
  close();
  return result;
}

/** Rounds minutes to the nearest step. */
export function snapMinutes(minutes: number, step = 15): number {
  return Math.round(minutes / step) * step;
}

/**
 * Engineer colours: distinct hues at a lightness that reads on light and dark
 * surfaces alike. Used as a stripe and a dot beside a name, never as the only
 * sign of who is on a visit.
 */
const HUES = [212, 145, 28, 280, 350, 180, 52, 245, 100, 320];

export function personColour(index: number): string {
  const hue = HUES[index % HUES.length]!;
  const round = Math.floor(index / HUES.length);
  return `hsl(${String(hue)} ${String(70 - round * 15)}% ${String(48 + round * 6)}%)`;
}

/** Initials for a chip: `Sara Ahmed` → `SA`. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) {
    return '?';
  }
  return parts
    .slice(0, 2)
    .map((part) => [...part][0]!.toLocaleUpperCase())
    .join('');
}
