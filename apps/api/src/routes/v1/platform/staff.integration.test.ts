import { totpCode } from '@integr8/auth';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type PlatformAdmin, startApi } from '../../../testing/api-harness.js';

/**
 * The Staff screen: who can sign in to the dashboard, and who decides that.
 *
 * Everybody signed in can see the staff. Only an account the terminal command
 * made can add or remove anybody, an account added from the dashboard never
 * can, and a terminal account can only be changed from the terminal — so the
 * power to manage staff stays with whoever holds the server.
 */

let api: ApiHarness;
let manager: PlatformAdmin;
let colleague: PlatformAdmin;

beforeAll(async () => {
  api = await startApi();
  manager = await api.platformAdmin('manager', { manager: true });
  colleague = await api.platformAdmin('colleague');
});

afterAll(async () => {
  await api.close();
});

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

interface StaffMember {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  canManageStaff: boolean;
  addedBy: { id: string; displayName: string } | null;
  ready: boolean;
  isYou: boolean;
}

interface Credentials {
  member: StaffMember;
  password: string;
  totpSecret: string;
  totpUri: string;
}

async function add(token: string, email = `new.${randomUUID().slice(0, 8)}@integr8.example`) {
  return api.call(token, {
    method: 'POST',
    url: '/v1/platform/staff',
    payload: { email, displayName: 'New Colleague' },
  });
}

async function signIn(email: string, password: string, secret: string) {
  return api.app.inject({
    method: 'POST',
    url: '/v1/platform/auth/sign-in',
    remoteAddress: api.remoteAddress,
    headers: { 'x-client-version': '1.0.0', 'x-client-app': 'web' },
    payload: { email, password, code: totpCode(secret) },
  });
}

describe('who may manage staff', () => {
  it('tells each account whether it may', async () => {
    const asManager = await api.call(manager.accessToken, {
      method: 'GET',
      url: '/v1/platform/me',
    });
    expect(json<{ canManageStaff: boolean }>(asManager).canManageStaff).toBe(true);

    const asColleague = await api.call(colleague.accessToken, {
      method: 'GET',
      url: '/v1/platform/me',
    });
    expect(json<{ canManageStaff: boolean }>(asColleague).canManageStaff).toBe(false);
  });

  it('lets anybody signed in see the staff', async () => {
    const response = await api.call(colleague.accessToken, {
      method: 'GET',
      url: '/v1/platform/staff',
    });
    expect(response.statusCode).toBe(200);
    const { items } = json<{ items: StaffMember[] }>(response);
    expect(items.find((item) => item.id === colleague.id)?.isYou).toBe(true);
    expect(items.find((item) => item.id === manager.id)).toMatchObject({
      canManageStaff: true,
      isYou: false,
    });
  });

  it('refuses an account added from the dashboard', async () => {
    const added = await add(colleague.accessToken);
    expect(added.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(added).error.code).toBe('staff_manager_only');

    const removed = await api.call(colleague.accessToken, {
      method: 'DELETE',
      url: `/v1/platform/staff/${manager.id}`,
    });
    expect(removed.statusCode).toBe(403);
  });
});

describe('adding staff', () => {
  it('creates an account that can sign in at once but cannot manage staff', async () => {
    const response = await add(manager.accessToken);
    expect(response.statusCode, response.body).toBe(201);
    const added = json<Credentials>(response);
    expect(added.member).toMatchObject({
      canManageStaff: false,
      isActive: true,
      ready: true,
      addedBy: { id: manager.id },
    });
    expect(added.totpUri).toMatch(/^otpauth:\/\/totp\//u);

    const signedIn = await signIn(added.member.email, added.password, added.totpSecret);
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    const token = json<{ tokens: { accessToken: string } }>(signedIn).tokens.accessToken;
    expect((await add(token)).statusCode).toBe(403);

    const audited = await api.call(manager.accessToken, {
      method: 'GET',
      url: '/v1/platform/audit?action=staff.added',
    });
    expect(audited.body).toContain(added.member.id);
  });

  it('refuses an address somebody already signs in with', async () => {
    const taken = await add(manager.accessToken, colleague.email);
    expect(taken.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(taken).error.code).toBe('staff_exists');
  });
});

describe('removing staff', () => {
  it('ends the account’s sessions and keeps it from signing in again', async () => {
    const added = json<Credentials>(await add(manager.accessToken));
    const signedIn = await signIn(added.member.email, added.password, added.totpSecret);
    const token = json<{ tokens: { accessToken: string } }>(signedIn).tokens.accessToken;

    const removed = await api.call(manager.accessToken, {
      method: 'DELETE',
      url: `/v1/platform/staff/${added.member.id}`,
    });
    expect(removed.statusCode, removed.body).toBe(204);

    const after = await api.call(token, { method: 'GET', url: '/v1/platform/me' });
    expect(after.statusCode).toBe(401);
    const again = await signIn(added.member.email, added.password, added.totpSecret);
    expect(again.statusCode).not.toBe(200);

    const listed = json<{ items: StaffMember[] }>(
      await api.call(manager.accessToken, { method: 'GET', url: '/v1/platform/staff' }),
    ).items.find((item) => item.id === added.member.id);
    expect(listed?.isActive).toBe(false);
  });

  it('ends any company session the removed account had open', async () => {
    const added = json<Credentials>(await add(manager.accessToken));
    const signedIn = await signIn(added.member.email, added.password, added.totpSecret);
    const token = json<{ tokens: { accessToken: string } }>(signedIn).tokens.accessToken;
    const target = await api.member('owner', 'staff-target');

    const started = await api.call(token, {
      method: 'POST',
      url: `/v1/platform/companies/${api.tenantId}/impersonate`,
      payload: {
        targetUserId: target.userId,
        reason: 'Checking the job sheet the customer asked about',
      },
    });
    expect(started.statusCode, started.body).toBe(201);
    const grant = json<{ tokens: { accessToken: string } }>(started);
    expect(
      (await api.call(grant.tokens.accessToken, { method: 'GET', url: '/v1/me' })).statusCode,
    ).toBe(200);

    await api.call(manager.accessToken, {
      method: 'DELETE',
      url: `/v1/platform/staff/${added.member.id}`,
    });

    const after = await api.call(grant.tokens.accessToken, { method: 'GET', url: '/v1/me' });
    expect(after.statusCode).not.toBe(200);
  });

  it('can bring a removed account back with new credentials', async () => {
    const added = json<Credentials>(await add(manager.accessToken));
    await api.call(manager.accessToken, {
      method: 'DELETE',
      url: `/v1/platform/staff/${added.member.id}`,
    });

    const restored = await add(manager.accessToken, added.member.email);
    expect(restored.statusCode, restored.body).toBe(201);
    const body = json<Credentials>(restored);
    expect(body.member).toMatchObject({ id: added.member.id, isActive: true });
    expect((await signIn(body.member.email, body.password, body.totpSecret)).statusCode).toBe(200);
  });

  it('never removes a terminal account, the manager included', async () => {
    const other = await api.platformAdmin('other-manager', { manager: true });
    for (const id of [manager.id, other.id]) {
      const response = await api.call(manager.accessToken, {
        method: 'DELETE',
        url: `/v1/platform/staff/${id}`,
      });
      expect(response.statusCode).toBe(403);
      expect(json<{ error: { code: string } }>(response).error.code).toBe('terminal_account');
    }
  });
});

describe('resetting credentials', () => {
  it('gives a dashboard account new ones and ends its old sessions', async () => {
    const added = json<Credentials>(await add(manager.accessToken));
    const signedIn = await signIn(added.member.email, added.password, added.totpSecret);
    const token = json<{ tokens: { accessToken: string } }>(signedIn).tokens.accessToken;

    const reset = await api.call(manager.accessToken, {
      method: 'POST',
      url: `/v1/platform/staff/${added.member.id}/credentials`,
    });
    expect(reset.statusCode, reset.body).toBe(200);
    const fresh = json<Credentials>(reset);
    expect(fresh.password).not.toBe(added.password);

    expect((await api.call(token, { method: 'GET', url: '/v1/platform/me' })).statusCode).toBe(401);
    expect((await signIn(added.member.email, fresh.password, fresh.totpSecret)).statusCode).toBe(
      200,
    );
  });

  it('is refused for a terminal account, and to a dashboard account', async () => {
    const terminal = await api.call(manager.accessToken, {
      method: 'POST',
      url: `/v1/platform/staff/${manager.id}/credentials`,
    });
    expect(terminal.statusCode).toBe(403);

    const asColleague = await api.call(colleague.accessToken, {
      method: 'POST',
      url: `/v1/platform/staff/${colleague.id}/credentials`,
    });
    expect(asColleague.statusCode).toBe(403);
  });

  it('keeps a dashboard account from removing a terminal account’s second factor', async () => {
    const response = await api.call(colleague.accessToken, {
      method: 'POST',
      url: `/v1/platform/admins/${manager.id}/second-factor/reset`,
      payload: { reason: 'Lost their phone on the train' },
    });
    expect(response.statusCode).toBe(403);
  });
});
