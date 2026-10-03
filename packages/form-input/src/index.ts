/**
 * `@integr8/form-input` — filling a form, without the UI.
 *
 * `@integr8/form-engine` decides what a form is and what is valid. This package
 * holds the rest of what filling one needs that is not a component: turning a
 * typed "٤٢" or a GPS fix into an answer, what a photo is shrunk to, which page a
 * question is on, what carries over from an earlier form. The React DOM renderer
 * and the React Native one both call it, which is how a form filled on a phone
 * and on a desktop store the same answers (P01: share logic, not components).
 */

export {
  editGeoPoint,
  geoPointFrom,
  GPS_DECIMALS,
  readDecimal,
  readInteger,
  toggleOption,
  type GeoPart,
} from './answers.js';
export {
  canAddEntry,
  entriesOf,
  entryErrors,
  entryTitle,
  removingLeavesTooFew,
  sectionErrors,
  sectionOfEntries,
  type EntryTitle,
} from './entries.js';
export { errorMessage } from './errors.js';
export {
  accepts,
  checkChosenFiles,
  fitWithin,
  PHOTO_MAX_EDGE,
  PHOTO_QUALITY,
  THUMBNAIL_MAX_EDGE,
  THUMBNAIL_QUALITY,
  type FileProblem,
} from './files.js';
export {
  firstPerField,
  pageIndexOfField,
  problemsPerPage,
  progressFraction,
  visiblePages,
} from './navigation.js';
export { prefillAnswers, type Prefill } from './prefill.js';
export {
  SIGNATURE_HEIGHT,
  SIGNATURE_INK,
  SIGNATURE_PAPER,
  SIGNATURE_STROKE,
  SIGNATURE_WIDTH,
  strokesToPath,
  toPadPoint,
  worthKeeping,
  type SignaturePoint,
} from './signature.js';
export {
  formatBytes,
  normaliseDigits,
  offsetText,
  say,
  withLocalOffset,
  withOffset,
} from './text.js';
