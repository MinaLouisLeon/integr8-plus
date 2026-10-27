import { DEADLINE_MINUTES_MAX, DEADLINE_WARN_MINUTES_MAX } from '@integr8/core';
import type { DeadlineReport, DeadlineRule, DeadlineSummary, Priority } from '../api.js';

/**
 * Response deadlines (P27), kept apart from React so they can be tested on
 * their own: a rule as boxes of hours and minutes and back, on-time shares,
 * and the report as rows for a CSV file.
 */

/** Most urgent first, as the rules are read. */
export const PRIORITY_ORDER: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];

/** One priority's rule as typed: empty boxes mean no deadline of that kind. */
export interface RuleDraft {
  priority: Priority;
  responseHours: string;
  responseMinutes: string;
  completionHours: string;
  completionMinutes: string;
  clock: 'always' | 'working_hours';
  warnMinutes: string;
}

function split(minutes: number | null): { hours: string; minutes: string } {
  if (minutes === null) {
    return { hours: '', minutes: '' };
  }
  return { hours: String(Math.floor(minutes / 60)), minutes: String(minutes % 60) };
}

/** A draft per priority, from the rules the company has; a priority without one is blank. */
export function ruleDrafts(
  rules: readonly Pick<
    DeadlineRule,
    'priority' | 'responseMinutes' | 'completionMinutes' | 'clock' | 'warnMinutes'
  >[],
  warnMinutes: number,
): RuleDraft[] {
  return PRIORITY_ORDER.map((priority) => {
    const rule = rules.find((entry) => entry.priority === priority);
    const response = split(rule?.responseMinutes ?? null);
    const completion = split(rule?.completionMinutes ?? null);
    return {
      priority,
      responseHours: response.hours,
      responseMinutes: response.minutes,
      completionHours: completion.hours,
      completionMinutes: completion.minutes,
      clock: rule?.clock ?? 'always',
      warnMinutes: String(rule?.warnMinutes ?? warnMinutes),
    };
  });
}

/**
 * Hours and minutes boxes as minutes: null when both are empty, undefined
 * when either is not a whole number or the total is out of range.
 */
export function joinMinutes(hours: string, minutes: string): number | null | undefined {
  const h = hours.trim();
  const m = minutes.trim();
  if (h === '' && m === '') {
    return null;
  }
  if ((h !== '' && !/^\d+$/u.test(h)) || (m !== '' && !/^\d+$/u.test(m))) {
    return undefined;
  }
  const total = Number(h === '' ? 0 : h) * 60 + Number(m === '' ? 0 : m);
  return total >= 1 && total <= DEADLINE_MINUTES_MAX ? total : undefined;
}

export type RuleProblem = 'invalid' | 'completionBeforeResponse' | 'warnInvalid';

/** What is wrong with one draft, if anything. A blank draft is fine: that priority has no deadlines. */
export function ruleProblem(draft: RuleDraft): RuleProblem | undefined {
  const response = joinMinutes(draft.responseHours, draft.responseMinutes);
  const completion = joinMinutes(draft.completionHours, draft.completionMinutes);
  if (response === undefined || completion === undefined) {
    return 'invalid';
  }
  if (response === null && completion === null) {
    return undefined;
  }
  if (response !== null && completion !== null && completion < response) {
    return 'completionBeforeResponse';
  }
  const warn = draft.warnMinutes.trim();
  if (!/^\d+$/u.test(warn) || Number(warn) > DEADLINE_WARN_MINUTES_MAX) {
    return 'warnInvalid';
  }
  return undefined;
}

/** The body `PUT /v1/deadline-rules` takes: one rule per priority that has a deadline. */
export function rulesBody(drafts: readonly RuleDraft[]) {
  return drafts.flatMap((draft) => {
    const responseMinutes = joinMinutes(draft.responseHours, draft.responseMinutes) ?? null;
    const completionMinutes = joinMinutes(draft.completionHours, draft.completionMinutes) ?? null;
    if (responseMinutes === null && completionMinutes === null) {
      return [];
    }
    return [
      {
        priority: draft.priority,
        responseMinutes,
        completionMinutes,
        clock: draft.clock,
        warnMinutes: Number(draft.warnMinutes.trim()),
      },
    ];
  });
}

/** The share of `part` in `whole`, 0 to 1; null when nothing was due. */
export function share(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

/** The labels a CSV file of the report needs, already in the reader's language. */
export interface ReportCsvLabels {
  customer: string;
  jobs: string;
  responseDue: string;
  respondedOnTime: string;
  responseShare: string;
  completionDue: string;
  completedOnTime: string;
  completionShare: string;
  averageResponse: string;
  missed: string;
  totals: string;
  job: string;
  title: string;
  deadline: string;
  priority: string;
  dueAt: string;
  metAt: string;
  recordedAt: string;
  kind: (kind: 'response' | 'completion') => string;
  priorityName: (priority: Priority) => string;
}

function percent(part: number, whole: number): string {
  const value = share(part, whole);
  return value === null ? '' : String(Math.round(value * 1000) / 10);
}

function summaryRow(name: string, summary: DeadlineSummary): (string | number | null)[] {
  return [
    name,
    summary.jobs,
    summary.responseDue,
    summary.respondedOnTime,
    percent(summary.respondedOnTime, summary.responseDue),
    summary.completionDue,
    summary.completedOnTime,
    percent(summary.completedOnTime, summary.completionDue),
    summary.averageResponseMinutes,
    summary.missed,
  ];
}

/**
 * The report as rows for `toCsv`: the customers and the totals, then a blank
 * line, then every recorded miss. Times are ISO instants, so a spreadsheet
 * reads them the same in every language.
 */
export function reportCsvRows(
  report: DeadlineReport,
  labels: ReportCsvLabels,
): (string | number | null)[][] {
  return [
    [
      labels.customer,
      labels.jobs,
      labels.responseDue,
      labels.respondedOnTime,
      labels.responseShare,
      labels.completionDue,
      labels.completedOnTime,
      labels.completionShare,
      labels.averageResponse,
      labels.missed,
    ],
    ...report.customers.map((entry) => summaryRow(entry.customer.name, entry.summary)),
    summaryRow(labels.totals, report.totals),
    [],
    [
      labels.job,
      labels.title,
      labels.customer,
      labels.deadline,
      labels.priority,
      labels.dueAt,
      labels.metAt,
      labels.recordedAt,
    ],
    ...report.misses.map((miss) => [
      miss.workOrder.reference,
      miss.workOrder.title,
      miss.customer.name,
      labels.kind(miss.kind),
      labels.priorityName(miss.priority),
      miss.dueAt,
      miss.metAt,
      miss.recordedAt,
    ]),
  ];
}
