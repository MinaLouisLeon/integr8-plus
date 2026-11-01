/**
 * `@integr8/form-input/behaviour` — the behaviour check's forms, answers and
 * expected screens (P07, owner's decision 5, 1.3.0).
 *
 * The builder's phone preview, the web filler and the phone app are three
 * renderers of one engine. This module is what lets a test in each of them say
 * "for these forms and these answers I show exactly this": the six library
 * forms plus `EVERYTHING_FORM` (every question type and every kind of rule),
 * five or more steps each, and `expectedScreen`, the questions, labels,
 * required marks and errors the engine says should show. Each renderer's own
 * test reads its screen into a `Screen` and compares; see
 * docs/form-engine/builder.md, "Behaviour check".
 *
 * Test support, shipped as a subpath so no app bundles it by accident.
 */

export {
  BEHAVIOUR_TODAY,
  behaviourCases,
  compileOrThrow,
  entryIds,
  stateOf,
  type BehaviourCase,
  type BehaviourStep,
} from './cases.js';
export { EVERYTHING_FORM } from './fixture.js';
export {
  joinScreens,
  readQuestions,
  readScreen,
  type ReadOptions,
  type ScreenNode,
} from './read-screen.js';
export {
  entryName,
  expectedScreen,
  type Screen,
  type ScreenQuestion,
  type ScreenSection,
  type Translate,
} from './screen.js';
