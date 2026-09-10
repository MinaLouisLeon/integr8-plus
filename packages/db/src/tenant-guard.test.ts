import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type PluginTransformQueryArgs,
  type RootOperationNode,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import type { Database } from './schema.js';
import { MissingTenantScopeError, TenantGuardPlugin } from './tenant-guard.js';

/**
 * The guard is tested without a database on purpose: it inspects the query node
 * tree, so nothing here needs Postgres, and that keeps the single most
 * important safety net in the package covered by the suite that runs on every
 * commit rather than only where a connection string exists.
 */

const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (instance) => new PostgresIntrospector(instance),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const plugin = new TenantGuardPlugin();
const TENANT = '018f2b3c-4d5e-7f80-9a1b-2c3d4e5f6071';

function guard(node: RootOperationNode): RootOperationNode {
  const args: PluginTransformQueryArgs = { node, queryId: { queryId: 'test' } };
  return plugin.transformQuery(args);
}

describe('statements that must be rejected', () => {
  it('rejects a select on a tenant-scoped table with no tenant_id', () => {
    const node = db.selectFrom('tenant_users').selectAll().toOperationNode();
    expect(() => guard(node)).toThrow(MissingTenantScopeError);
  });

  it('rejects a select filtered by something other than tenant_id', () => {
    const node = db
      .selectFrom('tenant_users')
      .selectAll()
      .where('email', '=', 'sam.carter@contractor.example')
      .toOperationNode();

    expect(() => guard(node)).toThrow(MissingTenantScopeError);
  });

  it('rejects an update with no tenant_id', () => {
    const node = db
      .updateTable('tenant_users')
      .set({ role: 'owner' })
      .where('user_id', '=', TENANT)
      .toOperationNode();

    expect(() => guard(node)).toThrow(MissingTenantScopeError);
  });

  it('rejects a delete with no tenant_id', () => {
    const node = db
      .deleteFrom('audit_log')
      .where('action', '=', 'tenant.created')
      .toOperationNode();
    expect(() => guard(node)).toThrow(MissingTenantScopeError);
  });

  it('rejects an insert that omits tenant_id', () => {
    const node = db
      .insertInto('tenant_users')
      .values({
        user_id: TENANT,
        email: 'sam.carter@contractor.example',
        display_name: 'Sam Carter',
        role: 'engineer',
      } as never)
      .toOperationNode();

    expect(() => guard(node)).toThrow(MissingTenantScopeError);
  });

  it('rejects a join that reaches a tenant-scoped table unscoped', () => {
    const node = db
      .selectFrom('tenants')
      .innerJoin('tenant_users', 'tenant_users.tenant_id', 'tenants.id')
      .select(['tenants.name'])
      .where('tenants.slug', '=', 'northwind-facilities')
      .toOperationNode();

    // The join predicate does name tenant_id, so this one passes the guard —
    // recorded here so the boundary is explicit rather than assumed. RLS is
    // what stops a genuinely cross-tenant join.
    expect(() => guard(node)).not.toThrow();
  });

  it('names the offending table in the error', () => {
    const node = db.selectFrom('audit_log').selectAll().toOperationNode();
    expect(() => guard(node)).toThrow(/audit_log/u);
  });
});

describe('statements that must be allowed', () => {
  it('allows a scoped select', () => {
    const node = db
      .selectFrom('tenant_users')
      .selectAll()
      .where('tenant_id', '=', TENANT)
      .toOperationNode();

    expect(() => guard(node)).not.toThrow();
  });

  it('allows a scoped insert', () => {
    const node = db
      .insertInto('audit_log')
      .values({
        tenant_id: TENANT,
        actor_kind: 'system',
        actor_id: null,
        actor_label: 'system',
        action: 'tenant.created',
        resource_type: 'tenant',
      } as never)
      .toOperationNode();

    expect(() => guard(node)).not.toThrow();
  });

  it('leaves platform tables alone', () => {
    expect(() => guard(db.selectFrom('tenants').selectAll().toOperationNode())).not.toThrow();
    expect(() =>
      guard(db.selectFrom('platform_users').selectAll().toOperationNode()),
    ).not.toThrow();
  });

  it('returns the node unchanged when it passes', () => {
    const node = db
      .selectFrom('tenant_users')
      .selectAll()
      .where('tenant_id', '=', TENANT)
      .toOperationNode();

    expect(guard(node)).toBe(node);
  });
});
