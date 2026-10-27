/**
 * Service contracts (P27), kept apart from React so they can be tested on
 * their own: reading a contract's coverage lists, checking a draft before it
 * is sent, and the device's own calendar day.
 */

/** The ids in a coverage list, or null when the contract covers every one. */
export function scopeIds(list: readonly { id: string }[] | null): string[] | null {
  return list === null ? null : list.map((entry) => entry.id);
}

/** Today on this device, `YYYY-MM-DD`: the default for a date someone picks. */
export function localDay(now: Date = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/** A positive amount with at most two decimals, as the server takes it. */
export function moneyValid(value: string): boolean {
  return /^\d{1,12}(\.\d{1,2})?$/u.test(value.trim());
}

/**
 * A whole number typed into a box: null when the box is empty, undefined when
 * it is not a whole number between `min` and `max`.
 */
export function wholeNumber(value: string, min: number, max: number): number | null | undefined {
  const text = value.trim();
  if (text === '') {
    return null;
  }
  if (!/^\d+$/u.test(text)) {
    return undefined;
  }
  const number = Number(text);
  return number >= min && number <= max ? number : undefined;
}

/** A term whose end is on or after its start; an unfinished one is not judged yet. */
export function termReversed(startsOn: string, endsOn: string): boolean {
  return startsOn !== '' && endsOn !== '' && endsOn < startsOn;
}

/** Which of a coverage list's choices to send: null for all, else the chosen ids. */
export interface ScopeDraft {
  all: boolean;
  ids: string[];
}

export function scopeDraft(list: readonly { id: string }[] | null): ScopeDraft {
  return list === null
    ? { all: true, ids: [] }
    : { all: false, ids: list.map((entry) => entry.id) };
}

export function scopeBody(draft: ScopeDraft): string[] | null {
  return draft.all ? null : draft.ids;
}

/** A draft that covers only chosen ones but has none chosen covers nothing: not allowed. */
export function scopeEmpty(draft: ScopeDraft): boolean {
  return !draft.all && draft.ids.length === 0;
}
