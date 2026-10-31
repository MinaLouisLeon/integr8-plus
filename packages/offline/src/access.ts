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
 */

export type Permission = Me['permissions'][number];

export interface LocalAccess {
  permissions: ReadonlySet<string>;
  features: Readonly<Record<string, boolean>>;
}

/** Keeps what `/v1/me` said. */
export async function saveAccess(
  sql: SqlConnection,
  me: Pick<Me, 'permissions' | 'features'>,
): Promise<void> {
  for (const [key, value] of Object.entries({
    permissions: JSON.stringify(me.permissions),
    features: JSON.stringify(me.features),
  })) {
    await sql.run(
      `insert into meta (key, value) values (?, ?)
       on conflict (key) do update set value = excluded.value`,
      [key, value],
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
