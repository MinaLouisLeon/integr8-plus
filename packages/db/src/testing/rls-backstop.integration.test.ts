import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asTenant,
  connectAsApp,
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
  withUnprotectedRepositories,
} from './harness.js';

/**
 * Axis two of the isolation proof: row-level security, on its own.
 *
 * Every statement here is raw SQL issued as `integr8_app` with no `tenant_id`
 * predicate — precisely the query a broken repository would send. The
 * repository layer is not involved and the tenant guard is not attached. If a
 * policy is missing or wrong, these tests come back holding the other company's
 * rows.
 *
 * This is the backstop, not the primary control, and testing it separately is
 * what keeps that claim honest: each layer is proven to be sufficient alone, so
 * neither can quietly be covering for the other.
 */

const NORTHWIND_USER = '00000000-0000-4000-8000-00000000a101';
const SOUTHGATE_USER = '00000000-0000-4000-8000-00000000b201';

let northwind: TenantFixture;
let southgate: TenantFixture;
let app: pg.Client;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();

  northwind = await createTenant('northwind');
  southgate = await createTenant('southgate');

  await withUnprotectedRepositories(northwind.id, async (tx) => {
    await tx.tenantUsers.create({
      userId: NORTHWIND_USER,
      email: 'dana.okafor@northwind.example',
      displayName: 'Dana Okafor',
      role: 'owner',
    });
    await tx.auditLog.append({
      actorKind: 'system',
      actorLabel: 'system',
      action: 'tenant.created',
      resourceType: 'tenant',
      resourceId: northwind.id,
    });
  });

  await withUnprotectedRepositories(southgate.id, async (tx) => {
    await tx.tenantUsers.create({
      userId: SOUTHGATE_USER,
      email: 'marek.novak@southgate.example',
      displayName: 'Marek Novak',
      role: 'owner',
    });
    await tx.auditLog.append({
      actorKind: 'system',
      actorLabel: 'system',
      action: 'tenant.created',
      resourceType: 'tenant',
      resourceId: southgate.id,
    });
  });

  app = await connectAsApp();
});

afterAll(async () => {
  await app.end();
  await releaseTestDatabase();
});

describe('unfiltered reads', () => {
  it('returns only the current tenant from an unfiltered select', async () => {
    const rows = await asTenant(
      app,
      northwind.id,
      async () =>
        (await app.query<{ tenant_id: string }>('select tenant_id from tenant_users')).rows,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(northwind.id);
  });

  it('returns only the current tenant from an unfiltered audit_log select', async () => {
    const rows = await asTenant(
      app,
      southgate.id,
      async () => (await app.query<{ tenant_id: string }>('select tenant_id from audit_log')).rows,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(southgate.id);
  });

  it('shows a company only its own row in tenants', async () => {
    const rows = await asTenant(
      app,
      northwind.id,
      async () => (await app.query<{ id: string }>('select id from tenants')).rows,
    );

    expect(rows.map((row) => row.id)).toEqual([northwind.id]);
  });

  it('returns nothing at all when no tenant context is set', async () => {
    const counts = await asTenant(app, null, async () => ({
      users: (await app.query('select * from tenant_users')).rowCount,
      audit: (await app.query('select * from audit_log')).rowCount,
      tenants: (await app.query('select * from tenants')).rowCount,
    }));

    // Fail closed: no context means no rows, not all rows.
    expect(counts).toEqual({ users: 0, audit: 0, tenants: 0 });
  });

  it('returns nothing for a tenant that does not exist', async () => {
    const rowCount = await asTenant(
      app,
      '00000000-0000-4000-8000-0000000fffff',
      async () => (await app.query('select * from tenant_users')).rowCount,
    );

    expect(rowCount).toBe(0);
  });
});

describe('writes across the boundary', () => {
  it('refuses an insert stamped with another company', async () => {
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(
          `insert into tenant_users (tenant_id, user_id, email, display_name, role)
           values ($1, $2, $3, $4, $5)`,
          [
            southgate.id,
            '00000000-0000-4000-8000-00000000b999',
            'intruder@northwind.example',
            'Intruder',
            'owner',
          ],
        ),
      ),
    ).rejects.toThrow(/row-level security/iu);
  });

  it('refuses an audit entry stamped with another company', async () => {
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(
          `insert into audit_log (tenant_id, actor_kind, actor_id, actor_label, action, resource_type)
           values ($1, 'system', null, 'system', 'forged.entry', 'tenant')`,
          [southgate.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/iu);
  });

  it('updates nothing in another company from an unfiltered update', async () => {
    const updated = await asTenant(
      app,
      northwind.id,
      async () => (await app.query(`update tenant_users set display_name = 'Rewritten'`)).rowCount,
    );

    expect(updated).toBe(1);

    const southgateName = await asTenant(
      app,
      southgate.id,
      async () =>
        (await app.query<{ display_name: string }>('select display_name from tenant_users')).rows[0]
          ?.display_name,
    );

    expect(southgateName).toBe('Marek Novak');
  });

  it('refuses an update that would move a row into another company', async () => {
    await expect(
      asTenant(app, northwind.id, () =>
        app.query('update tenant_users set tenant_id = $1', [southgate.id]),
      ),
    ).rejects.toThrow(/row-level security/iu);
  });

  it('deletes nothing in another company from an unfiltered delete', async () => {
    const deleted = await asTenant(
      app,
      northwind.id,
      async () => (await app.query('delete from tenant_users')).rowCount,
    );

    expect(deleted).toBe(1);

    const southgateStillThere = await asTenant(
      app,
      southgate.id,
      async () => (await app.query('select 1 from tenant_users')).rowCount,
    );

    expect(southgateStillThere).toBe(1);
  });
});

describe('tables the runtime role must not reach at all', () => {
  it('cannot read platform_users', async () => {
    await expect(
      asTenant(app, northwind.id, () => app.query('select * from platform_users')),
    ).rejects.toThrow(/permission denied/iu);
  });

  it('cannot write to tenants', async () => {
    await expect(
      asTenant(app, northwind.id, () =>
        app.query('update tenants set name = $1', ['Renamed By The App']),
      ),
    ).rejects.toThrow(/permission denied/iu);
  });

  it('cannot create a company', async () => {
    await expect(
      asTenant(app, northwind.id, () =>
        app.query('insert into tenants (slug, name) values ($1, $2)', ['forged', 'Forged Ltd']),
      ),
    ).rejects.toThrow(/permission denied/iu);
  });

  it('cannot read the migration history', async () => {
    await expect(
      asTenant(app, northwind.id, () => app.query('select * from schema_migrations')),
    ).rejects.toThrow(/permission denied/iu);
  });
});

describe('the tenant context itself', () => {
  it('does not survive its transaction, which is what transaction pooling requires', async () => {
    await asTenant(app, northwind.id, async () => {
      const rowCount = (await app.query('select * from tenant_users')).rowCount;
      expect(rowCount).toBe(1);
    });

    // A new transaction on the same physical connection, with no context set.
    // A session-level GUC would still be in force here, and the next tenant to
    // be handed this connection by Supavisor would read Northwind's rows.
    await app.query('begin');
    const leaked = (await app.query('select * from tenant_users')).rowCount;
    await app.query('commit');

    expect(leaked).toBe(0);
  });

  it('rejects a context that is not a uuid rather than ignoring it', async () => {
    await expect(
      asTenant(app, 'northwind', () => app.query('select * from tenant_users')),
    ).rejects.toThrow(/invalid input syntax for type uuid/iu);
  });
});
