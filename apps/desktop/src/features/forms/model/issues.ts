import { type BreakingChange, type FormDefinition, locate } from '@integr8/form-engine';
import type { TFunction } from '@integr8/i18n';

/**
 * Which element to open for a problem the compiler reported.
 *
 * The one whose definition holds the problem, found from the issue's path —
 * `pages[0].sections[1].fields[2].visibleWhen` is the third question of the
 * second section. Not simply the first element the issue names: for "a rule
 * refers to a question that is not in this form", that is the deleted question,
 * which cannot be opened, while the rule that needs fixing is where the path
 * points.
 */
export function issueElement(
  definition: FormDefinition,
  issue: { path: string; elements: readonly string[] },
): string | undefined {
  const indexes = [...issue.path.matchAll(/(pages|sections|fields)\[(\d+)\]/gu)];
  let id: string | undefined;
  let page = undefined as FormDefinition['pages'][number] | undefined;
  let section = undefined as FormDefinition['pages'][number]['sections'][number] | undefined;
  for (const [, kind, index] of indexes) {
    const at = Number(index);
    if (kind === 'pages') {
      page = definition.pages[at];
      id = page?.id;
    } else if (kind === 'sections') {
      section = page?.sections[at];
      id = section?.id;
    } else {
      id = section?.fields[at]?.id;
    }
    if (id === undefined) {
      break;
    }
  }
  if (id !== undefined) {
    return id;
  }
  return issue.elements.find((element) => locate(definition, element) !== undefined);
}

/**
 * The words for a problem the compiler reported.
 *
 * The engine's own message is English written about ids; for the problems
 * repeatable sections bring (P13b) the builder has its own copy, naming the
 * questions and sections as the admin titled them. `name` turns an id into
 * that title.
 */
export function issueText(
  issue: { code: string; path: string; message: string; elements: readonly string[] },
  name: (id: string) => string,
  t: TFunction,
): string {
  const [first = '', second = ''] = issue.elements;
  switch (issue.code) {
    case 'invalid_repeat':
      return issue.path.endsWith('.minEntries')
        ? t('forms.issues.entryLimits', { section: name(first) })
        : issue.path.endsWith('.titleField')
          ? t('forms.issues.titleField', { section: name(first) })
          : t('forms.issues.noQuestions', { section: name(first) });
    case 'not_repeatable':
      return t('forms.issues.not_repeatable', { section: name(first) });
    case 'inside_repeat':
      return t('forms.issues.inside_repeat', { question: name(first), section: name(second) });
    case 'not_in_section':
      return t('forms.issues.not_in_section', { question: name(first), section: name(second) });
    default:
      return issue.message;
  }
}

/**
 * Why a change affects existing data. Tightened limits on a repeatable section
 * name the limits in words — "fewest entries" — rather than as properties.
 */
export function breakingText(entry: BreakingChange, t: TFunction): string {
  if (
    entry.reason === 'constraint_tightened' &&
    entry.detail.length > 0 &&
    entry.detail.every((detail) => detail === 'minEntries' || detail === 'maxEntries')
  ) {
    return t('forms.changes.breaking.entryLimits', {
      detail: entry.detail.map((detail) => t(`forms.changes.limit.${detail}`)).join(', '),
    });
  }
  return t(`forms.changes.breaking.${entry.reason}`, { detail: entry.detail.join(', ') });
}
