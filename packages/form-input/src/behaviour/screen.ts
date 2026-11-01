import type { CompiledForm, Field, FieldError, FormView } from '@integr8/form-engine';
import { isRequiredNow } from '../choices.js';
import { entriesOf, entryErrors, entryTitle, sectionErrors } from '../entries.js';
import { errorMessage } from '../errors.js';
import { visiblePages } from '../navigation.js';
import { say } from '../text.js';

/**
 * What a person sees of a form, written down: the behaviour check's common
 * language.
 *
 * Each renderer's test reads its own screen into this shape — the web filler
 * and the builder's preview from the DOM, the phone from its React Native
 * components — and `expectedScreen` writes the same shape from the engine's
 * view. Equal means the renderers ask the same questions, with the same words,
 * the same required marks and the same errors, in the same order.
 *
 * Deliberately not here: how anything looks (sizes, colours, pixels), which
 * control a question uses, option lists, and the renderer's own chrome
 * (progress, buttons, page names). Those differ on purpose or are checked by
 * each renderer's own tests.
 */

export type Translate = (key: string, params: Record<string, string>) => string;

export interface ScreenQuestion {
  /** The section it is shown in. */
  section: string;
  /** For a question of a repeating section: the entry it is shown in. */
  entry?: string;
  id: string;
  label: string;
  required: boolean;
  help?: string;
  /** Every error shown on it, in order, in the words shown. */
  errors: string[];
}

export interface ScreenSection {
  id: string;
  title?: string;
  /** A repeating section's entries, as listed: their titles, in order. */
  entries?: string[];
  /** A repeating section's own problems — too few entries — in the engine's words. */
  problems?: string[];
}

export interface Screen {
  /**
   * Review was pressed and nothing is wrong, so the review screen shows instead
   * of the questions (both fillers do this; the builder's desktop view does not).
   */
  reviewing: boolean;
  /** Every section shown, page after page, in order. */
  sections: ScreenSection[];
  /** Every question shown, page after page, entry after entry, in order. */
  questions: ScreenQuestion[];
}

export function expectedScreen(
  form: CompiledForm,
  view: FormView,
  locale: string,
  translate: Translate,
  options: { reviewScreen?: boolean } = {},
): Screen {
  if (options.reviewScreen !== false && view.status === 'submitted') {
    return { reviewing: true, sections: [], questions: [] };
  }
  const sections: ScreenSection[] = [];
  const questions: ScreenQuestion[] = [];
  const question = (
    field: Field,
    section: string,
    errors: readonly FieldError[],
    entry?: string,
  ): ScreenQuestion => {
    const help = say(field.help, locale);
    return {
      section,
      ...(entry === undefined ? {} : { entry }),
      id: field.id,
      label: say(field.label, locale) || field.id,
      required: isRequiredNow(view, field, entry),
      ...(help === '' ? {} : { help }),
      errors: errors
        .filter((error) => error.field === field.id)
        .map((error) => errorMessage(field, error, locale, translate)),
    };
  };

  for (const page of visiblePages(form, view)) {
    for (const section of page.sections) {
      if (view.visible.get(section.id) !== true) {
        continue;
      }
      const title = say(section.title, locale);
      const shown: ScreenSection = { id: section.id, ...(title === '' ? {} : { title }) };
      sections.push(shown);
      if (section.repeat === undefined) {
        const errors = view.shownErrors.filter((error) => error.entry === undefined);
        for (const field of section.fields) {
          if (view.visible.get(field.id) === true) {
            questions.push(question(field, section.id, errors));
          }
        }
        continue;
      }
      const entries = entriesOf(view, section.id);
      shown.entries = entries.map((entry, index) =>
        entryName(entryTitle(section, entry, index, locale)),
      );
      shown.problems = sectionErrors(view.shownErrors, section.id).map((error) =>
        translate(`form.errors.${error.code}`, { ...error.params }),
      );
      for (const entry of entries) {
        const errors = entryErrors(view.shownErrors, entry.id);
        for (const field of section.fields) {
          if (entry.visible.get(field.id) === true) {
            questions.push(question(field, section.id, errors, entry.id));
          }
        }
      }
    }
  }
  return { reviewing: false, sections, questions };
}

/** "Radiator 2 · Hall", as both renderers write an entry with a name. */
export function entryName(title: { label: string; name: string | undefined }): string {
  return title.name === undefined ? title.label : `${title.label} · ${title.name}`;
}
