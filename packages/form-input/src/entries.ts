import type {
  CompiledForm,
  Field,
  ElementId,
  EntryEvaluation,
  FieldError,
  FormView,
  Section,
} from '@integr8/form-engine';
import { say } from './text.js';

/**
 * Entries of a repeatable section, as both renderers list them (P13b): what each
 * is called, whether another can be added, and which of them need attention.
 */

/** The repeatable section a field is asked in, or `undefined`. */
export function sectionOfEntries(form: CompiledForm, fieldId: ElementId): ElementId | undefined {
  return form.elements.get(fieldId)?.entries;
}

/** The entries of a section as the view has them, in order. None while it is hidden. */
export function entriesOf(view: FormView, section: ElementId): readonly EntryEvaluation[] {
  return view.entries.get(section) ?? [];
}

export interface EntryTitle {
  /** "Appliance 2": what the admin calls one entry, and its place in the list. */
  label: string;
  /** The answer that names this entry — "Worcester" — when the section has one. */
  name: string | undefined;
}

/**
 * What an entry is called in a list. The number is its place, counted from 1 in
 * the digits of the language shown; the name is the answer to the section's
 * title question, when it has one and it is answered — a choice by the words
 * picked rather than its stored value, a date or a date and time as the language
 * writes them.
 */
export function entryTitle(
  section: Section,
  entry: EntryEvaluation,
  index: number,
  locale: string,
): EntryTitle {
  const repeat = section.repeat;
  const number = new Intl.NumberFormat(locale).format(index + 1);
  const label = repeat === undefined ? number : `${say(repeat.entryLabel, locale)} ${number}`;
  const titled = repeat?.titleField === undefined ? undefined : entry.values.get(repeat.titleField);
  const field = section.fields.find((candidate) => candidate.id === repeat?.titleField);
  return { label, name: nameOf(field, titled, locale) };
}

function nameOf(field: Field | undefined, value: unknown, locale: string): string | undefined {
  if (typeof value === 'number') {
    return new Intl.NumberFormat(locale).format(value);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  switch (field?.type) {
    case 'dropdown':
    case 'radio': {
      const option = field.options.find((candidate) => candidate.value === value);
      return option === undefined ? value : say(option.label, locale);
    }
    case 'date': {
      const date = new Date(`${value}T12:00:00Z`);
      return Number.isNaN(date.getTime())
        ? value
        : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
    }
    case 'datetime': {
      const instant = new Date(value);
      return Number.isNaN(instant.getTime())
        ? value
        : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
            instant,
          );
    }
    default:
      return value.trim();
  }
}

/** Whether a person may add another entry: fewer than the section allows. */
export function canAddEntry(section: Section, view: FormView): boolean {
  return (
    section.repeat !== undefined && entriesOf(view, section.id).length < section.repeat.maxEntries
  );
}

/** Whether removing an entry would leave fewer than the section needs. */
export function removingLeavesTooFew(section: Section, view: FormView): boolean {
  return entriesOf(view, section.id).length <= (section.repeat?.minEntries ?? 0);
}

/** The errors to show for one entry, in reading order. */
export function entryErrors(errors: readonly FieldError[], entry: string): FieldError[] {
  return errors.filter((error) => error.entry === entry);
}

/** The errors on a section itself: too few or too many entries. */
export function sectionErrors(errors: readonly FieldError[], section: ElementId): FieldError[] {
  return errors.filter((error) => error.field === section && error.entry === undefined);
}
