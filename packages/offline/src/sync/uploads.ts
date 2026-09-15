import { ApiRequestError } from '@integr8/api-client';
import type { LocalDatabase } from '../database.js';
import type { SqlConnection } from '../sql.js';
import type { DeviceClock } from './clock.js';
import { backoffSeconds, MAX_ATTEMPTS } from './outbox.js';
import type { ByteTransport, FileSource, SyncApi } from './transport.js';

/**
 * The upload queue: photos, signatures and files, apart from the changes (P12).
 *
 * A stuck 25 MB video waits here without holding up the job's answers or its
 * completion — only a form naming that file waits for it.
 *
 * **Resumable.** A file up to 8 MiB goes in one request; a larger one goes in
 * 8 MiB parts, and after every part the phone records that it arrived. If the
 * app is killed or the signal drops, the next run asks the server which parts it
 * already holds and sends only the rest. The id is chosen on the phone, so asking
 * the server to start the same upload again is harmless: it answers where that
 * upload stands.
 */

export interface UploadRow {
  mediaId: string;
  localPath: string;
  contentType: string;
  byteSize: number;
  workOrderId: string | null;
  attempts: number;
  bytesSent: number;
}

export type UploadOutcome =
  | { outcome: 'confirmed'; bytesSent: number }
  | { outcome: 'retry'; code: string; bytesSent: number }
  | { outcome: 'failed'; code: string; bytesSent: number }
  | { outcome: 'offline'; bytesSent: number };

export class NoConnectionError extends Error {
  constructor(cause?: unknown) {
    super('No connection.', { cause });
    this.name = 'NoConnectionError';
  }
}

/** Uploads waiting to go now, oldest first. */
export async function dueUploads(
  db: LocalDatabase,
  deviceNow: Date,
  limit = 20,
): Promise<UploadRow[]> {
  const rows = await db.read((sql) =>
    sql.all<{
      media_id: string;
      local_path: string;
      content_type: string;
      byte_size: number;
      work_order_id: string | null;
      attempts: number;
      bytes_sent: number;
    }>(
      `select media_id, local_path, content_type, byte_size, work_order_id, attempts, bytes_sent
       from uploads
       where state = 'queued' and (next_attempt_at is null or next_attempt_at <= ?)
       order by created_at, media_id
       limit ?`,
      [deviceNow.toISOString(), limit],
    ),
  );
  return rows.map((row) => ({
    mediaId: row.media_id,
    localPath: row.local_path,
    contentType: row.content_type,
    byteSize: row.byte_size,
    workOrderId: row.work_order_id,
    attempts: row.attempts,
    bytesSent: row.bytes_sent,
  }));
}

function isTransient(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status >= 500 || error.status === 429);
}

function isNoConnection(error: unknown): boolean {
  return error instanceof NoConnectionError || error instanceof TypeError;
}

export async function uploadOne(
  db: LocalDatabase,
  api: SyncApi,
  files: FileSource,
  transport: ByteTransport,
  clock: DeviceClock,
  upload: UploadRow,
): Promise<UploadOutcome> {
  let bytesSent = 0;
  const finish = async (outcome: UploadOutcome): Promise<UploadOutcome> => {
    const now = clock.now();
    await db.write(['uploads', 'files'], async (sql) => {
      switch (outcome.outcome) {
        case 'confirmed':
          await sql.run(
            `update uploads set state = 'confirmed', confirmed_at = ?, bytes_sent = byte_size, last_error = null
             where media_id = ?`,
            [now.toISOString(), upload.mediaId],
          );
          // The local copy is an ordinary downloaded file now, evicted like one.
          await sql.run(
            `update files set state = 'downloaded', last_opened_at = ? where id = ? and state = 'pending_upload'`,
            [now.toISOString(), upload.mediaId],
          );
          break;
        case 'failed':
          await sql.run(`update uploads set state = 'failed', last_error = ? where media_id = ?`, [
            JSON.stringify({ code: outcome.code }),
            upload.mediaId,
          ]);
          break;
        case 'retry': {
          const attempts = upload.attempts + 1;
          await sql.run(
            `update uploads set attempts = ?, next_attempt_at = ?, last_error = ?,
               state = case when ? >= ? then 'failed' else state end
             where media_id = ?`,
            [
              attempts,
              new Date(now.getTime() + backoffSeconds(attempts) * 1000).toISOString(),
              JSON.stringify({ code: outcome.code }),
              attempts,
              MAX_ATTEMPTS,
              upload.mediaId,
            ],
          );
          break;
        }
        case 'offline':
          break;
      }
    });
    return outcome;
  };

  try {
    if (!(await files.exists(upload.localPath))) {
      return await finish({ outcome: 'failed', code: 'file_missing', bytesSent });
    }
    const prepared = await api.prepareUpload(upload.mediaId, {
      contentType: upload.contentType,
      byteSize: upload.byteSize,
    });

    if (prepared.upload !== null) {
      if (prepared.upload.kind === 'single') {
        const bytes = await files.read(upload.localPath, 0, upload.byteSize);
        const sent = await transport.put(prepared.upload.url, prepared.upload.headers, bytes);
        if (sent.status >= 300) {
          return await finish({
            outcome: 'retry',
            code: `storage_${String(sent.status)}`,
            bytesSent,
          });
        }
        bytesSent += bytes.byteLength;
      } else {
        const { partSize, partCount } = prepared.upload;
        const arrived = new Set(
          (await api.arrivedParts(upload.mediaId)).arrived.map((part) => part.number),
        );
        const missing = Array.from({ length: partCount }, (_, index) => index + 1).filter(
          (number) => !arrived.has(number),
        );
        for (let start = 0; start < missing.length; start += 10) {
          const links = await api.partLinks(upload.mediaId, missing.slice(start, start + 10));
          for (const link of links.parts) {
            const offset = (link.number - 1) * partSize;
            const bytes = await files.read(upload.localPath, offset, link.byteSize);
            const sent = await transport.put(link.url, link.headers, bytes);
            if (sent.status >= 300) {
              return await finish({
                outcome: 'retry',
                code: `storage_${String(sent.status)}`,
                bytesSent,
              });
            }
            bytesSent += bytes.byteLength;
            arrived.add(link.number);
            // Recorded after each part, so a killed app knows how far it got.
            await db.write(['uploads'], (sql) =>
              sql.run(
                `update uploads set kind = 'multipart', part_size = ?, part_count = ?, parts_done = ?,
                   bytes_sent = ? where media_id = ?`,
                [
                  partSize,
                  partCount,
                  JSON.stringify([...arrived].sort((a, b) => a - b)),
                  Math.min(upload.byteSize, arrived.size * partSize),
                  upload.mediaId,
                ],
              ),
            );
          }
        }
      }
    }

    await api.completeUpload(upload.mediaId);
    return await finish({ outcome: 'confirmed', bytesSent });
  } catch (error) {
    if (isNoConnection(error)) {
      return finish({ outcome: 'offline', bytesSent });
    }
    if (error instanceof ApiRequestError) {
      if (
        isTransient(error) ||
        error.code === 'upload_incomplete' ||
        error.code === 'upload_expired'
      ) {
        return finish({ outcome: 'retry', code: error.code, bytesSent });
      }
      return finish({ outcome: 'failed', code: error.code, bytesSent });
    }
    return finish({ outcome: 'retry', code: 'unexpected', bytesSent });
  }
}

/** A file that failed to upload is tried again from where it stands. */
export async function retryUpload(db: LocalDatabase, mediaId: string): Promise<void> {
  await db.write(['uploads'], (sql) =>
    sql.run(
      `update uploads set state = 'queued', attempts = 0, next_attempt_at = null, last_error = null
       where media_id = ? and state = 'failed'`,
      [mediaId],
    ),
  );
}

export interface UploadProgress {
  mediaId: string;
  workOrderId: string | null;
  contentType: string;
  byteSize: number;
  bytesSent: number;
  state: 'queued' | 'failed';
  error: string | null;
}

/** Files still to reach the server, for the sync screen. */
export async function uploadsInProgress(sql: SqlConnection): Promise<UploadProgress[]> {
  const rows = await sql.all<{
    media_id: string;
    work_order_id: string | null;
    content_type: string;
    byte_size: number;
    bytes_sent: number;
    state: 'queued' | 'failed';
    last_error: string | null;
  }>(
    `select media_id, work_order_id, content_type, byte_size, bytes_sent, state, last_error
     from uploads where state <> 'confirmed' order by state desc, created_at`,
  );
  return rows.map((row) => ({
    mediaId: row.media_id,
    workOrderId: row.work_order_id,
    contentType: row.content_type,
    byteSize: row.byte_size,
    bytesSent: row.bytes_sent,
    state: row.state,
    error: row.last_error === null ? null : (JSON.parse(row.last_error) as { code: string }).code,
  }));
}
