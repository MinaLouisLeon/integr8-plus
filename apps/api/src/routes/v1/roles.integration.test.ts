import { randomUUID } from 'node:crypto';
import { withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type Member, startApi } from '../../testing/api-harness.js';

/**
 * The company's own roles over HTTP (ninth round; ADR-0013): defined by the
 * owner on a built-in base, given out by owners and admins, carried in the
 * next token, never holding the owner's own permissions.
 */

let api: ApiHarness;
let owner: Member;
let admin: Member;
let viewer: Member;
let other: Member;

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

async function call(
  who: Member,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
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

interface RoleBody {
  id: string;
  version: number;
  permissions: string[];
  holders: number;
}

beforeAll(async () => {
  api = await startApi();
  owner = await api.member('owner', 'roles-owner');
  admin = await api.member('admin', 'roles-admin');
  viewer = await api.member('viewer', 'roles-viewer');
  other = await api.member('viewer', 'roles-other');
});

afterAll(async () => {
  await api.close();
});

describe('company roles', () => {
  let auditor: RoleBody;

  it('are defined by the owner on a base, never with the owner’s own permissions', async () => {
    const body = {
      name: 'Auditor',
      baseRole: 'viewer',
      added: ['storage.read', 'audit.read'],
      removed: ['expense.submit'],
    };
    expect((await call(admin, 'POST', '/v1/roles', body)).statusCode).toBe(403);
    expect(
      code(await call(owner, 'POST', '/v1/roles', { ...body, added: ['billing.manage'] })),
    ).toBe('permission_not_addable');
    const created = await call(owner, 'POST', '/v1/roles', body);
    expect(created.statusCode, created.body).toBe(201);
    auditor = json<RoleBody>(created);
    expect(auditor.permissions).toContain('storage.read');
    expect(auditor.permissions).not.toContain('expense.submit');
    expect(code(await call(owner, 'POST', '/v1/roles', { ...body, name: 'auditor ' }))).toBe(
      'name_taken',
    );

    const catalogue = json<{ addable: string[] }>(await call(viewer, 'GET', '/v1/roles/catalogue'));
    expect(catalogue.addable).not.toContain('billing.manage');
    expect(catalogue.addable).not.toContain('form.manage');
  });

  it('are given out by an admin, and the next token carries them', async () => {
    expect((await call(viewer, 'GET', '/v1/storage/usage')).statusCode).toBe(403);
    const given = await call(admin, 'PATCH', `/v1/members/${viewer.userId}/role`, {
      customRoleId: auditor.id,
    });
    expect(given.statusCode, given.body).toBe(200);
    expect(json<{ role: string; customRole: { name: string } }>(given)).toMatchObject({
      role: 'viewer',
      customRole: { name: 'Auditor' },
    });

    const me = json<{ customRole: { id: string } | null; permissions: string[] }>(
      await call(viewer, 'GET', '/v1/me'),
    );
    expect(me.customRole?.id).toBe(auditor.id);
    expect(me.permissions).toContain('storage.read');
    expect(me.permissions).not.toContain('expense.submit');
    expect((await call(viewer, 'GET', '/v1/storage/usage')).statusCode).toBe(200);

    const audit = await withTenant(api.tenantId, (tx) =>
      tx.auditLog.list({ resourceType: 'tenant_user', resourceId: viewer.userId }),
    );
    expect(audit.find((entry) => entry.action === 'member.role_changed')?.metadata).toMatchObject({
      customRoleId: auditor.id,
    });
  });

  it('holding what the giver does not are the owner’s to give', async () => {
    const hr = json<RoleBody>(
      await call(owner, 'POST', '/v1/roles', {
        name: 'People desk',
        baseRole: 'viewer',
        added: ['hr.manage'],
      }),
    );
    expect(
      code(
        await call(admin, 'PATCH', `/v1/members/${other.userId}/role`, { customRoleId: hr.id }),
      ),
    ).toBe('role_beyond_own');
    expect(
      (await call(owner, 'PATCH', `/v1/members/${other.userId}/role`, { customRoleId: hr.id }))
        .statusCode,
    ).toBe(200);
  });

  it('change for everybody holding them, and are archived only when nobody does', async () => {
    const changed = await call(owner, 'PUT', `/v1/roles/${auditor.id}`, {
      expectedVersion: auditor.version,
      name: 'Auditor',
      added: ['audit.read'],
      removed: [],
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const after = json<RoleBody>(changed);
    expect(after.holders).toBe(1);
    expect((await call(viewer, 'GET', '/v1/storage/usage')).statusCode).toBe(403);

    expect(
      code(
        await call(owner, 'POST', `/v1/roles/${auditor.id}/archive`, {
          expectedVersion: after.version,
        }),
      ),
    ).toBe('role_in_use');
    await call(owner, 'PATCH', `/v1/members/${viewer.userId}/role`, { role: 'viewer' });
    const me = json<{ customRole: unknown }>(await call(viewer, 'GET', '/v1/me'));
    expect(me.customRole).toBeNull();
    expect(
      (
        await call(owner, 'POST', `/v1/roles/${auditor.id}/archive`, {
          expectedVersion: after.version,
        })
      ).statusCode,
    ).toBe(200);
  });
});
