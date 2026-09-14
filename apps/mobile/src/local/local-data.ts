import { ApiRequestError } from '@integr8/api-client';
import * as Sentry from '@sentry/react-native';
import * as Network from 'expo-network';
import { session } from '~/lib/session';
import { LocalDatabaseClosedError, type LocalDatabase } from './database';
import {
  deleteLocalFiles,
  deviceWipeSteps,
  LocalDatabaseNotEncryptedError,
  openDeviceDatabase,
} from './device';
import { downloadWork, IdentityChangedError } from './download';
import { LocalDatabaseTooNewError, MigrationFailedError } from './migrations';
import { identity } from './queries';
import { wipeLocalData } from './wipe';

/**
 * The phone's data, for the whole app: open it, keep it current, wipe it.
 *
 * One instance, outside React, because the session ends outside React — a
 * refresh refused by the server calls back from the API client, and the wipe it
 * triggers must not depend on which screen happens to be mounted.
 */

export type LocalStatus =
  | { phase: 'closed' }
  | { phase: 'opening' }
  | { phase: 'open'; db: LocalDatabase; cipherVersion: string }
  | { phase: 'failed'; reason: 'too_new' | 'migration_failed' | 'not_encrypted' | 'unknown' };

export interface DownloadStatus {
  running: boolean;
  /** Why the last attempt did not update the phone, if it did not. */
  problem: 'offline' | 'sign_in_needed' | 'failed' | undefined;
  lastSucceededAt: Date | undefined;
}

type Listener = () => void;

class LocalData {
  #status: LocalStatus = { phase: 'closed' };
  #download: DownloadStatus = { running: false, problem: undefined, lastSucceededAt: undefined };
  readonly #listeners = new Set<Listener>();
  #opening: Promise<LocalDatabase | undefined> | undefined;
  #downloading: Promise<void> | undefined;
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

  readonly downloadStatus = (): DownloadStatus => this.#download;

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
        this.#set({ phase: 'open', db, cipherVersion });
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
   * Fetches the engineer's work, if the phone can. Never throws: a phone with no
   * signal is the normal case, and the screens go on showing what is here.
   */
  download(): Promise<void> {
    this.#downloading ??= this.#runDownload().finally(() => {
      this.#downloading = undefined;
    });
    return this.#downloading;
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
      this.#setDownload({ running: false, problem: undefined, lastSucceededAt: undefined });
    })().finally(() => {
      this.#wiping = undefined;
    });
    return this.#wiping;
  }

  async #runDownload(): Promise<void> {
    if (!(await session().canReachApi())) {
      this.#setDownload({ ...this.#download, problem: 'sign_in_needed' });
      return;
    }
    const network = await Network.getNetworkStateAsync();
    if (network.isConnected === false || network.isInternetReachable === false) {
      this.#setDownload({ ...this.#download, problem: 'offline' });
      return;
    }
    const db = await this.open();
    if (db === undefined) {
      return;
    }

    this.#setDownload({ ...this.#download, running: true });
    try {
      await this.#downloadInto(db);
      this.#setDownload({ running: false, problem: undefined, lastSucceededAt: new Date() });
    } catch (error) {
      this.#setDownload({ ...this.#download, running: false, problem: downloadProblem(error) });
      if (downloadProblem(error) === 'failed') {
        Sentry.captureException(error);
      }
    }
  }

  async #downloadInto(db: LocalDatabase): Promise<void> {
    try {
      const outcome = await downloadWork(session().client, db);
      deleteLocalFiles(outcome.evicted.filePaths);
    } catch (error) {
      if (!(error instanceof IdentityChangedError)) {
        throw error;
      }
      await this.wipe();
      this.#wiped = false;
      const fresh = await this.open();
      if (fresh !== undefined) {
        const outcome = await downloadWork(session().client, fresh);
        deleteLocalFiles(outcome.evicted.filePaths);
      }
    }
  }

  #set(status: LocalStatus): void {
    this.#status = status;
    this.#emit();
  }

  #setDownload(status: DownloadStatus): void {
    this.#download = status;
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

function downloadProblem(error: unknown): DownloadStatus['problem'] {
  // fetch rejects with a TypeError when there is no connection at all.
  if (error instanceof TypeError) {
    return 'offline';
  }
  // The session ended during the download (revoked, and now being wiped).
  if (error instanceof LocalDatabaseClosedError) {
    return 'sign_in_needed';
  }
  if (error instanceof ApiRequestError && error.status === 401) {
    return 'sign_in_needed';
  }
  return 'failed';
}

export const localData = new LocalData();
