import { CLOSED_WORK_ORDER_STATES } from '@integr8/core';
import type { Me, WorkOrderDetail } from './api-types.js';
import { identity } from './queries.js';
import type { SqlConnection } from './sql.js';

/**
 * What the signed-in person may do, and which modules their company has, as
 * the server last said (`/v1/me`). The phone offers a screen only to those it
 * is for — receiving goods to the store, payslips where payroll is on — and
 * offers it offline too, so the screen can say it needs a connection rather
 * than vanish. The server decides every request all the same.
 *
 * The announcements in the same answer are kept beside them (P15, P17): the
 * notices Integr8 posts — planned maintenance, a payment reminder — shown on
 * the phone as last heard, so one posted yesterday still shows in a basement.
 */

export type Permission = Me['permissions'][number];

export interface LocalAccess {
  permissions: ReadonlySet<string>;
  features: Readonly<Record<string, boolean>>;
}

export type Announcement = Me['announcements'][number];

async function setMeta(sql: SqlConnection, key: string, value: string): Promise<void> {
  await sql.run(
    `insert into meta (key, value) values (?, ?)
     on conflict (key) do update set value = excluded.value`,
    [key, value],
  );
}

async function readJson<T>(sql: SqlConnection, key: string, fallback: T): Promise<T> {
  const row = await sql.get<{ value: string }>('select value from meta where key = ?', [key]);
  if (row === undefined) {
    return fallback;
  }
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Keeps what `/v1/me` said.
 *
 * Announcements are replaced whole, and the ones dismissed on this phone are
 * forgotten once the server stops sending them, so the list cannot grow.
 */
export async function saveAccess(
  sql: SqlConnection,
  me: Pick<Me, 'permissions' | 'features'> & Partial<Pick<Me, 'announcements'>>,
): Promise<void> {
  await setMeta(sql, 'permissions', JSON.stringify(me.permissions));
  await setMeta(sql, 'features', JSON.stringify(me.features));
  if (me.announcements !== undefined) {
    const ids = new Set(me.announcements.map((announcement) => announcement.id));
    const dismissed = await readJson<string[]>(sql, 'announcements_dismissed', []);
    await setMeta(sql, 'announcements', JSON.stringify(me.announcements));
    await setMeta(
      sql,
      'announcements_dismissed',
      JSON.stringify(dismissed.filter((id) => ids.has(id))),
    );
  }
}

/** What the person may do, as last heard; nothing before the server has said. */
export async function access(sql: SqlConnection): Promise<LocalAccess> {
  const rows = await sql.all<{ key: string; value: string }>(
    `select key, value from meta where key in ('permissions', 'features')`,
  );
  const meta = new Map(rows.map((row) => [row.key, row.value]));
  const permissions = meta.get('permissions');
  const features = meta.get('features');
  return {
    permissions: new Set(permissions === undefined ? [] : (JSON.parse(permissions) as string[])),
    features: features === undefined ? {} : (JSON.parse(features) as Record<string, boolean>),
  };
}

/** Whether `granted` holds `permission`, and the company has `feature` switched on. */
export function allows(granted: LocalAccess, permission: Permission, feature?: string): boolean {
  return (
    granted.permissions.has(permission) &&
    (feature === undefined || granted.features[feature] === true)
  );
}

/**
 * The announcements to show now: as last heard, without those that have ended
 * since — the phone's clock decides that offline — or that were dismissed on
 * this phone. One that cannot be dismissed always shows.
 */
export async function announcements(sql: SqlConnection, now: Date): Promise<Announcement[]> {
  const kept = await readJson<Announcement[]>(sql, 'announcements', []);
  const dismissed = new Set(await readJson<string[]>(sql, 'announcements_dismissed', []));
  return kept.filter(
    (announcement) =>
      (announcement.endsAt === null || new Date(announcement.endsAt) > now) &&
      !(announcement.dismissible && dismissed.has(announcement.id)),
  );
}

/** Hides one announcement on this phone. The server is not told: it is this person's screen. */
export async function dismissAnnouncement(sql: SqlConnection, id: string): Promise<void> {
  const dismissed = await readJson<string[]>(sql, 'announcements_dismissed', []);
  if (!dismissed.includes(id)) {
    await setMeta(sql, 'announcements_dismissed', JSON.stringify([...dismissed, id]));
  }
}

/** An announcement's words in `language`, or in English, or in whatever language it has. */
export function announcementText(announcement: Announcement, language: string): string {
  const message = announcement.message;
  return message[language] ?? message.en ?? Object.values(message)[0] ?? '';
}

/**
 * Whether the phone should offer to correct a site's access notes: the office,
 * or someone on the crew of an open job at the site, as the phone last heard.
 *
 * The same rule the server applies when the change arrives (`updateAccessNotes`).
 * Asking it here only keeps the button from an engineer who would be refused;
 * a job that closes while the phone is offline is still refused on arrival.
 */
export async function mayCorrectAccess(sql: SqlConnection, siteId: string): Promise<boolean> {
  const granted = await access(sql);
  if (granted.permissions.has('customer.manage')) {
    return true;
  }
  const me = await identity(sql);
  if (!granted.permissions.has('work_order.progress') || me === undefined) {
    return false;
  }
  const closed = CLOSED_WORK_ORDER_STATES.map(() => '?').join(', ');
  const jobs = await sql.all<{ data: string }>(
    `select data from work_orders where site_id = ? and state not in (${closed})`,
    [siteId, ...CLOSED_WORK_ORDER_STATES],
  );
  return jobs.some((row) =>
    (JSON.parse(row.data) as WorkOrderDetail).crew.some((member) => member.id === me.userId),
  );
}
