import type { Me } from './api-types.js';
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
