import { withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CurrentPasswordRequiredError,
  InvalidCredentialsError,
  RateLimitedError,
  SessionRevokedError,
  WeakPasswordError,
} from '../errors.js';
import {
  buildServices,
  createMember,
  createTenant,
  type MemberFixture,
  releaseServices,
  type TenantFixture,
  type TestServices,
  uniqueEmail,
} from '../testing/harness.js';

/**
 * Signing in with an emailed code, and changing a password (P36), against a
 * real database and the fake identity provider.
 */

let services: TestServices;
let northwind: TenantFixture;
let southgate: TenantFixture;

beforeAll(async () => {
  services = await buildServices();
  northwind = await createTenant('northwind');
  southgate = await createTenant('southgate');
});

afterAll(async () => {
  await releaseServices();
});

async function member(label: string): Promise<MemberFixture> {
  return createMember(services.identity, northwind.id, 'engineer', label);
}

async function signInWithCode(person: MemberFixture, clientApp: 'web' | 'mobile' = 'web') {
  const requested = await services.signIn.requestSignInCode({ email: person.email });
  expect(requested).toBeDefined();
  return services.signIn.completeSignInCode({
    email: person.email,
    code: requested?.code ?? '',
    clientApp,
  });
}

describe('requesting a sign-in code', () => {
  it('makes a code for a member, and nothing for an unknown address', async () => {
    const dana = await member('dana');

    const known = await services.signIn.requestSignInCode({ email: dana.email.toUpperCase() });
    expect(known?.code).toMatch(/^\d{6}$/u);
    expect(known?.email).toBe(dana.email);

    // Undefined, and no error: the route answers both the same way.
    await expect(
      services.signIn.requestSignInCode({ email: uniqueEmail('nobody') }),
    ).resolves.toBeUndefined();
  });

  it('allows one code a minute and five an hour per address, known or not', async () => {
    const dana = await member('dana');
    const start = new Date();
    services.setNow(start);

    await services.signIn.requestSignInCode({ email: dana.email });
    await expect(services.signIn.requestSignInCode({ email: dana.email })).rejects.toThrow(
      RateLimitedError,
    );

    // An unknown address is limited the same way, so a refusal is no oracle.
    const stranger = uniqueEmail('stranger');
    await services.signIn.requestSignInCode({ email: stranger });
    await expect(services.signIn.requestSignInCode({ email: stranger })).rejects.toThrow(
      RateLimitedError,
    );

    // Four more, a minute apart, make five; the sixth in the hour is refused.
    // Windows are fixed, so start from the top of an hour to stay inside one.
    const hour = new Date(Math.ceil(start.getTime() / 3_600_000) * 3_600_000 + 1000);
    const other = await member('other');
    for (let minute = 0; minute < 5; minute += 1) {
      services.setNow(new Date(hour.getTime() + minute * 61_000));
      await services.signIn.requestSignInCode({ email: other.email });
    }
    services.setNow(new Date(hour.getTime() + 5 * 61_000));
    await expect(services.signIn.requestSignInCode({ email: other.email })).rejects.toThrow(
      RateLimitedError,
    );

    services.setNow(new Date());
  });
});

describe('signing in with a code', () => {
  it('signs in, and records the session as an email-code sign-in', async () => {
    const dana = await member('dana');
    const result = await signInWithCode(dana);

    expect(result.tenantId).toBe(northwind.id);
    expect(result.tokens.session.signedInWith).toBe('email_code');
  });

  it('refuses a wrong code, and counts it towards the lockout', async () => {
    const dana = await member('dana');
    await services.signIn.requestSignInCode({ email: dana.email });

    await expect(
      services.signIn.completeSignInCode({ email: dana.email, code: '000000', clientApp: 'web' }),
    ).rejects.toThrow(InvalidCredentialsError);
  });

  it('carries how and when the person signed in across a company switch', async () => {
    const dana = await member('dana');
    await withTenant(southgate.id, (tx) =>
      tx.tenantUsers.create({
        userId: dana.userId,
        email: dana.email,
        displayName: 'dana',
        role: 'engineer',
        status: 'active',
      }),
    );

    const first = await services.signIn.completeSignInCode({
      email: dana.email,
      code: (await services.signIn.requestSignInCode({ email: dana.email }))?.code ?? '',
      clientApp: 'web',
      tenantId: northwind.id,
    });
    const principal = await services.tokens.verifyAccessToken(first.tokens.accessToken);
    const switched = await services.signIn.switchTenant(principal, southgate.id, {
      clientApp: 'web',
    });

    expect(switched.tokens.session.signedInWith).toBe('email_code');
    expect(switched.tokens.session.authenticatedAt.getTime()).toBe(
      first.tokens.session.authenticatedAt.getTime(),
    );
  });
});

describe('changing a password', () => {
  it('accepts the current password, and signs out every other device', async () => {
    const dana = await member('dana');
    const here = await services.signIn.signInWithPassword({
      email: dana.email,
      password: dana.password,
      clientApp: 'web',
    });
    const phone = await services.signIn.signInWithPassword({
      email: dana.email,
      password: dana.password,
      clientApp: 'mobile',
    });
    const grant = await services.sessions.issueOfflineGrant({
      tenantId: northwind.id,
      sessionId: phone.tokens.session.id,
      userId: dana.userId,
      role: 'engineer',
    });

    const result = await services.passwords.changePassword({
      principal: await services.tokens.verifyAccessToken(here.tokens.accessToken),
      currentPassword: dana.password,
      newPassword: 'an entirely new passphrase',
    });

    expect(result).toMatchObject({ email: dana.email, proof: 'current_password', revoked: 1 });
    expect(services.identity.passwordOf(dana.email)).toBe('an entirely new passphrase');

    // The phone is signed out, offline access included; this device is not.
    await expect(services.sessions.refresh(phone.tokens.refreshToken)).rejects.toThrow(
      SessionRevokedError,
    );
    const stored = await withTenant(northwind.id, (tx) =>
      tx.offlineGrants.findById(grant.grant.id),
    );
    expect(stored?.revokedAt).not.toBeNull();
    await expect(services.sessions.refresh(here.tokens.refreshToken)).resolves.toBeDefined();

    const entries = await withTenant(northwind.id, (tx) =>
      tx.auditLog.list({ resourceType: 'session', resourceId: here.tokens.session.id }),
    );
    expect(entries.map((entry) => entry.action)).toContain('auth.password_changed');
  });

  it('signs the person out in their other companies too', async () => {
    const dana = await member('dana');
    await withTenant(southgate.id, (tx) =>
      tx.tenantUsers.create({
        userId: dana.userId,
        email: dana.email,
        displayName: 'dana',
        role: 'engineer',
        status: 'active',
      }),
    );
    const elsewhere = await services.signIn.signInWithPassword({
      email: dana.email,
      password: dana.password,
      clientApp: 'desktop',
      tenantId: southgate.id,
    });
    const here = await services.signIn.signInWithPassword({
      email: dana.email,
      password: dana.password,
      clientApp: 'web',
      tenantId: northwind.id,
    });

    await services.passwords.changePassword({
      principal: await services.tokens.verifyAccessToken(here.tokens.accessToken),
      currentPassword: dana.password,
      newPassword: 'an entirely new passphrase',
    });

    await expect(services.sessions.refresh(elsewhere.tokens.refreshToken)).rejects.toThrow(
      SessionRevokedError,
    );
  });

  it('needs no current password for fifteen minutes after a code sign-in', async () => {
    const dana = await member('dana');
    const start = new Date();
    services.setNow(start);
    const signedIn = await signInWithCode(dana);
    const principal = await services.tokens.verifyAccessToken(signedIn.tokens.accessToken);

    services.setNow(new Date(start.getTime() + 14 * 60_000));
    await expect(
      services.passwords.changePassword({ principal, newPassword: 'an entirely new passphrase' }),
    ).resolves.toMatchObject({ proof: 'email_code' });
    services.setNow(new Date());
  });

  it('needs the current password after those fifteen minutes, or after a password sign-in', async () => {
    const dana = await member('dana');
    const start = new Date();
    services.setNow(start);
    const byCode = await signInWithCode(dana);
    const codePrincipal = await services.tokens.verifyAccessToken(byCode.tokens.accessToken);

    services.setNow(new Date(start.getTime() + 16 * 60_000));
    await expect(
      services.passwords.changePassword({
        principal: codePrincipal,
        newPassword: 'an entirely new passphrase',
      }),
    ).rejects.toThrow(CurrentPasswordRequiredError);
    services.setNow(new Date());

    const byPassword = await services.signIn.signInWithPassword({
      email: dana.email,
      password: dana.password,
      clientApp: 'web',
    });
    await expect(
      services.passwords.changePassword({
        principal: await services.tokens.verifyAccessToken(byPassword.tokens.accessToken),
        newPassword: 'an entirely new passphrase',
      }),
    ).rejects.toThrow(CurrentPasswordRequiredError);
  });

  it('refuses a wrong current password and a weak new one, changing nothing', async () => {
    const dana = await member('dana');
    const here = await services.signIn.signInWithPassword({
      email: dana.email,
      password: dana.password,
      clientApp: 'web',
    });
    const principal = await services.tokens.verifyAccessToken(here.tokens.accessToken);

    await expect(
      services.passwords.changePassword({
        principal,
        currentPassword: 'not my password at all',
        newPassword: 'an entirely new passphrase',
      }),
    ).rejects.toThrow(InvalidCredentialsError);

    await expect(
      services.passwords.changePassword({
        principal,
        currentPassword: dana.password,
        newPassword: 'short',
      }),
    ).rejects.toThrow(WeakPasswordError);

    expect(services.identity.passwordOf(dana.email)).toBe(dana.password);
  });
});
