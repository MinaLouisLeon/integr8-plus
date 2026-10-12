import { toTenantId } from '@integr8/core';
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
 * Migration 0036 (seventh round; ADR-0010): the two new roles, grants on top
 * of a role, and employee profiles whose ID and bank numbers arrive sealed.
 */

const OWNER = '00000000-0000-4000-8000-00000000c901';
const STOREKEEPER = '00000000-0000-4000-8000-00000000c902';
const PAYROLLER = '00000000-0000-4000-8000-00000000c903';

let owner: pg.Client;
let northwind: TenantFixture;
let southgate: TenantFixture;

const repos = <T>(
  tenant: TenantFixture,
  fn: Parameters<typeof withUnprotectedRepositories<T>>[1],
) => withUnprotectedRepositories(toTenantId(tenant.id), fn);

const SEALED = { sealed: 'hr1.bm9uY2U.Y2lwaGVydGV4dA', last4: '1234' };

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  northwind = await createTenant('hr-northwind');
  southgate = await createTenant('hr-southgate');
  await repos(northwind, async (tx) => {
    await tx.tenantUsers.create({
      userId: STOREKEEPER,
      email: 'store@hr-northwind.example',
      displayName: 'Samir Store',
      role: 'dispatcher',
    });
    await tx.tenantUsers.create({
      userId: PAYROLLER,
      email: 'pay@hr-northwind.example',
      displayName: 'Hala Pay',
      role: 'hr_manager',
    });
  });
});

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

describe('roles and grants', () => {
  it('takes the new roles, and grants on top of a role, once each', async () => {
    const member = await repos(northwind, (tx) => tx.tenantUsers.findByUserId(PAYROLLER));
    expect(member?.role).toBe('hr_manager');
    expect(
      await repos(northwind, (tx) => tx.memberGrants.give(STOREKEEPER, 'inventory_manager', OWNER)),
    ).toBe(true);
    expect(
      await repos(northwind, (tx) => tx.memberGrants.give(STOREKEEPER, 'inventory_manager', OWNER)),
    ).toBe(false);
    await repos(northwind, (tx) => tx.memberGrants.give(STOREKEEPER, 'hr_manager', OWNER));
    // Always in the order GRANTS lists them.
    expect(await repos(northwind, (tx) => tx.memberGrants.forUser(STOREKEEPER))).toEqual([
      'hr_manager',
      'inventory_manager',
    ]);
    expect(await repos(northwind, (tx) => tx.memberGrants.remove(STOREKEEPER, 'hr_manager'))).toBe(
      true,
    );
    expect(await repos(northwind, (tx) => tx.memberGrants.forUser(STOREKEEPER))).toEqual([
      'inventory_manager',
    ]);
    // Another company sees none of it.
    expect(await repos(southgate, (tx) => tx.memberGrants.forUser(STOREKEEPER))).toEqual([]);
  });

  it('refuses a grant that is not a capability, or for someone who is not a member', async () => {
    await expect(
      owner.query(
        `insert into member_grants (tenant_id, user_id, capability, granted_by) values ($1, $2, 'owner', $3)`,
        [northwind.id, STOREKEEPER, OWNER],
      ),
    ).rejects.toMatchObject({ constraint: 'member_grants_capability_known' });
    await expect(
      owner.query(
        `insert into member_grants (tenant_id, user_id, capability, granted_by) values ($1, $2, 'hr_manager', $3)`,
        [southgate.id, STOREKEEPER, OWNER],
      ),
    ).rejects.toMatchObject({ constraint: 'member_grants_member_fk' });
  });
});

describe('employee profiles', () => {
  it('links one profile to a member, or stands alone, with numbers unique ignoring case', async () => {
    const linked = await repos(northwind, (tx) =>
      tx.hrEmployees.create(
        {
          userId: PAYROLLER,
          employeeNumber: 'E-001',
          fullName: 'Hala Pay',
          hireDate: '2025-03-01',
          nationalId: SEALED,
        },
        OWNER,
      ),
    );
    if (typeof linked === 'string') {
      throw new Error(linked);
    }
    expect(linked).toMatchObject({ userId: PAYROLLER, nationalId: SEALED, version: 1 });
    expect(
      await repos(northwind, (tx) =>
        tx.hrEmployees.create(
          { userId: PAYROLLER, fullName: 'Again', hireDate: '2025-03-01' },
          OWNER,
        ),
      ),
    ).toBe('member_taken');
    expect(
      await repos(northwind, (tx) =>
        tx.hrEmployees.create(
          { employeeNumber: 'e-001', fullName: 'Copy', hireDate: '2025-03-01' },
          OWNER,
        ),
      ),
    ).toBe('number_taken');
    const helper = await repos(northwind, (tx) =>
      tx.hrEmployees.create({ fullName: 'Karim Helper', hireDate: '2026-01-10' }, OWNER),
    );
    if (typeof helper === 'string') {
      throw new Error(helper);
    }
    expect(helper.userId).toBeNull();

    const ended = await repos(northwind, (tx) =>
      tx.hrEmployees.update(helper.id, helper.version, {
        endDate: '2026-06-30',
        endReason: 'Contract ended',
      }),
    );
    expect(ended).toMatchObject({ endDate: '2026-06-30', version: 2 });
    expect(
      await repos(northwind, (tx) => tx.hrEmployees.update(helper.id, 1, { jobTitle: 'Driver' })),
    ).toBe('version_conflict');
    const active = await repos(northwind, (tx) =>
      tx.hrEmployees.list({ status: 'active', limit: 50 }),
    );
    expect(active.items.map((employee) => employee.fullName)).toEqual(['Hala Pay']);
    expect(
      (await repos(northwind, (tx) => tx.hrEmployees.list({ q: 'karim', limit: 50 }))).items,
    ).toHaveLength(1);
    expect(await repos(southgate, (tx) => tx.hrEmployees.find(helper.id))).toBeUndefined();
  });

  it('keeps only ciphertext and its last four, and ends with a reason', async () => {
    const app = await connectAsApp();
    try {
      await expect(
        asTenant(app, northwind.id, () =>
          app.query(
            `insert into hr_employees (tenant_id, full_name, hire_date, national_id_sealed, national_id_last4, created_by)
             values ($1, 'Plain', '2026-01-01', '29001011234567', '4567', $2)`,
            [northwind.id, OWNER],
          ),
        ),
      ).rejects.toMatchObject({ constraint: 'hr_employees_sealed_shape' });
    } finally {
      await app.end();
    }
    await expect(
      owner.query(
        `insert into hr_employees (tenant_id, full_name, hire_date, end_date, created_by)
         values ($1, 'No reason', '2026-01-01', '2026-02-01', $2)`,
        [northwind.id, OWNER],
      ),
    ).rejects.toMatchObject({ constraint: 'hr_employees_end_pairing' });
    await expect(
      owner.query(
        `insert into hr_employees (tenant_id, full_name, hire_date, end_date, end_reason, created_by)
         values ($1, 'Backwards', '2026-02-01', '2026-01-01', 'x', $2)`,
        [northwind.id, OWNER],
      ),
    ).rejects.toMatchObject({ constraint: 'hr_employees_end_after_hire' });
  });

  it('cannot be deleted by the application', async () => {
    const app = await connectAsApp();
    try {
      await expect(
        asTenant(app, northwind.id, () => app.query(`delete from hr_employees`)),
      ).rejects.toThrow(/permission denied/u);
    } finally {
      await app.end();
    }
  });
});
