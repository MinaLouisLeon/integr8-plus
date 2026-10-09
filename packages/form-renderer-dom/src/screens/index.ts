/**
 * `@integr8/form-renderer-dom/screens` — filling, finding and correcting
 * submissions, for an app that supplies an API client and its own routing.
 *
 *   <ScreensContext.Provider value={{ client, locale, navigate, paths, download }}>
 *     <SubmissionScreen submissionId={id} />
 *   </ScreensContext.Provider>
 *
 * A separate entry from the renderer, because the renderer knows nothing of the
 * API and should stay usable without it.
 */

export {
  apiMediaAdapter,
  localToday,
  type RowAction,
  type RowActionsEvent,
  type ScreensConfig,
  ScreensContext,
  type SubmissionRowActionsHandler,
  type SubmissionRowTarget,
} from './api.js';
export { BackArrow, BackLink, InlineError } from './parts.js';
export { FillStartScreen } from './fill-start.js';
export { SubmissionListScreen } from './submission-list.js';
export { SubmissionScreen } from './submission-screen.js';
