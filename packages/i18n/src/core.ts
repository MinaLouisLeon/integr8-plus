/**
 * The parts of this package that touch no React.
 *
 * A React Server Component may need to know a locale's direction without
 * pulling `react-i18next` into the server bundle — where it evaluates
 * `createContext` at module scope and fails. So the pure helpers get their own
 * entry point, and the React ones stay in `index.ts`.
 *
 * Import from `@integr8/i18n/core` in anything that runs on a server; import
 * from `@integr8/i18n` in anything that renders.
 */

export * from './locales.js';
export * from './format.js';
export { en, type Messages } from './messages/en.js';
export { ar, type Catalogue } from './messages/ar.js';

import { directionFor, type Direction, type Locale } from './locales.js';

/**
 * The direction a document should use: the locale's own. Arabic reads right
 * to left, English left to right, and nothing else decides it.
 */
export function resolveDirection(locale: Locale): Direction {
  return directionFor(locale);
}
