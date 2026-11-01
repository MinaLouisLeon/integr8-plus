import type { Screen, ScreenQuestion, ScreenSection } from './screen.js';

/**
 * Reads a rendered screen into a `Screen`, from the markers every renderer
 * puts on what it draws:
 *
 * - `data-section="<id>"` on a section, `data-entry="<id>"` on one entry of a
 *   repeating section, `data-question="<id>"` on a question;
 * - `data-part` on the pieces: `label`, `required` (the mark), `help`, `error`
 *   (one per message), `section-title`, `entry-title`, `section-problem`, and
 *   `review` on the review screen.
 *
 * The DOM renderers write these as attributes. The phone writes them as
 * `testID`s (`question:serial`, `part:label`), which its test's React Native
 * stand-in turns into the same attributes, so one reader serves all three.
 *
 * Typed structurally rather than with the DOM's own types, because this
 * package is also compiled for the phone, which has no DOM.
 */

export interface ScreenNode {
  readonly textContent: string | null;
  getAttribute: (name: string) => string | null;
  querySelectorAll: (selector: string) => ArrayLike<ScreenNode>;
  closest: (selector: string) => ScreenNode | null;
}

export interface ReadOptions {
  /** A section's problem as shown, back to the engine's words: the web adds the section's name. */
  unwrapProblem?: (text: string, section: string) => string;
}

export function readScreen(root: ScreenNode, options: ReadOptions = {}): Screen {
  if (all(root, '[data-part="review"]').length > 0) {
    return { reviewing: true, sections: [], questions: [] };
  }
  const sections: ScreenSection[] = [];
  const questions: ScreenQuestion[] = [];
  for (const node of all(root, '[data-section]')) {
    const id = node.getAttribute('data-section') ?? '';
    const own = (selector: string) =>
      all(node, selector).filter((candidate) => candidate.closest('[data-section]') === node);
    const section: ScreenSection = { id };
    const title = own('[data-part="section-title"]')[0];
    if (title !== undefined) {
      section.title = text(title);
    }
    const entryTitles = own('[data-part="entry-title"]');
    const problems = own('[data-part="section-problem"]');
    if (node.getAttribute('data-repeat') !== null) {
      section.entries = entryTitles.map(text);
      section.problems = problems.map((problem) =>
        options.unwrapProblem === undefined
          ? text(problem)
          : options.unwrapProblem(text(problem), id),
      );
    }
    sections.push(section);

    questions.push(
      ...readQuestions(node, id, (question) => question.closest('[data-section]') === node),
    );
  }
  return { reviewing: false, sections, questions };
}

/**
 * The questions inside `scope`, as shown in `section`. The phone shows one
 * entry of a repeating section at a time, outside the section's own card, so
 * its test reads each open entry with this.
 */
export function readQuestions(
  scope: ScreenNode,
  section: string,
  belongs: (question: ScreenNode) => boolean = () => true,
): ScreenQuestion[] {
  return all(scope, '[data-question]')
    .filter(belongs)
    .map((question) => {
      const entry = question.closest('[data-entry]')?.getAttribute('data-entry') ?? undefined;
      const parts = (part: string) =>
        all(question, `[data-part="${part}"]`).filter(
          (candidate) => candidate.closest('[data-question]') === question,
        );
      const label = parts('label')[0];
      const help = parts('help')[0];
      return {
        section,
        ...(entry === undefined ? {} : { entry }),
        id: question.getAttribute('data-question') ?? '',
        label: label === undefined ? '' : labelText(label),
        required: parts('required').length > 0,
        ...(help === undefined || text(help) === '' ? {} : { help: text(help) }),
        errors: parts('error').map(text),
      };
    });
}

/** Joins what was read page by page: one renderer shows one page at a time. */
export function joinScreens(screens: readonly Screen[]): Screen {
  if (screens.some((screen) => screen.reviewing)) {
    return { reviewing: true, sections: [], questions: [] };
  }
  return {
    reviewing: false,
    sections: screens.flatMap((screen) => screen.sections),
    questions: screens.flatMap((screen) => screen.questions),
  };
}

function all(node: ScreenNode, selector: string): ScreenNode[] {
  return Array.from(node.querySelectorAll(selector));
}

function text(node: ScreenNode): string {
  return (node.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

/** A label's words without the required mark and anything only a screen reader hears. */
function labelText(label: ScreenNode): string {
  let words = label.textContent ?? '';
  for (const extra of all(label, '[data-part="required"], .sr-only')) {
    const part = extra.textContent ?? '';
    const at = words.lastIndexOf(part);
    if (part !== '' && at !== -1) {
      words = words.slice(0, at) + words.slice(at + part.length);
    }
  }
  return words.replace(/\s+/gu, ' ').trim();
}
