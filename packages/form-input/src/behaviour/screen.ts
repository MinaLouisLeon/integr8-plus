import {
  type CompiledForm,
  type Field,
  type FieldError,
  type FormView,
  type Information,
  type InformationStyle,
  isCalculated,
  isInformation,
  type SectionItem,
} from '@integr8/form-engine';
import { isRequiredNow } from '../choices.js';
import { entriesOf, entryErrors, entryTitle, sectionErrors } from '../entries.js';
import { errorMessage } from '../errors.js';
import { visiblePages } from '../navigation.js';
import { say } from '../text.js';
import { calculatedText, informationText } from '../version2.js';

/**
 * What a person sees of a form, written down: the behaviour check's common
 * language.
 *
 * Each renderer's test reads its own screen into this shape — the web filler
 * and the builder's preview from the DOM, the phone from its React Native
 * components — and `expectedScreen` writes the same shape from the engine's
 * view. Equal means the renderers ask the same questions, with the same words,
 * the same required marks and the same errors, in the same order; show the
 * same worked-out answers; and show the same text that is not a question
 * (form format 2: page and section descriptions, Information blocks with
 * their style).
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
  /**
   * For a calculated question: the answer worked out, as shown — a date the
   * way the language writes one, a unit after a number, `—` while unknown.
   */
  value?: string;
}

/** An Information block (form format 2) as shown: text among the questions, never answered. */
export interface ScreenInformation {
  section: string;
  entry?: string;
  id: string;
  heading?: string;
  /** The paragraph, its line breaks read as spaces. */
  body: string;
  style: InformationStyle;
}

export interface ScreenPage {
  id: string;
  /** The description under the page's title (form format 2). */
  description?: string;
}

export interface ScreenSection {
  id: string;
  title?: string;
  /** The description under the section's title (form format 2). */
  description?: string;
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
  /** Every page shown, in order. */
  pages: ScreenPage[];
  /** Every section shown, page after page, in order. */
  sections: ScreenSection[];
  /** Every question shown, page after page, entry after entry, in order. */
  questions: ScreenQuestion[];
  /** Every Information block shown, page after page, entry after entry, in order. */
  information: ScreenInformation[];
}

/** The review screen: what both fillers show instead of the questions once nothing is wrong. */
export function reviewScreen(): Screen {
  return { reviewing: true, pages: [], sections: [], questions: [], information: [] };
}

export function expectedScreen(
  form: CompiledForm,
  view: FormView,
  locale: string,
  translate: Translate,
  options: { reviewScreen?: boolean } = {},
): Screen {
  if (options.reviewScreen !== false && view.status === 'submitted') {
    return reviewScreen();
  }
  const pages: ScreenPage[] = [];
  const sections: ScreenSection[] = [];
  const questions: ScreenQuestion[] = [];
  const information: ScreenInformation[] = [];
  const question = (
    field: Field,
    section: string,
    errors: readonly FieldError[],
    entry: string | undefined,
    value: unknown,
  ): ScreenQuestion => {
    const help = say(field.help, locale);
    const unit =
      'unit' in field && field.unit !== undefined && value !== undefined ? field.unit : '';
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
      ...(isCalculated(field)
        ? {
            value: `${calculatedText(field, value, locale) || '—'}${unit === '' ? '' : ` ${unit}`}`,
          }
        : {}),
    };
  };
  const item = (
    field: SectionItem,
    section: string,
    errors: readonly FieldError[],
    entry: string | undefined,
    value: unknown,
  ) => {
    if (isInformation(field)) {
      information.push(informationShown(field, section, entry, locale));
    } else {
      questions.push(question(field, section, errors, entry, value));
    }
  };

  for (const page of visiblePages(form, view)) {
    const pageDescription = words(say(page.description, locale));
    pages.push({
      id: page.id,
      ...(pageDescription === '' ? {} : { description: pageDescription }),
    });
    for (const section of page.sections) {
      if (view.visible.get(section.id) !== true) {
        continue;
      }
      const title = say(section.title, locale);
      const description = words(say(section.description, locale));
      const shown: ScreenSection = {
        id: section.id,
        ...(title === '' ? {} : { title }),
        ...(description === '' ? {} : { description }),
      };
      sections.push(shown);
      if (section.repeat === undefined) {
        const errors = view.shownErrors.filter((error) => error.entry === undefined);
        for (const field of section.fields) {
          if (view.visible.get(field.id) === true) {
            item(field, section.id, errors, undefined, view.values.get(field.id));
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
            item(field, section.id, errors, entry.id, entry.values.get(field.id));
          }
        }
      }
    }
  }
  return { reviewing: false, pages, sections, questions, information };
}

function informationShown(
  block: Information,
  section: string,
  entry: string | undefined,
  locale: string,
): ScreenInformation {
  const { heading, lines, style } = informationText(block, locale);
  return {
    section,
    ...(entry === undefined ? {} : { entry }),
    id: block.id,
    ...(heading === undefined ? {} : { heading: words(heading) }),
    body: words(lines.join(' ')),
    style,
  };
}

/** Text as a reader of the screen gets it: every run of white space one space, none at the ends. */
export function words(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** "Radiator 2 · Hall", as both renderers write an entry with a name. */
export function entryName(title: { label: string; name: string | undefined }): string {
  return title.name === undefined ? title.label : `${title.label} · ${title.name}`;
}
