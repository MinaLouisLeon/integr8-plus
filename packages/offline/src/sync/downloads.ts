import type { LocalDatabase } from '../database.js';
import type { SqlConnection } from '../sql.js';
import type { SyncApi, ByteTransport } from './transport.js';

/**
 * Files a job carries — the site plan, the manual, last year's report — kept on
 * the phone so they open in a basement (P14).
 *
 * After each pull the engine fetches the attachments of open jobs it does not
 * have yet, a few at a time, skipping anything large: a 60 MB manual is fetched
 * when the engineer opens it with signal, not in the background. Photos the
 * engineer took are already on the phone and are never fetched back. The P11
 * budget decides what stays: least recently opened goes first.
 */

export const DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const DOWNLOADS_PER_RUN = 20;

export interface AttachmentToFetch {
  fileId: string;
  workOrderId: string;
  title: string;
  contentType: string;
  byteSize: number;
}

/** Relative to the files directory. */
export const attachmentPath = (fileId: string) => `attachments/${fileId}`;

export async function attachmentsToFetch(
  db: LocalDatabase,
  limit = DOWNLOADS_PER_RUN,
): Promise<AttachmentToFetch[]> {
  return db.read((sql) =>
    sql.all<AttachmentToFetch>(
      `select json_extract(a.value, '$.fileId') as fileId, w.id as workOrderId,
              json_extract(a.value, '$.title') as title,
              json_extract(a.value, '$.contentType') as contentType,
              json_extract(a.value, '$.byteSize') as byteSize
         from work_orders w, json_each(w.data, '$.attachments') a
        where w.closed_at is null
          and json_extract(a.value, '$.stage') is null
          and json_extract(a.value, '$.byteSize') <= ?
          and json_extract(a.value, '$.fileId') not in (select id from files)
          and json_extract(a.value, '$.fileId') not in (select media_id from uploads)
        order by coalesce(w.due_by, '9999') asc, w.id
        limit ?`,
      [DOWNLOAD_MAX_BYTES, limit],
    ),
  );
}

/** Fetches one attachment to the phone. Resolves whether it is now there. */
export async function fetchAttachment(
  db: LocalDatabase,
  api: SyncApi,
  transport: ByteTransport,
  attachment: AttachmentToFetch,
  now: Date,
): Promise<boolean> {
  const link = await api.mediaLink(attachment.fileId);
  if (link === undefined) {
    return false;
  }
  const path = attachmentPath(attachment.fileId);
  const response = await transport.download(link.url, path);
  if (response.status !== 200) {
    return false;
  }
  await db.write(['files'], (sql) =>
    sql.run(
      `insert into files (id, owner_kind, owner_id, name, content_type, byte_size, local_path, state, created_at)
       values (?, 'work_order', ?, ?, ?, ?, ?, 'downloaded', ?)
       on conflict (id) do nothing`,
      [
        attachment.fileId,
        attachment.workOrderId,
        attachment.title,
        attachment.contentType,
        attachment.byteSize,
        path,
        now.toISOString(),
      ],
    ),
  );
  return true;
}

/** Where the phone keeps files it downloaded, by file id: paths relative to the files directory. */
export async function downloadedFiles(
  sql: SqlConnection,
  fileIds: readonly string[],
): Promise<Map<string, string>> {
  if (fileIds.length === 0) {
    return new Map();
  }
  const rows = await sql.all<{ id: string; local_path: string }>(
    `select id, local_path from files
     where state = 'downloaded' and id in (${fileIds.map(() => '?').join(', ')})`,
    [...fileIds],
  );
  return new Map(rows.map((row) => [row.id, row.local_path]));
}

/** Records that a file was opened, so the budget keeps it longest. */
export async function markOpened(db: LocalDatabase, fileId: string, now: Date): Promise<void> {
  await db.write(['files'], (sql) =>
    sql.run('update files set last_opened_at = ? where id = ?', [now.toISOString(), fileId]),
  );
}
