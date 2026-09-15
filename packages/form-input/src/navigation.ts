import type { CompiledForm, FieldError, FormView, Page } from '@integr8/form-engine';

/**
 * Where things are in a long form: which pages show, which page a question is
 * on, and one problem per question to list above the form. The same answers in
 * every renderer, so "3 questions need attention" means the same three
 * questions on a phone and on a desktop.
 */

export function visiblePages(form: CompiledForm, view: FormView): Page[] {
  return form.definition.pages.filter((page) => view.visible.get(page.id) === true);
}

/** The index in `pages` of the page a field is on, or -1. */
export function pageIndexOfField(pages: readonly Page[], fieldId: string): number {
  return pages.findIndex((page) =>
    page.sections.some((section) => section.fields.some((field) => field.id === fieldId)),
  );
}

/** One entry per question, in reading order: its first problem. */
export function firstPerField(errors: readonly FieldError[]): FieldError[] {
  const seen = new Set<string>();
  return errors.filter((error) => {
    if (seen.has(error.field)) {
      return false;
    }
    seen.add(error.field);
    return true;
  });
}

/** How many questions on each page have a problem to show. */
export function problemsPerPage(pages: readonly Page[], view: FormView): number[] {
  const counts = pages.map(() => 0);
  for (const error of firstPerField(view.shownErrors)) {
    const index = pageIndexOfField(pages, error.field);
    if (index !== -1) {
      counts[index] = (counts[index] ?? 0) + 1;
    }
  }
  return counts;
}

/** Progress as a fraction from 0 to 1: a form with nothing required is complete. */
export function progressFraction(view: FormView): number {
  const { requiredAnswered, requiredTotal } = view.progress;
  return requiredTotal === 0 ? 1 : requiredAnswered / requiredTotal;
}
