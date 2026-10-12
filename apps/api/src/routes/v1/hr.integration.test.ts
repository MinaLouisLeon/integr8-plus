import { randomBytes, randomUUID } from 'node:crypto';
import { withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Roles, grants and employee profiles over HTTP (seventh round; ADR-0010):
 * the HR manager role and grant are the owner's to give, the inventory ones
 * the owner's or an admin's; a grant reaches the next token and `/v1/me`; job
 * details are read by owners, admins and HR managers, ID and bank numbers only
 * by owners, HR managers and the person themselves, sealed at rest and shown
 * in full only through an audited reveal.
 */

let api: ApiHarness;
let staff: PlatformAdmin;
let owner: Member;
let admin: Member;
let dispatcher: Member;
let engineer: Member;

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

/** A fresh sign-in each time: a grant reaches a new token, not one already issued. */
async function call(
  who: Member,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) {
  return api.call(await api.signIn(who), {
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
}

interface Me {
  role: string;
  grants: string[];
  permissions: string[];
}
interface Employee {
  id: string;
  fullName: string;
  employeeNumber: string | null;
  status: string;
  member: { userId: string } | null;
  sensitive: {
    nationalId: { last4: string } | null;
    bankAccount: { last4: string } | null;
  } | null;
  version: number;
  can: { edit: boolean; reveal: boolean };
}

beforeAll(async () => {
  api = await startApi({ env: { HR_DATA_KEY: randomBytes(32).toString('base64') } });
  staff = await api.platformAdmin('hr-staff');
  owner = await api.member('owner', 'hr-owner');
  admin = await api.member('admin', 'hr-admin');
  dispatcher = await api.member('dispatcher', 'hr-dispatcher');
  engineer = await api.member('engineer', 'hr-engineer');
  for (const key of ['hr', 'inventory', 'manufacturing']) {
    const flag = await api.call(staff.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${api.tenantId}/flags/${key}`,
      payload: { enabled: true },
    });
    expect(flag.statusCode, flag.body).toBe(200);
  }
});

afterAll(async () => {
  await api.close();
});

describe('roles and grants', () => {
  it('lets only the owner make an HR manager, by role, invitation or grant', async () => {
    const invited = await call(admin, 'POST', '/v1/members/invitations', {
      email: `pay.${randomUUID().slice(0, 6)}@test.integr8.example`,
      role: 'hr_manager',
    });
    expect(invited.statusCode).toBe(403);
    expect(
      (await call(admin, 'PATCH', `/v1/members/${dispatcher.userId}/role`, { role: 'hr_manager' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call(admin, 'PUT', `/v1/members/${dispatcher.userId}/grants/hr_manager`)).statusCode,
    ).toBe(403);
    const given = await call(owner, 'PUT', `/v1/members/${admin.userId}/grants/hr_manager`);
    expect(given.statusCode, given.body).toBe(200);
    expect(json<{ grants: string[] }>(given).grants).toEqual(['hr_manager']);
    // The owner's role already holds all of it.
    expect(code(await call(owner, 'PUT', `/v1/members/${owner.userId}/grants/hr_manager`))).toBe(
      'role_holds_grant',
    );
  });

  it('lets an admin give the inventory grant, which reaches the next token and /v1/me', async () => {
    const before = json<Me>(await call(dispatcher, 'GET', '/v1/me'));
    expect(before.permissions).not.toContain('manufacturing.manage');
    const given = await call(
      admin,
      'PUT',
      `/v1/members/${dispatcher.userId}/grants/inventory_manager`,
    );
    expect(given.statusCode, given.body).toBe(200);
    const after = json<Me>(await call(dispatcher, 'GET', '/v1/me'));
    expect(after).toMatchObject({ role: 'dispatcher', grants: ['inventory_manager'] });
    expect(after.permissions).toEqual(
      expect.arrayContaining(['manufacturing.read', 'manufacturing.manage']),
    );
    const members = json<{ items: { userId: string; grants: string[] }[] }>(
      await call(admin, 'GET', '/v1/members'),
    ).items;
    expect(members.find((member) => member.userId === dispatcher.userId)?.grants).toEqual([
      'inventory_manager',
    ]);
    const removed = await call(
      admin,
      'DELETE',
      `/v1/members/${dispatcher.userId}/grants/inventory_manager`,
    );
    expect(json<{ grants: string[] }>(removed).grants).toEqual([]);
    expect(json<Me>(await call(dispatcher, 'GET', '/v1/me')).permissions).not.toContain(
      'manufacturing.manage',
    );
  });

  it('takes the new roles, which hold their area and nothing else', async () => {
    const storekeeper = await api.member('inventory_manager', 'hr-storekeeper');
    const me = json<Me>(await call(storekeeper, 'GET', '/v1/me'));
    expect(me.permissions).toEqual(
      expect.arrayContaining(['inventory.manage', 'manufacturing.manage']),
    );
    expect(me.permissions).not.toContain('work_order.manage');
    expect((await call(storekeeper, 'GET', '/v1/hr/employees')).statusCode).toBe(403);
    const changed = await call(owner, 'PATCH', `/v1/members/${storekeeper.userId}/role`, {
      role: 'hr_manager',
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((await call(storekeeper, 'GET', '/v1/hr/employees')).statusCode).toBe(200);
  });
});

describe('employee profiles', () => {
  let linked: Employee;

  it('are kept by owners and HR managers, with numbers sealed and shown as their last four', async () => {
    // The admin holds the HR grant from the first test.
    const created = await call(admin, 'POST', '/v1/hr/employees', {
      userId: engineer.userId,
      employeeNumber: 'E-100',
      jobTitle: 'Field engineer',
      department: 'Service',
      hireDate: '2025-02-01',
      nationalId: '29001011234567',
      bankName: 'National Bank',
      bankAccount: 'EG38 0019 0005 0000 0000 2631 8000 2',
    });
    expect(created.statusCode, created.body).toBe(201);
    linked = json<Employee>(created);
    expect(linked).toMatchObject({
      fullName: 'hr-engineer',
      status: 'active',
      member: { userId: engineer.userId },
      sensitive: { nationalId: { last4: '4567' }, bankAccount: { last4: '0002' } },
    });
    // Nothing readable reaches the database.
    const stored = await withTenant(api.tenantId, (tx) => tx.hrEmployees.find(linked.id));
    expect(stored?.nationalId?.sealed).toMatch(/^hr1\./u);
    expect(JSON.stringify(stored)).not.toContain('29001011234567');

    expect(
      code(
        await call(owner, 'POST', '/v1/hr/employees', {
          userId: engineer.userId,
          hireDate: '2025-02-01',
        }),
      ),
    ).toBe('member_taken');
    expect(
      code(
        await call(owner, 'POST', '/v1/hr/employees', {
          fullName: 'Copy',
          employeeNumber: 'e-100',
          hireDate: '2025-02-01',
        }),
      ),
    ).toBe('number_taken');
    expect(code(await call(owner, 'POST', '/v1/hr/employees', { hireDate: '2025-02-01' }))).toBe(
      'name_required',
    );
  });

  it('show job details to admins without the grant, and ID numbers to nobody else', async () => {
    const helper = await call(owner, 'POST', '/v1/hr/employees', {
      fullName: 'Karim Helper',
      hireDate: '2026-01-10',
      nationalId: '30001011234567',
    });
    expect(helper.statusCode, helper.body).toBe(201);
    const helperId = json<Employee>(helper).id;
    // A second admin, without the HR grant.
    const plainAdmin = await api.member('admin', 'hr-admin-2');
    const listed = json<{ items: Employee[] }>(await call(plainAdmin, 'GET', '/v1/hr/employees'));
    expect(listed.items.find((employee) => employee.id === helperId)).toMatchObject({
      fullName: 'Karim Helper',
      sensitive: null,
      can: { edit: false, reveal: false },
    });
    expect(
      (
        await call(plainAdmin, 'POST', `/v1/hr/employees/${helperId}/reveal`, {
          field: 'nationalId',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(plainAdmin, 'PATCH', `/v1/hr/employees/${helperId}`, {
          expectedVersion: 1,
          nationalId: '30001011234560',
        })
      ).statusCode,
    ).toBe(403);
    // Engineers and dispatchers read no one else's profile.
    expect((await call(engineer, 'GET', `/v1/hr/employees/${helperId}`)).statusCode).toBe(404);
    expect((await call(dispatcher, 'GET', '/v1/hr/employees')).statusCode).toBe(403);
  });

  it('are read by the person themselves, who may reveal their own numbers, and every reveal is audited', async () => {
    const mine = await call(engineer, 'GET', '/v1/hr/me');
    expect(mine.statusCode, mine.body).toBe(200);
    expect(json<Employee>(mine)).toMatchObject({
      id: linked.id,
      sensitive: { nationalId: { last4: '4567' } },
      can: { edit: false, reveal: true },
    });
    const revealed = await call(engineer, 'POST', `/v1/hr/employees/${linked.id}/reveal`, {
      field: 'nationalId',
    });
    expect(json<{ value: string }>(revealed).value).toBe('29001011234567');
    const bank = await call(owner, 'POST', `/v1/hr/employees/${linked.id}/reveal`, {
      field: 'bankAccount',
    });
    expect(json<{ value: string }>(bank).value).toBe('EG38 0019 0005 0000 0000 2631 8000 2');
    const audit = await withTenant(api.tenantId, (tx) =>
      tx.auditLog.list({ resourceType: 'hr_employee', resourceId: linked.id }),
    );
    expect(audit.filter((entry) => entry.action === 'hr.field_revealed')).toHaveLength(2);
    expect((await call(dispatcher, 'GET', '/v1/hr/me')).statusCode).toBe(404);
  });

  it('end with a reason, on or after the hire date, and refuse a stale version', async () => {
    const early = await call(owner, 'PATCH', `/v1/hr/employees/${linked.id}`, {
      expectedVersion: linked.version,
      endDate: '2025-01-01',
      endReason: 'Resigned',
    });
    expect(code(early)).toBe('end_before_hire');
    const ended = await call(owner, 'PATCH', `/v1/hr/employees/${linked.id}`, {
      expectedVersion: linked.version,
      endDate: '2026-09-30',
      endReason: 'Resigned',
    });
    expect(ended.statusCode, ended.body).toBe(200);
    expect(json<Employee>(ended).status).toBe('ended');
    expect(
      code(
        await call(owner, 'PATCH', `/v1/hr/employees/${linked.id}`, {
          expectedVersion: linked.version,
          jobTitle: 'Senior engineer',
        }),
      ),
    ).toBe('version_conflict');
    const active = json<{ items: Employee[] }>(await call(owner, 'GET', '/v1/hr/employees'));
    expect(active.items.map((employee) => employee.id)).not.toContain(linked.id);
  });
});
