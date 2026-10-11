import { tagCodeOf } from '@integr8/core';
import type { PullPage } from './api-types.js';
import type { SqlConnection } from './sql.js';

/**
 * Assets on the phone (CRM/ERP plan, phase E3; ADR-0008): the machines at the
 * sites of the engineer's jobs, each with its whole history, so a tag scanned
 * in a plant room with no signal opens from here.
 *
 * Each pull says which sites' assets it carries in full (`assetSiteIds`), and
 * those sites' assets are replaced as a set: an asset moved to a site not on
 * the phone disappears from the old one. An asset registered on this phone is
 * kept until the server confirms it, and a condition recorded here shows on
 * top of what the server sent until it is sent.
 */

export type AssetSync = PullPage['assets'][number];
export type AssetTimelineEntry = AssetSync['timeline'][number];

/** What the phone shows for an asset: the server's body, its jobs, and whether it is still only here. */
export interface LocalAsset {
  data: AssetSync;
  workOrderIds: string[];
  /** Registered on this phone and not yet confirmed by the server. */
  local: boolean;
}

interface AssetRow {
  id: string;
  data: string;
  local: number;
}

/** Outbox kinds that change an asset the phone shows. */
export const ASSET_CHANGE_KINDS = ['asset.register', 'asset.condition', 'asset.link'] as const;

/** Assets registered here whose registration has not been confirmed: a pull must not drop them. */
export const UNSENT_ASSET_IDS = `select entity_id from outbox where kind = 'asset.register' and state <> 'done'`;

export async function writeAsset(
  sql: SqlConnection,
  data: AssetSync,
  workOrderIds: readonly string[],
  at: string,
  local = false,
): Promise<void> {
  await sql.run(
    `insert into assets (id, site_id, customer_id, reference, name, tag_code, serial_number, status, data, local, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (id) do update set
       site_id = excluded.site_id, customer_id = excluded.customer_id, reference = excluded.reference,
       name = excluded.name, tag_code = excluded.tag_code, serial_number = excluded.serial_number,
       status = excluded.status, data = excluded.data, local = excluded.local, updated_at = excluded.updated_at`,
    [
      data.asset.id,
      data.asset.site.id,
      data.asset.customer.id,
      data.asset.reference,
      data.asset.name,
      data.asset.tagCode === '' ? null : data.asset.tagCode,
      data.asset.serialNumber === null ? null : data.asset.serialNumber.trim().toLowerCase(),
      data.asset.status,
      JSON.stringify(data),
      local ? 1 : 0,
      at,
    ],
  );
  for (const workOrderId of workOrderIds) {
    await sql.run(
      `insert into asset_links (asset_id, work_order_id) values (?, ?) on conflict do nothing`,
      [data.asset.id, workOrderId],
    );
  }
}

/**
 * The assets of a pulled page: those of `assetSiteIds` are replaced as a
 * set, except the ones registered here and not yet confirmed; then the
 * phone's own unsent conditions and links go back on top.
 */
export async function applyPulledAssets(
  sql: SqlConnection,
  page: Pick<PullPage, 'assetSiteIds' | 'assets'> & { workOrders?: readonly unknown[] },
  at: string,
): Promise<void> {
  // Whether this company has assets for this person: a page with jobs says so
  // by carrying their sites, or by carrying none. A page without jobs says nothing.
  if (page.workOrders !== undefined && page.workOrders.length > 0) {
    await sql.run(
      `insert into meta (key, value) values ('assets_enabled', ?)
       on conflict (key) do update set value = excluded.value`,
      [page.assetSiteIds.length > 0 ? '1' : '0'],
    );
  }
  if (page.assetSiteIds.length === 0) {
    return;
  }
  const sites = JSON.stringify(page.assetSiteIds);
  await sql.run(
    `delete from asset_links where asset_id in (
       select id from assets where site_id in (select value from json_each(?)) and id not in (${UNSENT_ASSET_IDS}))`,
    [sites],
  );
  await sql.run(
    `delete from assets where site_id in (select value from json_each(?)) and id not in (${UNSENT_ASSET_IDS})`,
    [sites],
  );
  for (const entry of page.assets) {
    // A confirmed registration arrives as the server's asset: this replaces the local one.
    await sql.run('delete from asset_links where asset_id = ?', [entry.asset.id]);
    await writeAsset(
      sql,
      entry,
      entry.workOrders.map((job) => job.id),
      at,
    );
  }
  await reapplyPending(
    sql,
    page.assets.map((entry) => entry.asset.id),
  );
}

/** Puts the phone's unsent conditions and links back on assets the server just sent. */
async function reapplyPending(sql: SqlConnection, assetIds: readonly string[]): Promise<void> {
  if (assetIds.length === 0) {
    return;
  }
  const pending = await sql.all<{
    id: string;
    kind: string;
    entity_id: string;
    payload: string;
    recorded_at: string;
  }>(
    `select id, kind, entity_id, payload, recorded_at from outbox
      where state = 'pending' and kind in ('asset.condition', 'asset.link')
      order by seq`,
  );
  const wanted = new Set(assetIds);
  const actor = await actorOf(sql);
  for (const change of pending) {
    const payload = JSON.parse(change.payload) as Record<string, unknown>;
    if (change.kind === 'asset.condition' && wanted.has(change.entity_id)) {
      await applyConditionLocally(sql, change.entity_id, {
        id: change.id,
        condition: payload.condition as ConditionValue,
        note: (payload.note as string | null | undefined) ?? null,
        workOrderId: (payload.workOrderId as string | null | undefined) ?? null,
        at: change.recorded_at,
        actor,
      });
    }
    if (change.kind === 'asset.link' && wanted.has(payload.assetId as string)) {
      await sql.run(
        `insert into asset_links (asset_id, work_order_id) values (?, ?) on conflict do nothing`,
        [payload.assetId as string, change.entity_id],
      );
    }
  }
}

export type ConditionValue = NonNullable<AssetSync['asset']['condition']>;

/** Shows a condition recorded on the phone: on the asset, and first on its history. */
export async function applyConditionLocally(
  sql: SqlConnection,
  assetId: string,
  change: {
    id: string;
    condition: ConditionValue;
    note: string | null;
    workOrderId: string | null;
    at: string;
    actor: { id: string; name: string };
  },
): Promise<void> {
  const row = await sql.get<AssetRow>('select id, data, local from assets where id = ?', [assetId]);
  if (row === undefined) {
    return;
  }
  const data = JSON.parse(row.data) as AssetSync;
  if (data.timeline.some((entry) => entry.id === change.id)) {
    return;
  }
  const recordedAt = data.asset.conditionRecordedAt;
  const newer = recordedAt === null || recordedAt <= change.at;
  const next: AssetSync = {
    ...data,
    asset: newer
      ? {
          ...data.asset,
          condition: change.condition,
          conditionRecordedAt: change.at,
          conditionRecordedBy: change.actor,
        }
      : data.asset,
    timeline: [
      {
        kind: 'event' as const,
        id: change.id,
        at: change.at,
        event: {
          kind: 'condition_recorded' as const,
          fromSite: null,
          fromStatus: null,
          toStatus: null,
          condition: change.condition,
          changes: null,
          workOrderId: change.workOrderId,
          note: change.note,
          by: change.actor,
        },
      },
      ...data.timeline,
    ].sort((a, b) => b.at.localeCompare(a.at)),
  };
  await sql.run('update assets set data = ? where id = ?', [JSON.stringify(next), assetId]);
}

async function actorOf(sql: SqlConnection): Promise<{ id: string; name: string }> {
  const rows = await sql.all<{ key: string; value: string }>(
    `select key, value from meta where key in ('user_id', 'display_name')`,
  );
  const meta = new Map(rows.map((row) => [row.key, row.value]));
  return { id: meta.get('user_id') ?? '', name: meta.get('display_name') ?? '' };
}

/** Drops assets whose site is no longer on the phone, keeping unconfirmed registrations. */
export async function evictAssets(sql: SqlConnection): Promise<number> {
  await sql.run(
    `delete from asset_links where asset_id in (
       select id from assets where site_id not in (select id from sites) and id not in (${UNSENT_ASSET_IDS}))`,
  );
  return (
    await sql.run(
      `delete from assets where site_id not in (select id from sites) and id not in (${UNSENT_ASSET_IDS})`,
    )
  ).changes;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Whether the last pull with jobs said this person works with assets. */
export async function assetsEnabled(sql: SqlConnection): Promise<boolean> {
  const row = await sql.get<{ value: string }>(
    `select value from meta where key = 'assets_enabled'`,
  );
  return row?.value === '1';
}

async function linksOf(sql: SqlConnection, assetId: string): Promise<string[]> {
  return (
    await sql.all<{ work_order_id: string }>(
      'select work_order_id from asset_links where asset_id = ? order by work_order_id',
      [assetId],
    )
  ).map((row) => row.work_order_id);
}

async function toLocal(sql: SqlConnection, row: AssetRow): Promise<LocalAsset> {
  return {
    data: JSON.parse(row.data) as AssetSync,
    workOrderIds: await linksOf(sql, row.id),
    local: row.local === 1,
  };
}

export async function localAsset(
  sql: SqlConnection,
  assetId: string,
): Promise<LocalAsset | undefined> {
  const row = await sql.get<AssetRow>('select id, data, local from assets where id = ?', [assetId]);
  return row === undefined ? undefined : toLocal(sql, row);
}

/**
 * The asset a scanned code names, from the phone's own copy: a tag link from
 * any host, a bare code, or — for a manufacturer's plate — a serial number.
 */
export async function assetByScan(
  sql: SqlConnection,
  scanned: string,
): Promise<LocalAsset | undefined> {
  const code = tagCodeOf(scanned);
  const row =
    code === undefined
      ? await sql.get<AssetRow>('select id, data, local from assets where serial_number = ?', [
          scanned.trim().toLowerCase(),
        ])
      : await sql.get<AssetRow>('select id, data, local from assets where tag_code = ?', [code]);
  return row === undefined ? undefined : toLocal(sql, row);
}

/** A site's assets on the phone, by number. */
export async function assetsAtSite(sql: SqlConnection, siteId: string): Promise<LocalAsset[]> {
  const rows = await sql.all<AssetRow>(
    `select id, data, local from assets where site_id = ? order by local desc, reference`,
    [siteId],
  );
  return Promise.all(rows.map((row) => toLocal(sql, row)));
}

/** The assets a job is for, as the phone knows them. */
export async function assetsOfJob(sql: SqlConnection, workOrderId: string): Promise<LocalAsset[]> {
  const rows = await sql.all<AssetRow>(
    `select a.id, a.data, a.local from assets a
       join asset_links l on l.asset_id = a.id
      where l.work_order_id = ?
      order by a.reference`,
    [workOrderId],
  );
  return Promise.all(rows.map((row) => toLocal(sql, row)));
}

/** Photos and documents in assets' histories that are not on the phone yet. */
export interface AssetFileToFetch {
  fileId: string;
  siteId: string;
  title: string;
  contentType: string;
  byteSize: number;
}

export function assetFilesIn(data: AssetSync): Omit<AssetFileToFetch, 'siteId'>[] {
  const files: Omit<AssetFileToFetch, 'siteId'>[] = [];
  for (const entry of data.timeline) {
    if (entry.kind === 'attachment') {
      files.push({
        fileId: entry.attachment.fileId,
        title: entry.attachment.title,
        contentType: entry.attachment.contentType,
        byteSize: entry.attachment.byteSize,
      });
    }
    if (entry.kind === 'submission') {
      for (const photo of entry.submission.photos) {
        files.push({
          fileId: photo.mediaId,
          title: entry.submission.form.name,
          contentType: photo.contentType,
          byteSize: photo.byteSize,
        });
      }
    }
  }
  return files;
}
