import type { FakeIdentityProvider } from '@integr8/auth';
import { getPlatformDataSource } from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordingEmailSender } from '../../email/sender.js';
import { createLogger } from '../../http/logger.js';
import { deleteOrphanedIdentities } from '../../platform/purge.js';
import { type ApiHarness, startApi } from '../../testing/api-harness.js';

/**
 * Signing in with an emailed code, changing a password, and deleting sign-in
 * accounts after a purge (P36), through the HTTP surface.
 *
 * The harness runs on the fake identity provider and the recording email
 * sender, so a test reads the code out of the message that would have gone,
 * exactly as the person would.
 */

let api: ApiHarness;
let email: RecordingEmailSender;
let identity: FakeIdentityProvider;

const silent = createLogger({ level: 'error', write: () => undefined });

beforeAll(async () => {
  api = await startApi();
  email = api.services.email as RecordingEmailSender;
  identity = api.services.identity as FakeIdentityProvider;
});

afterAll(async () => {
  await api.close();
});

/** The code request answers before the email goes, so wait for it to arrive. */
async function codeFor(address: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const message = email.lastTo(address);
    if (message?.code !== undefined) {
      return message.code;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No sign-in code reached ${address}`);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200));
}

function requestCode(address: string, locale?: 'en' | 'ar') {
  return api.app.inject({
    method: 'POST',
    url: '/v1/auth/magic-link',
    remoteAddress: api.remoteAddress,
    headers: { 'x-client-version': '1.0.0', 'x-client-app': 'web' },
    payload: { email: address, ...(locale === undefined ? {} : { locale }) },
  });
}

function completeCode(address: string, code: string, clientApp: 'web' | 'mobile' = 'web') {
  return api.app.inject({
    method: 'POST',
    url: '/v1/auth/magic-link/complete',
    remoteAddress: api.remoteAddress,
    headers: { 'x-client-version': '1.0.0', 'x-client-app': clientApp },
    payload: { email: address, token: code, clientApp },
  });
}

describe('signing in with an emailed code', () => {
  it('emails a code that signs in, in the language asked for', async () => {
    const dana = await api.member('engineer', 'code-dana');

    const requested = await requestCode(dana.email, 'ar');
    expect(requested.statusCode).toBe(202);

    const code = await codeFor(dana.email);
    expect(code).toMatch(/^\d{6}$/u);
    const message = email.lastTo(dana.email);
    if (message === undefined) {
      throw new Error(`No email reached ${dana.email}`);
    }
    expect(message.text).toContain(code);
    expect(message.html).toContain('dir="rtl"');

    const signedIn = await completeCode(dana.email, code);
    expect(signedIn.statusCode).toBe(200);
    expect((JSON.parse(signedIn.body) as { tenantId: string }).tenantId).toBe(api.tenantId);
  });

  it('answers a known and an unknown address the same way, and emails only one', async () => {
    const dana = await api.member('engineer', 'code-known');
    const stranger = `nobody.${randomUUID().slice(0, 8)}@test.integr8.example`;

    const known = await requestCode(dana.email);
    const unknown = await requestCode(stranger);

    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.body).toBe(known.body);

    await codeFor(dana.email);
    await settle();
    expect(email.lastTo(stranger)).toBeUndefined();
  });

  it('refuses a second code within the minute, for any address', async () => {
    const stranger = `nobody.${randomUUID().slice(0, 8)}@test.integr8.example`;
    expect((await requestCode(stranger)).statusCode).toBe(202);
    const again = await requestCode(stranger);
    expect(again.statusCode).toBe(429);
    expect((JSON.parse(again.body) as { error: { code: string } }).error.code).toBe(
      'auth.rate_limited',
    );
  });

  it('refuses a wrong code', async () => {
    const dana = await api.member('engineer', 'code-wrong');
    await requestCode(dana.email);
    await codeFor(dana.email);

    const wrong = await completeCode(dana.email, '000000');
    expect(wrong.statusCode).toBe(401);
  });
});

describe('changing a password', () => {
  it('needs no current password straight after a code sign-in, and emails the address', async () => {
    const dana = await api.member('engineer', 'pw-code');
    // Another device, signed in with the old password.
    await api.signIn(dana);

    await requestCode(dana.email);
    const signedIn = await completeCode(dana.email, await codeFor(dana.email));
    const token = (JSON.parse(signedIn.body) as { tokens: { accessToken: string } }).tokens
      .accessToken;

    const changed = await api.call(token, {
      method: 'POST',
      url: '/v1/me/password',
      payload: { newPassword: 'an entirely new passphrase' },
    });
    expect(changed.statusCode).toBe(200);
    expect(JSON.parse(changed.body)).toEqual({ signedOutElsewhere: 1, emailed: true });
    expect(identity.passwordOf(dana.email)).toBe('an entirely new passphrase');
    expect(email.lastTo(dana.email)?.subject).toBe('Your Integr8 Plus password was changed');

    // The other device's session is gone; only this one is left.
    const sessions = await api.call(token, { method: 'GET', url: '/v1/sessions' });
    const live = (JSON.parse(sessions.body) as { items: { isCurrent: boolean }[] }).items;
    expect(live).toHaveLength(1);
    expect(live[0]?.isCurrent).toBe(true);
  });

  it('needs the current password after a password sign-in', async () => {
    const dana = await api.member('engineer', 'pw-current');
    const token = await api.signIn(dana);

    const without = await api.call(token, {
      method: 'POST',
      url: '/v1/me/password',
      payload: { newPassword: 'an entirely new passphrase' },
    });
    expect(without.statusCode).toBe(403);
    expect((JSON.parse(without.body) as { error: { code: string } }).error.code).toBe(
      'auth.current_password_required',
    );

    const wrong = await api.call(token, {
      method: 'POST',
      url: '/v1/me/password',
      payload: { currentPassword: 'not it at all', newPassword: 'an entirely new passphrase' },
    });
    expect(wrong.statusCode).toBe(403);
    expect((JSON.parse(wrong.body) as { error: { code: string } }).error.code).toBe(
      'auth.current_password_wrong',
    );

    const weak = await api.call(token, {
      method: 'POST',
      url: '/v1/me/password',
      payload: { currentPassword: dana.password, newPassword: 'short' },
    });
    expect(weak.statusCode).toBe(422);

    const right = await api.call(token, {
      method: 'POST',
      url: '/v1/me/password',
      payload: { currentPassword: dana.password, newPassword: 'an entirely new passphrase' },
    });
    expect(right.statusCode).toBe(200);
  });
});

describe('deleting sign-in accounts after a purge', () => {
  it('deletes only accounts that belong to no company, and retries a failure', async () => {
    const stays = await api.member('engineer', 'purge-stays');
    const orphan = await identity.createIdentity(
      `orphan.${randomUUID().slice(0, 8)}@test.integr8.example`,
      'a perfectly good passphrase',
    );
    const deletions = getPlatformDataSource().identityDeletions;

    await deletions.queue([stays.userId, orphan.userId]);

    identity.failDeletes = true;
    const failed = await deleteOrphanedIdentities({ identity, logger: silent });
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    expect((await deletions.pending()).map((row) => row.userId)).toContain(orphan.userId);

    identity.failDeletes = false;
    await deleteOrphanedIdentities({ identity, logger: silent });

    expect(identity.deleted).toContain(orphan.userId);
    expect(identity.deleted).not.toContain(stays.userId);
    expect(await identity.findByEmail(stays.email)).toBeDefined();
    const pending = (await deletions.pending()).map((row) => row.userId);
    expect(pending).not.toContain(orphan.userId);
    expect(pending).not.toContain(stays.userId);
  });
});
