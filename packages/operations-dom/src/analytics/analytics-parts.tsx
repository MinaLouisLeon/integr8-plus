import { formatNumber, useTranslation } from '@integr8/i18n';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useOperations } from '../api.js';
import { buttonClass, Field, inputClass } from '../ui.js';

/**
 * Pieces the figure screens share (eighth round; ADR-0012): a period that
 * starts as the last 90 days, a share of two counts as a percentage, and a
 * number of days. Amounts are never added up here: each comes from the
 * server as a decimal string and is only formatted.
 */

export interface Period {
  from: string;
  to: string;
}

/** A day in the reader's own calendar, as the API writes one. */
function dayOf(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** The last `days` days up to today. */
export function lastDays(days: number, now = new Date()): Period {
  const start = new Date(now);
  start.setDate(start.getDate() - days);
  return { from: dayOf(start), to: dayOf(now) };
}

export const DEFAULT_DAYS = 90;

/** `part` of `whole` as a percentage, from whole counts; a dash when there is nothing to divide. */
export function shareOf(part: number, whole: number, locale: string): string {
  if (whole === 0) {
    return '—';
  }
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
    part / whole,
  );
}

/** A count as the reader's language writes it. */
export function useCount(): (value: number) => string {
  const { locale } = useOperations();
  return (value) => formatNumber(value, { locale });
}

/** A median in days, or a dash when there was nothing to take one of. */
export function useDays(): (value: number | null) => string {
  const { t } = useTranslation();
  return (value) => (value === null ? '—' : t('analytics.days', { count: value }));
}

/**
 * From and to, applied together. The figures follow what was applied, so
 * typing a date does not fetch on every keystroke; `children` adds the
 * screen's own choices (what to group by) to the same form.
 */
export function PeriodForm({
  value,
  onApply,
  label,
  children,
}: {
  value: Period;
  onApply: (next: Period) => void;
  label: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Period>(value);
  const invalid = draft.from === '' || draft.to === '' || draft.from > draft.to;
  return (
    <form
      aria-label={label}
      noValidate
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (!invalid) {
          onApply(draft);
        }
      }}
    >
      <Field label={t('analytics.range.from')}>
        {(id) => (
          <input
            id={id}
            type="date"
            dir="ltr"
            required
            aria-invalid={invalid}
            className={inputClass}
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
        )}
      </Field>
      <Field label={t('analytics.range.to')}>
        {(id) => (
          <input
            id={id}
            type="date"
            dir="ltr"
            required
            aria-invalid={invalid}
            className={inputClass}
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        )}
      </Field>
      {children}
      <button type="submit" className={buttonClass.primary} disabled={invalid}>
        {t('analytics.range.apply')}
      </button>
      {invalid ? (
        <p role="alert" className="basis-full text-sm text-danger">
          {t('analytics.range.invalid')}
        </p>
      ) : null}
    </form>
  );
}

/** A table of figures: a caption for screen readers, and room to scroll sideways on a phone. */
export function FiguresTable({
  caption,
  head,
  children,
}: {
  caption: string;
  head: readonly { key: string; label: string; numeric?: boolean }[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-border-subtle text-xs text-content-muted">
          <tr>
            {head.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`px-2 py-2 font-medium first:ps-0 last:pe-0 ${
                  column.numeric === true ? 'text-end' : 'text-start'
                }`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">{children}</tbody>
      </table>
    </div>
  );
}

export const cellClass = 'px-2 py-2 first:ps-0 last:pe-0';
export const numberCellClass = `${cellClass} text-end tabular-nums`;
