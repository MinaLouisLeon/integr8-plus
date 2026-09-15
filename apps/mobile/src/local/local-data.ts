import { ApiRequestError } from '@integr8/api-client';
import {
  type ChangeContext,
  identity,
  IdentityChangedError,
  type LocalDatabase,
  LocalDatabaseTooNewError,
  MigrationFailedError,
  SyncEngine,
  type SyncRunSummary,
  type SyncTrigger,
  syncApiFor,
  systemClock,
  wipeLocalData,
} from '@integr8/offline';
import * as Sentry from '@sentry/react-native';
import { APP_VERSION, session } from '~/lib/session';
import {
  deleteLocalFiles,
  deviceWipeSteps,
  LocalDatabaseNotEncryptedError,
  openDeviceDatabase,
} from './device';
import { deviceConditions, deviceFiles, deviceTransport, random } from './sync-device';

/**
 * The phone's data, for the whole app: open it, keep it in step with the
 * server, wipe it.
 *
 * One instance, outside React, because the session ends outside React — a
 * refresh refused by the server calls back from the API client, and the wipe it
 * triggers must not depend on which screen happens to be mounted.
 */

export type LocalStatus =
  | { phase: 'closed' }
  | { phase: 'opening' }
  | { phase: 'open'; db: LocalDatabase; cipherVersion: string; engine: SyncEngine }
  | { phase: 'failed'; reason: 'too_new' | 'migration_failed' | 'not_encrypted' | 'unknown' };

export interface SyncState {
  running: boolean;
  /** Why the last run did not finish, if it did not. */
  problem: 'offline' | 'sign_in_needed' | 'failed' | undefined;
  lastRun: SyncRunSummary | undefined;
}

type Listener = () => void;

class LocalData {
  #status: LocalStatus = { phase: 'closed' };
  #sync: SyncState = { running: false, problem: undefined, lastRun: undefined };
  readonly #listeners = new Set<Listener>();
  #opening: Promise<LocalDatabase | undefined> | undefined;
  #wiping: Promise<void> | undefined;
  /** Set by a wipe: nothing reopens the database until somebody signs in. */
  #wiped = false;

  readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly status = (): LocalStatus => this.#status;

  readonly syncState = (): SyncState => this.#sync;

  /** What P13 and P14's screens record changes with. Undefined until the database is open. */
  changeContext(): ChangeContext | undefined {
    return this.#status.phase === 'open'
      ? { db: this.#status.db, clock: systemClock, random }
      : undefined;
  }

  /** Opens the database, upgrading it if this build is newer. Resolves undefined if it cannot. */
  open(): Promise<LocalDatabase | undefined> {
    if (this.#status.phase === 'open') {
      return Promise.resolve(this.#status.db);
    }
    if (this.#wiped) {
      return Promise.resolve(undefined);
    }
    this.#opening ??= (async () => {
      await this.#wiping;
      this.#set({ phase: 'opening' });
      try {
        const { db, cipherVersion } = await openDeviceDatabase();
        const engine = new SyncEngine({
          db,
          api: syncApiFor(session().client),
          files: deviceFiles,
          transport: deviceTransport,
          clock: systemClock,
          random,
          conditions: deviceConditions,
          appVersion: APP_VERSION,
        });
        engine.subscribe(() => this.#emit());
        this.#set({ phase: 'open', db, cipherVersion, engine });
        return db;
      } catch (error) {
        Sentry.captureException(error);
        this.#set({ phase: 'failed', reason: failureReason(error) });
        return undefined;
      } finally {
        this.#opening = undefined;
      }
    })();
    return this.#opening;
  }

  /**
   * Called after signing in: a phone holding another person's or another
   * company's work is wiped before anything of theirs can be shown.
   */
  async prepareFor(signedIn: { tenantId: string; userId: string }): Promise<void> {
    await this.#wiping;
    this.#wiped = false;
    const db = await this.open();
    const stored = db === undefined ? undefined : await db.read(identity);
    if (
      stored !== undefined &&
      (stored.tenantId !== signedIn.tenantId || stored.userId !== signedIn.userId)
    ) {
      await this.wipe();
      this.#wiped = false;
      await this.open();
    }
  }

  /**
   * Sends what the phone did and fetches what changed, if the phone can. Never
   * throws: a phone with no signal is the normal case, and the screens go on
   * showing what is here. `force` is the engineer asking: uploads go even on a
   * low battery.
   */
  async sync(trigger: SyncTrigger, force = false): Promise<void> {
    if (!(await session().canReachApi())) {
      this.#setSync({ ...this.#sync, problem: 'sign_in_needed' });
      return;
    }
    await this.open();
    const status = this.#status;
    if (status.phase !== 'open') {
      return;
    }
    this.#setSync({ ...this.#sync, running: true });
    try {
      const run = await status.engine.run({ trigger, force });
      deleteLocalFiles(run.evictedFiles);
      this.#setSync({ running: false, problem: problemOf(run), lastRun: run });
      if (run.outcome === 'failed') {
        Sentry.captureException(run.error);
      }
    } catch (error) {
      if (error instanceof IdentityChangedError) {
        await this.wipe();
        this.#wiped = false;
        await this.sync(trigger, force);
        return;
      }
      Sentry.captureException(error);
      this.#setSync({ ...this.#sync, running: false, problem: 'failed' });
    }
  }

  /** Deletes the company's data from the phone. See `wipe.ts` for the order and why. */
  wipe(): Promise<void> {
    this.#wiping ??= (async () => {
      await this.#opening?.catch(() => undefined);
      const db = this.#status.phase === 'open' ? this.#status.db : undefined;
      this.#wiped = true;
      this.#set({ phase: 'closed' });
      const outcome = await wipeLocalData(deviceWipeSteps(db));
      for (const failure of outcome.failures) {
        Sentry.captureException(failure.error, { tags: { wipeStep: failure.step } });
      }
      this.#setSync({ running: false, problem: undefined, lastRun: undefined });
    })().finally(() => {
      this.#wiping = undefined;
    });
    return this.#wiping;
  }

  #set(status: LocalStatus): void {
    this.#status = status;
    this.#emit();
  }

  #setSync(state: SyncState): void {
    this.#sync = state;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

function failureReason(error: unknown): Extract<LocalStatus, { phase: 'failed' }>['reason'] {
  if (error instanceof LocalDatabaseTooNewError) {
    return 'too_new';
  }
  if (error instanceof MigrationFailedError) {
    return 'migration_failed';
  }
  if (error instanceof LocalDatabaseNotEncryptedError) {
    return 'not_encrypted';
  }
  return 'unknown';
}

function problemOf(run: SyncRunSummary): SyncState['problem'] {
  switch (run.outcome) {
    case 'complete':
    case 'partial':
      return undefined;
    case 'offline':
      return 'offline';
    case 'failed':
      return run.error instanceof ApiRequestError && run.error.status === 401
        ? 'sign_in_needed'
        : 'failed';
  }
}

export const localData = new LocalData();
