import { type FormDefinition, locate } from '@integr8/form-engine';

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
