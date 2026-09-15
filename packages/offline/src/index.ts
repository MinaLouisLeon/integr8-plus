/**
 * `@integr8/offline` — the phone's data, without the phone.
 *
 * The local database, its migrations and queries, and the sync engine that
 * keeps it and the server in step (P11, P12). Nothing here imports React
 * Native or Expo: the app supplies SQLite, files, the network and the clock,
 * and the same code runs in Node against real SQLite and a real API in tests.
 */

export type * from './api-types.js';
export * from './database.js';
export * from './eviction.js';
export * from './forms.js';
export * from './migrations.js';
export * from './queries.js';
export * from './search.js';
export * from './snapshot.js';
export type * from './sql.js';
export * from './watch.js';
export * from './wipe.js';
export * from './unsent.js';
export * from './sync/clock.js';
export * from './sync/engine.js';
export * from './sync/ids.js';
export * from './sync/outbox.js';
export * from './sync/overlay.js';
export * from './sync/pull.js';
export * from './sync/transport.js';
export * from './sync/uploads.js';
