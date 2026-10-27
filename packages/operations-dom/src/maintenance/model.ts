import type { MaintenanceItem } from '../api.js';

/**
 * Maintenance (P27), kept apart from React so it can be tested on its own:
 * filtering and grouping what is due, and the choices the filters offer.
 */

export interface MaintenanceFilters {
  customerId: string;
  siteId: string;
  jobTypeId: string;
  standing: string;
}

export const NO_FILTERS: MaintenanceFilters = {
  customerId: '',
  siteId: '',
  jobTypeId: '',
  standing: '',
};

export function filterItems(
  items: readonly MaintenanceItem[],
  filters: MaintenanceFilters,
): MaintenanceItem[] {
  return items.filter(
    (item) =>
      (filters.customerId === '' || item.customer.id === filters.customerId) &&
      (filters.siteId === '' || item.site.id === filters.siteId) &&
      (filters.jobTypeId === '' || item.jobType.id === filters.jobTypeId) &&
      (filters.standing === '' || item.standing === filters.standing),
  );
}

/** Each distinct named thing once, by name: the choices a filter offers. */
export function choices(
  entries: readonly { id: string; name: string }[],
  locale: string,
): { id: string; name: string }[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, locale));
}

export interface MonthGroup {
  /** `YYYY-MM`. */
  month: string;
  items: MaintenanceItem[];
}

/** Earliest due first, then by asset, in one group per calendar month. */
export function groupByMonth(items: readonly MaintenanceItem[], locale: string): MonthGroup[] {
  const sorted = [...items].sort(
    (a, b) =>
      a.dueOn.localeCompare(b.dueOn) ||
      a.asset.name.localeCompare(b.asset.name, locale) ||
      a.key.localeCompare(b.key),
  );
  const groups: MonthGroup[] = [];
  for (const item of sorted) {
    const month = item.dueOn.slice(0, 7);
    const last = groups.at(-1);
    if (last?.month === month) {
      last.items.push(item);
    } else {
      groups.push({ month, items: [item] });
    }
  }
  return groups;
}

/** `2026-11` as the reader names a month: `November 2026`. */
export function formatMonth(month: string, locale: string): string {
  const [year, number] = month.split('-').map(Number);
  if (year === undefined || number === undefined || Number.isNaN(year) || Number.isNaN(number)) {
    return month;
  }
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, number - 1, 1)));
}
