import type { MediaReference } from '@integr8/form-engine';
import {
  discardUnusedUpload,
  type LocalMedia,
  localMedia,
  mediaIdsIn,
  queueUpload,
} from '@integr8/offline';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { deleteLocalFiles } from '~/local/device';
import { localData } from '~/local/local-data';
import { useLocalQuery } from '~/local/react';
import { localFile } from '~/local/sync-device';
import type { CapturedFile } from './capture';

/**
 * Files in a form on the phone: captured, queued for upload with the job, and
 * shown from the phone's own copy while they wait and after they have gone.
 *
 * An answer names a file by the id the server will know it by, which the phone
 * chooses when the file is queued — so a form can be finished and submitted
 * offline, and the submission waits in the outbox until its files have arrived.
 */

export interface FormMedia {
  /** Queues captured files for upload and returns what the answer stores. */
  add: (files: readonly CapturedFile[]) => Promise<MediaReference[]>;
  /** Takes a file back out: its upload is dropped if nothing else names it. */
  remove: (reference: MediaReference) => Promise<void>;
  /** The phone's copies of the files the answers name. */
  local: ReadonlyMap<string, LocalMedia>;
}

const Context = createContext<FormMedia | undefined>(undefined);

export function FormMediaProvider({
  workOrderId,
  answers,
  settled,
  children,
}: {
  workOrderId: string | null;
  answers: Readonly<Record<string, unknown>>;
  /** Resolves once the answers as shown are saved, so a removed file is no longer named. */
  settled: () => Promise<void>;
  children: ReactNode;
}) {
  const ids = [...new Set(mediaIdsIn(answers))].sort();
  const state = useLocalQuery(`form-media:${ids.join(',')}`, ['uploads'], (sql) =>
    localMedia(sql, ids),
  );
  const local = state.status === 'ready' ? state.data : EMPTY;

  const value = useMemo<FormMedia>(
    () => ({
      add: async (files) => {
        const context = localData.changeContext();
        if (context === undefined) {
          throw new Error('The phone’s database is not open.');
        }
        const references: MediaReference[] = [];
        for (const file of files) {
          const mediaId = await queueUpload(context, {
            localPath: file.localPath,
            ...(file.thumbnailPath === undefined ? {} : { thumbnailPath: file.thumbnailPath }),
            contentType: file.contentType,
            byteSize: file.byteSize,
            workOrderId,
          });
          references.push({ mediaId, contentType: file.contentType, byteSize: file.byteSize });
        }
        return references;
      },
      remove: async (reference) => {
        await settled().catch(() => undefined);
        const context = localData.changeContext();
        if (context === undefined) {
          return;
        }
        deleteLocalFiles(await discardUnusedUpload(context.db, reference.mediaId));
      },
      local,
    }),
    [workOrderId, local, settled],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

const EMPTY: ReadonlyMap<string, LocalMedia> = new Map();

export function useFormMedia(): FormMedia {
  const media = useContext(Context);
  if (media === undefined) {
    throw new Error('useFormMedia needs a FormMediaProvider.');
  }
  return media;
}

/** A URI an `Image` can show for a file on the phone, preferring its thumbnail. */
export function imageUri(file: LocalMedia | undefined, thumbnail = true): string | undefined {
  if (file === undefined) {
    return undefined;
  }
  const path = thumbnail ? (file.thumbnailPath ?? file.localPath) : file.localPath;
  const stored = localFile(path);
  return stored.exists ? stored.uri : undefined;
}
