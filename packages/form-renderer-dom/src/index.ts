/**
 * `@integr8/form-renderer-dom` — forms, filled in and read back, in React DOM.
 *
 * Shared by the web app and the desktop app, which both render the DOM. P01's
 * rule against widgets in `packages/` is about React DOM and React Native, which
 * cannot share components; two DOM apps can, and two copies of eighteen
 * accessible widgets would drift. The React Native renderer is P13's, and lives
 * with the mobile app.
 *
 * Tailwind classes are written here, so each app's stylesheet must include this
 * package in its sources: `@source "../node_modules/@integr8/form-renderer-dom/dist";`.
 */

export { AnswerView, type AnswerViewProps } from './answer-view.js';
export {
  EntryList,
  entryName,
  SectionProblem,
  sectionName,
  type EntryFieldContext,
  type EntryListProps,
} from './entries.js';
export { ErrorText } from './field.js';
export { FormFiller, type FormFillerProps, type SubmitOutcome } from './form-filler.js';
export type { MediaAdapter } from './media.js';
export { formatBytes, normaliseDigits, say, withLocalOffset } from './text.js';
export { fitWithin, PHOTO_MAX_EDGE, PHOTO_QUALITY, preparePhoto } from './compress.js';
