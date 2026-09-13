import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asTenant,
  connectAsApp,
  connectAsOwner,
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
  withUnprotectedRepositories,
} from './harness.js';

/**
 * The audit trail is append-only, and this suite is what that sentence means.
 *
 * P03 will require that an impersonation entry "cannot be deleted through the
 * application". The guarantee here is stronger than that and cheaper to
 * believe: it cannot be deleted through the database either, by the runtime
 * role or by the schema owner, because a statement-level trigger rejects the
 * operation rather than a grant merely withholding it.
 *
 * Statement-level matters. A row-level trigger fires once per affected row, so
 * `delete from audit_log where false` would succeed silently and a reader would
 * conclude deletion works. Here it raises.
 */

let owner: pg.Client;
let app: pg.Client;
let tenant: TenantFixture;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();

  tenant = await createTenant('audit');
  await withUnprotectedRepositories(tenant.id, (tx) =>
    tx.auditLog.append({
      actorKind: 'system',
      actorLabel: 'system',
      action: 'tenant.created',
      resourceType: 'tenant',
      resourceId: tenant.id,
    }),
  );

  owner = await connectAsOwner();
  app = await connectAsApp();
});

afterAll(async () => {
  await app.end();
  await owner.end();
  await releaseTestDatabase();
});

describe('the schema owner', () => {
  it('cannot update an entry', async () => {
    await expect(owner.query(`update audit_log set action = 'nothing.happened'`)).rejects.toThrow(
      /append-only/u,
    );
  });

  it('cannot delete an entry', async () => {
    await expect(owner.query('delete from audit_log')).rejects.toThrow(/append-only/u);
  });

  it('cannot delete an entry by id', async () => {
    await expect(
      owner.query('delete from audit_log where tenant_id = $1', [tenant.id]),
    ).rejects.toThrow(/append-only/u);
  });

  it('cannot quietly succeed at deleting nothing', async () => {
    await expect(owner.query('delete from audit_log where false')).rejects.toThrow(/append-only/u);
  });

  it('cannot truncate the table', async () => {
    // `cascade`, because `impersonation_grants.audit_log_id` references this
    // table. Without it Postgres refuses on the foreign key before the trigger
    // is ever consulted — the truncate still fails, but for a reason that says
    // nothing about the append-only guarantee, and the trigger could be dropped
    // without this test noticing. With it, the trigger is the only thing left
    // standing in the way.
    await expect(owner.query('truncate table audit_log cascade')).rejects.toThrow(/append-only/u);
  });

  it('still has the entry after all of that', async () => {
    const result = await owner.query('select * from audit_log where tenant_id = $1', [tenant.id]);
    expect(result.rowCount).toBe(1);
  });
});

describe('the runtime role', () => {
  it('cannot update an entry', async () => {
    await expect(
      asTenant(app, tenant.id, () => app.query(`update audit_log set action = 'edited'`)),
    ).rejects.toThrow(/permission denied|append-only/iu);
  });

  it('cannot delete an entry', async () => {
    await expect(
      asTenant(app, tenant.id, () => app.query('delete from audit_log')),
    ).rejects.toThrow(/permission denied|append-only/iu);
  });

  it('can still append', async () => {
    const appended = await asTenant(
      app,
      tenant.id,
      async () =>
        (
          await app.query(
            `insert into audit_log (tenant_id, actor_kind, actor_id, actor_label, action, resource_type)
           values ($1, 'system', null, 'system', 'thing.happened', 'tenant')`,
            [tenant.id],
          )
        ).rowCount,
    );

    expect(appended).toBe(1);
  });
});

describe('what the trail records', () => {
  it('keeps the actor label verbatim, so history survives a rename', async () => {
    const entry = await withUnprotectedRepositories(tenant.id, (tx) =>
      tx.auditLog.append({
        actorKind: 'platform_user',
        actorId: '00000000-0000-4000-8000-00000000f001',
        actorLabel: 'super.admin@integr8.example',
        action: 'tenant.impersonated',
        resourceType: 'tenant',
        resourceId: tenant.id,
        metadata: { reason: 'Customer reported a missing job' },
      }),
    );

    expect(entry.actorLabel).toBe('super.admin@integr8.example');
    expect(entry.metadata).toEqual({ reason: 'Customer reported a missing job' });
  });

  it('refuses an entry with an actor kind that needs an id but has none', async () => {
    await expect(
      owner.query(
        `insert into audit_log (tenant_id, actor_kind, actor_id, actor_label, action, resource_type)
         values ($1, 'tenant_user', null, 'someone', 'thing.happened', 'tenant')`,
        [tenant.id],
      ),
    ).rejects.toThrow(/audit_log_actor_id_present/u);
  });

  it('refuses a system entry that claims an actor id', async () => {
    await expect(
      owner.query(
        `insert into audit_log (tenant_id, actor_kind, actor_id, actor_label, action, resource_type)
         values ($1, 'system', gen_random_uuid(), 'system', 'thing.happened', 'tenant')`,
        [tenant.id],
      ),
    ).rejects.toThrow(/audit_log_actor_id_present/u);
  });

  it('blocks deleting a company that has audit history', async () => {
    await expect(owner.query('delete from tenants where id = $1', [tenant.id])).rejects.toThrow(
      /violates foreign key constraint/u,
    );
  });
});
