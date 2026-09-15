import {
  choiceValues,
  describeFieldType,
  type Field,
  LIMITS,
  type LocalizedText,
  type Section,
} from '@integr8/form-engine';

/**
 * A section's "Repeat this section" settings, as pure edits (P13b).
 *
 * Turning repeating on asks the section's questions once per entry, up to 20 by
 * default; turning it off asks them once again. The limits are typed as text
 * and only reach the definition once they are whole numbers in range, so a
 * half-typed "1" on the way to "12" never becomes a limit.
 */

export const DEFAULT_MAX_ENTRIES = 20;

/** A section as `updateSection` hands it over: everything but its questions. */
type SectionSettings = Omit<Section, 'fields'>;

/** The section repeating, or not. Turning it on keeps nothing from any earlier setting. */
export function withRepeat<S extends SectionSettings>(
  section: S,
  on: boolean,
  entryLabel: LocalizedText,
): S {
  if (!on) {
    const { repeat: _removed, ...rest } = section;
    return rest as S;
  }
  return section.repeat === undefined
    ? { ...section, repeat: { maxEntries: DEFAULT_MAX_ENTRIES, entryLabel } }
    : section;
}

export type LimitProblem = 'min_invalid' | 'max_invalid' | 'min_above_max';

export interface LimitDraft {
  minEntries: string;
  maxEntries: string;
}

/** What is wrong with typed limits, if anything: a minimum of 0–100 (or none), a maximum of 1–100, the minimum no more than the maximum. */
export function limitProblem(draft: LimitDraft): LimitProblem | undefined {
  const whole = (text: string, lowest: number) => {
    if (!/^[0-9]{1,3}$/u.test(text.trim())) {
      return undefined;
    }
    const value = Number.parseInt(text.trim(), 10);
    return value >= lowest && value <= LIMITS.entriesPerSection ? value : undefined;
  };
  const minimum = draft.minEntries.trim() === '' ? 0 : whole(draft.minEntries, 0);
  const maximum = whole(draft.maxEntries, 1);
  if (minimum === undefined) {
    return 'min_invalid';
  }
  if (maximum === undefined) {
    return 'max_invalid';
  }
  return minimum > maximum ? 'min_above_max' : undefined;
}

/** The section with typed limits applied, or unchanged while they are not valid. */
export function withLimits<S extends SectionSettings>(section: S, draft: LimitDraft): S {
  if (section.repeat === undefined || limitProblem(draft) !== undefined) {
    return section;
  }
  const { minEntries: _previous, ...repeat } = section.repeat;
  const minimum =
    draft.minEntries.trim() === '' ? undefined : Number.parseInt(draft.minEntries, 10);
  return {
    ...section,
    repeat: {
      ...repeat,
      ...(minimum === undefined ? {} : { minEntries: minimum }),
      maxEntries: Number.parseInt(draft.maxEntries, 10),
    },
  };
}

/**
 * The questions that can name each entry: the section's own short answers,
 * numbers, dates and times, and single choices — shown by the words picked.
 * Not yes/no, whose answer names nothing, nor a multi-select.
 */
export function titleCandidates(section: Pick<Section, 'fields'>): Field[] {
  return section.fields.filter((field) => {
    const valueType = describeFieldType(field.type).valueType;
    return (
      field.type !== 'yes_no' &&
      (field.type === 'dropdown' ||
        field.type === 'radio' ||
        (choiceValues(field) === undefined &&
          (valueType === 'text' ||
            valueType === 'number' ||
            valueType === 'date' ||
            valueType === 'time' ||
            valueType === 'datetime')))
    );
  });
}

/** The section named by a question, or by its number alone. */
export function withTitleField<S extends SectionSettings>(
  section: S,
  fieldId: string | undefined,
): S {
  if (section.repeat === undefined) {
    return section;
  }
  const { titleField: _previous, ...repeat } = section.repeat;
  return {
    ...section,
    repeat: fieldId === undefined ? repeat : { ...repeat, titleField: fieldId },
  };
}

/** The section with what one entry is called changed. An empty label is kept out of the definition by the caller. */
export function withEntryLabel<S extends SectionSettings>(
  section: S,
  entryLabel: LocalizedText,
): S {
  return section.repeat === undefined
    ? section
    : { ...section, repeat: { ...section.repeat, entryLabel } };
}
