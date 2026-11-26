/**
 * The apps' releases on GitHub (P20; P42): which installers and update
 * manifests exist for the staff app, a company's app and Integr8 Forms for AI.
 *
 * Read by the public site (the desktop update feed and its file pass-through)
 * and by the API (the staff app's Downloads list, a company's installers for
 * whoever has just accepted an invitation, and whether a company's own desktop
 * app has been built before its owner is invited). No framework inside: plain
 * `fetch`.
 */
export * from './feed.js';
export * from './lookup.js';
