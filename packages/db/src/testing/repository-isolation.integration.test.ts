import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
  withUnprotectedRepositories,
} from './harness.js';

/**
 * Axis one of the isolation proof: the repository layer, on its own.
 *
 * Every query here runs on the **owner** connection, where RLS does not apply
 * and the tenant guard is not attached. The only thing standing between
 * Northwind and Southgate is the `where tenant_id = ?` that each repository
 * method puts in its SQL.
 *
 * That is deliberate, and it is what makes the P02 exit criterion testable:
 * delete the predicate from `TenantUsersRepository#scoped` and these tests fail
 * with another company's rows in hand, rather than passing because RLS silently
 * covered for the bug.
 *
 * The two companies below are built to be confusable — the same person, by the
 * same auth identity and the same email address, is a member of both, with a
 * different role in each. A leak therefore looks like plausible data, which is
 * exactly how a real one goes unnoticed.
 */

const SHARED_USER = '00000000-0000-4000-8000-00000000c001';
const SHARED_EMAIL = 'sam.carter@contractor.example';

const NORTHWIND_ONLY_USER = '00000000-0000-4000-8000-00000000a101';
const SOUTHGATE_ONLY_USER = '00000000-0000-4000-8000-00000000b201';

let northwind: TenantFixture;
let southgate: TenantFixture;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();

  northwind = await createTenant('northwind');
  southgate = await createTenant('southgate');

  await withUnprotectedRepositories(northwind.id, async (tx) => {
    await tx.tenantUsers.create({
      userId: NORTHWIND_ONLY_USER,
      email: 'dana.okafor@northwind.example',
      displayName: 'Dana Okafor',
      role: 'owner',
    });
    await tx.tenantUsers.create({
      userId: SHARED_USER,
      email: SHARED_EMAIL,
      displayName: 'Sam Carter',
      role: 'engineer',
    });
    await tx.auditLog.append({
      actorKind: 'tenant_user',
      actorId: NORTHWIND_ONLY_USER,
      actorLabel: 'dana.okafor@northwind.example',
      action: 'tenant_user.invited',
      resourceType: 'tenant_user',
      resourceId: SHARED_USER,
    });
  });

  await withUnprotectedRepositories(southgate.id, async (tx) => {
    await tx.tenantUsers.create({
      userId: SOUTHGATE_ONLY_USER,
      email: 'marek.novak@southgate.example',
      displayName: 'Marek Novak',
      role: 'owner',
    });
    await tx.tenantUsers.create({
      userId: SHARED_USER,
      email: SHARED_EMAIL,
      displayName: 'Sam Carter',
      role: 'admin',
    });
    await tx.auditLog.append({
      actorKind: 'tenant_user',
      actorId: SOUTHGATE_ONLY_USER,
      actorLabel: 'marek.novak@southgate.example',
      action: 'tenant_user.invited',
      resourceType: 'tenant_user',
      resourceId: SHARED_USER,
    });
  });
});

afterAll(async () => {
  await releaseTestDatabase();
});

describe('tenant_users reads', () => {
  it('lists only its own company', async () => {
    const rows = await withUnprotectedRepositories(northwind.id, (tx) => tx.tenantUsers.list());

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.tenantId === northwind.id)).toBe(true);
    expect(rows.map((row) => row.email).sort()).toEqual([
      'dana.okafor@northwind.example',
      SHARED_EMAIL,
    ]);
  });

  it('resolves the shared identity to the membership of the asking company', async () => {
    const inNorthwind = await withUnprotectedRepositories(northwind.id, (tx) =>
      tx.tenantUsers.findByUserId(SHARED_USER),
    );
    const inSouthgate = await withUnprotectedRepositories(southgate.id, (tx) =>
      tx.tenantUsers.findByUserId(SHARED_USER),
    );

    expect(inNorthwind?.role).toBe('engineer');
    expect(inNorthwind?.tenantId).toBe(northwind.id);
    expect(inSouthgate?.role).toBe('admin');
    expect(inSouthgate?.tenantId).toBe(southgate.id);
  });

  it('does not find another company member by id', async () => {
    const found = await withUnprotectedRepositories(northwind.id, (tx) =>
      tx.tenantUsers.findByUserId(SOUTHGATE_ONLY_USER),
    );

    expect(found).toBeUndefined();
  });

  it('does not find another company member by email', async () => {
    const found = await withUnprotectedRepositories(northwind.id, (tx) =>
      tx.tenantUsers.findByEmail('marek.novak@southgate.example'),
    );

    expect(found).toBeUndefined();
  });

  it('resolves the shared email to the asking company, not the first match', async () => {
    const found = await withUnprotectedRepositories(southgate.id, (tx) =>
      tx.tenantUsers.findByEmail(SHARED_EMAIL),
    );

    expect(found?.tenantId).toBe(southgate.id);
    expect(found?.role).toBe('admin');
  });

  it('counts only its own members', async () => {
    await expect(
      withUnprotectedRepositories(northwind.id, (tx) => tx.tenantUsers.countActive()),
    ).resolves.toBe(2);
  });
});

describe('tenant_users writes', () => {
  it('stamps new rows with the asking company, not one supplied by the caller', async () => {
    const created = await withUnprotectedRepositories(northwind.id, (tx) =>
      tx.tenantUsers.create({
        userId: '00000000-0000-4000-8000-00000000a199',
        email: 'new.starter@northwind.example',
        displayName: 'New Starter',
        role: 'viewer',
        status: 'invited',
      }),
    );

    expect(created.tenantId).toBe(northwind.id);

    // And it is invisible from the other company.
    await expect(
      withUnprotectedRepositories(southgate.id, (tx) =>
        tx.tenantUsers.findByUserId('00000000-0000-4000-8000-00000000a199'),
      ),
    ).resolves.toBeUndefined();
  });

  it('cannot change a role in another company', async () => {
    const attempt = await withUnprotectedRepositories(northwind.id, (tx) =>
      tx.tenantUsers.updateRole(SOUTHGATE_ONLY_USER, 'viewer'),
    );
    expect(attempt).toBeUndefined();

    const untouched = await withUnprotectedRepositories(southgate.id, (tx) =>
      tx.tenantUsers.findByUserId(SOUTHGATE_ONLY_USER),
    );
    expect(untouched?.role).toBe('owner');
  });

  it('changes only its own copy of a shared identity', async () => {
    await withUnprotectedRepositories(northwind.id, (tx) =>
      tx.tenantUsers.updateRole(SHARED_USER, 'dispatcher'),
    );

    const inNorthwind = await withUnprotectedRepositories(northwind.id, (tx) =>
      tx.tenantUsers.findByUserId(SHARED_USER),
    );
    const inSouthgate = await withUnprotectedRepositories(southgate.id, (tx) =>
      tx.tenantUsers.findByUserId(SHARED_USER),
    );

    expect(inNorthwind?.role).toBe('dispatcher');
    expect(inSouthgate?.role).toBe('admin');
  });

  it('cannot change a status in another company', async () => {
    await expect(
      withUnprotectedRepositories(northwind.id, (tx) =>
        tx.tenantUsers.updateStatus(SOUTHGATE_ONLY_USER, 'suspended'),
      ),
    ).resolves.toBeUndefined();
  });

  it('cannot delete a membership in another company', async () => {
    await expect(
      withUnprotectedRepositories(northwind.id, (tx) =>
        tx.tenantUsers.softDelete(SOUTHGATE_ONLY_USER),
      ),
    ).resolves.toBe(false);

    await expect(
      withUnprotectedRepositories(southgate.id, (tx) => tx.tenantUsers.countActive()),
    ).resolves.toBe(2);
  });
});

describe('audit_log', () => {
  it('lists only its own company', async () => {
    const entries = await withUnprotectedRepositories(northwind.id, (tx) => tx.auditLog.list());

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.tenantId === northwind.id)).toBe(true);
  });

  it('does not see another company through a resource filter', async () => {
    // The same resource id exists in both companies; only one row may come back.
    const entries = await withUnprotectedRepositories(northwind.id, (tx) =>
      tx.auditLog.list({ resourceType: 'tenant_user', resourceId: SHARED_USER }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.tenantId).toBe(northwind.id);
  });

  it('appends under the asking company', async () => {
    const before = await withUnprotectedRepositories(southgate.id, (tx) => tx.auditLog.count());

    const entry = await withUnprotectedRepositories(northwind.id, (tx) =>
      tx.auditLog.append({
        actorKind: 'system',
        actorLabel: 'system',
        action: 'tenant.checked',
        resourceType: 'tenant',
        resourceId: northwind.id,
      }),
    );

    expect(entry.tenantId).toBe(northwind.id);

    await expect(
      withUnprotectedRepositories(southgate.id, (tx) => tx.auditLog.count()),
    ).resolves.toBe(before);
  });

  it('counts only its own entries', async () => {
    const northwindCount = await withUnprotectedRepositories(northwind.id, (tx) =>
      tx.auditLog.count(),
    );
    const southgateCount = await withUnprotectedRepositories(southgate.id, (tx) =>
      tx.auditLog.count(),
    );

    expect(northwindCount).toBeGreaterThan(southgateCount);
    expect(southgateCount).toBe(1);
  });
});

describe('every read method, exhaustively', () => {
  /**
   * A named list rather than a loop over the class, so that adding a read
   * method without adding it here is visible in review. If a method returns
   * rows, every row it returns must belong to the asking company — there is no
   * method for which that is not the rule.
   */
  const reads: {
    name: string;
    run: (tenantId: TenantFixture['id']) => Promise<{ tenantId: string }[]>;
  }[] = [
    {
      name: 'tenantUsers.list',
      run: (tenantId) => withUnprotectedRepositories(tenantId, (tx) => tx.tenantUsers.list()),
    },
    {
      name: 'tenantUsers.list (including deleted)',
      run: (tenantId) =>
        withUnprotectedRepositories(tenantId, (tx) =>
          tx.tenantUsers.list({ includeDeleted: true }),
        ),
    },
    {
      name: 'tenantUsers.findByUserId (shared identity)',
      run: async (tenantId) => {
        const row = await withUnprotectedRepositories(tenantId, (tx) =>
          tx.tenantUsers.findByUserId(SHARED_USER),
        );
        return row === undefined ? [] : [row];
      },
    },
    {
      name: 'tenantUsers.findByEmail (shared email)',
      run: async (tenantId) => {
        const row = await withUnprotectedRepositories(tenantId, (tx) =>
          tx.tenantUsers.findByEmail(SHARED_EMAIL),
        );
        return row === undefined ? [] : [row];
      },
    },
    {
      name: 'auditLog.list',
      run: (tenantId) => withUnprotectedRepositories(tenantId, (tx) => tx.auditLog.list()),
    },
    {
      name: 'auditLog.list (unbounded limit)',
      run: (tenantId) =>
        withUnprotectedRepositories(tenantId, (tx) => tx.auditLog.list({ limit: 10_000 })),
    },
  ];

  for (const read of reads) {
    it(`${read.name} returns nothing belonging to another company`, async () => {
      for (const tenant of [northwind, southgate]) {
        const rows = await read.run(tenant.id);
        expect(rows.every((row) => row.tenantId === tenant.id)).toBe(true);
      }
    });
  }
});
