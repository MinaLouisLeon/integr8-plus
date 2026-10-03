import { getPlatformDataSource, withTenant } from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordingEmailSender } from '../email/sender.js';
import { type ApiHarness, startApi } from '../testing/api-harness.js';

/**
 * A stranger making their own company (P18).
 *
 * The claim being tested is the one the whole design rests on: **nothing is
 * created until the address is proved.** Signing up writes a row and sends a
 * message; the company, its job types, its storage and its trial arrive only
 * when the link is followed.
 *
 * The rest follows from that: an abandoned signup costs a row, a link cannot be
 * spent twice, and an address that already has a company gets exactly the same
 * answer as one that does not — because an endpoint that distinguishes them
 * enumerates your customers one guess at a time.
 */

let api: ApiHarness;
let email: RecordingEmailSender;

const WEB = 'https://app.test.integr8.example';

beforeAll(async () => {
  api = await startApi({ env: { WEB_APP_URL: WEB } });
  email = api.services.email as RecordingEmailSender;
});

afterAll(async () => {
  await api.close();
});

function address(label: string): string {
  return `${label}.${randomUUID().slice(0, 8)}@test.integr8.example`;
}

const headers = { 'x-client-version': '1.0.0', 'x-client-app': 'web' };

async function signUp(to: string, companyName: string) {
  const response = await api.app.inject({
    method: 'POST',
    url: '/v1/signup',
    remoteAddress: api.remoteAddress,
    headers,
    payload: { email: to, companyName },
  });
  expect(response.statusCode, response.body).toBe(202);
  return response;
}

/** Pulls the verification token out of the message, as the person would. */
function tokenFrom(to: string): string {
  const message = email.lastTo(to);
  expect(message, `no message was sent to ${to}`).toBeDefined();
  const match = /sign-up\/verify\?token=([^\s]+)/u.exec(message?.text ?? '');
  expect(match, 'the message carried no verification link').not.toBeNull();
  return decodeURIComponent(match?.[1] ?? '');
}

function verify(token: string, displayName = 'Sam Owner', password = 'a-long-enough-password') {
  return api.app.inject({
    method: 'POST',
    url: '/v1/signup/verify',
    remoteAddress: api.remoteAddress,
    headers,
    payload: { token, displayName, password },
  });
}

describe('asking for a company', () => {
  it('creates nothing at all until the link is followed', async () => {
    const to = address('nothing-yet');
    await signUp(to, 'Nothing Yet Ltd');

    const platform = getPlatformDataSource();

    // A row, and a message. That is the whole cost of an unverified signup.
    const request = await platform.signup.findLatestByEmail(to);
    expect(request?.status).toBe('pending');
    expect(request?.tenantId).toBeNull();

    // No company anywhere with that name.
    const companies = await platform.tenants.directory({ includeDeleted: true });
    expect(companies.some((company) => company.name === 'Nothing Yet Ltd')).toBe(false);

    const message = email.lastTo(to);
    expect(message?.subject).toContain('Confirm');
    expect(message?.text).toContain('Nothing has been created yet');
  });

  it('answers identically for an address that already has a company', async () => {
    const to = address('twice-over');
    const first = await signUp(to, 'First Company');
    const second = await signUp(to, 'Second Company');

    // Byte for byte the same. Anything else is an oracle for who your
    // customers are.
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.body).toBe(first.body);
  });
});

describe('following the link', () => {
  it('creates the company, its job types, its trial and an active owner', async () => {
    const to = address('founder');
    await signUp(to, 'Founder Heating');

    const verified = await verify(tokenFrom(to), 'Alex Founder');
    expect(verified.statusCode, verified.body).toBe(200);

    const body = JSON.parse(verified.body) as { tenantId: string; email: string };
    expect(body.email).toBe(to);
    // No tokens, for the same reason accepting an invitation returns none: the
    // link may be sitting in a mailbox.
    expect(verified.body).not.toContain('accessToken');

    const platform = getPlatformDataSource();
    const tenant = await platform.tenants.findById(body.tenantId);
    expect(tenant?.name).toBe('Founder Heating');
    // Derived from the name, not chosen by the caller: a self-serve flow where
    // two people pick the same slug is a flow that races.
    expect(tenant?.slug).toMatch(/^founder-heating/u);

    // On a trial, with a subscription row, from the first day.
    const subscription = await platform.billing.find(body.tenantId);
    expect(subscription?.status).toBe('trialing');
    expect(subscription?.trialEndsAt).not.toBeNull();

    const inside = await withTenant(body.tenantId, async (tx) => ({
      jobTypes: (await tx.jobTypes.list()).length,
      members: await tx.tenantUsers.list(),
      settings: await tx.settings.get(),
    }));

    expect(inside.jobTypes).toBeGreaterThan(0);
    // Made directly, not invited: sending somebody an invitation to a company
    // they have just created themselves would be absurd.
    expect(inside.members).toHaveLength(1);
    expect(inside.members[0]).toMatchObject({ role: 'owner', status: 'active', email: to });
    expect(inside.settings.timezone).toBe('UTC');

    // And they can sign in with the password they just chose.
    const signedIn = await api.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      remoteAddress: api.remoteAddress,
      headers,
      payload: { email: to, password: 'a-long-enough-password', clientApp: 'web' },
    });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
  });

  it('refuses the same link twice, so a prefetching mail client cannot make two companies', async () => {
    const to = address('double-click');
    await signUp(to, 'Double Click Ltd');
    const token = tokenFrom(to);

    expect((await verify(token)).statusCode).toBe(200);

    const again = await verify(token);
    expect(again.statusCode).toBe(422);
    expect((JSON.parse(again.body) as { error: { code: string } }).error.code).toBe(
      'invalid_signup_token',
    );
  });

  it('refuses a weak password before creating anything, and keeps the link usable', async () => {
    // Not "weak-password": the policy also refuses a password that repeats
    // part of the address, which would make the good password below fail too.
    const to = address('feeble');
    await signUp(to, 'Weak Ltd');
    const token = tokenFrom(to);

    const refused = await verify(token, 'Sam Owner', 'short');
    expect(refused.statusCode, refused.body).toBe(422);
    expect((JSON.parse(refused.body) as { error: { code: string } }).error.code).toBe(
      'auth.weak_password',
    );

    // Nothing was made, and the same link goes on to work with a real password.
    const companies = await getPlatformDataSource().tenants.directory({ includeDeleted: true });
    expect(companies.some((company) => company.name === 'Weak Ltd')).toBe(false);
    expect((await verify(token)).statusCode).toBe(200);
  });

  it('refuses a token that never existed, without saying so', async () => {
    const refused = await verify('not-a-real-token');
    expect(refused.statusCode).toBe(422);
    expect((JSON.parse(refused.body) as { error: { code: string } }).error.code).toBe(
      'invalid_signup_token',
    );
  });
});

describe('resending', () => {
  it('rotates the link, so the first one stops working', async () => {
    const to = address('resend-signup');
    await signUp(to, 'Resend Ltd');
    const first = tokenFrom(to);

    const resent = await api.app.inject({
      method: 'POST',
      url: '/v1/signup/resend',
      remoteAddress: api.remoteAddress,
      headers,
      payload: { email: to },
    });
    expect(resent.statusCode).toBe(202);

    const second = tokenFrom(to);
    expect(second).not.toBe(first);

    expect((await verify(first)).statusCode).toBe(422);
    expect((await verify(second)).statusCode).toBe(200);
  });

  it('stops after three, so it cannot be used to fill a stranger’s inbox', async () => {
    const to = address('resend-flood');
    await signUp(to, 'Flood Ltd');
    const sentTo = () => email.sent.filter((message) => message.to === to).length;
    expect(sentTo()).toBe(1);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const resent = await api.app.inject({
        method: 'POST',
        url: '/v1/signup/resend',
        remoteAddress: api.remoteAddress,
        headers,
        payload: { email: to },
      });
      // The answer never changes: saying "no more" would say "this address
      // has a request", which is the thing the endpoint must not say.
      expect(resent.statusCode).toBe(202);
    }

    // One original and three resends. The fourth and fifth asked for nothing
    // that was sent.
    expect(sentTo()).toBe(4);

    // The last link that was actually sent still works.
    expect((await verify(tokenFrom(to))).statusCode).toBe(200);
  });
});

describe('the funnel', () => {
  it('records the steps, including the ones before any company exists', async () => {
    const to = address('funnel');

    // A page view, from a browser with no account at all.
    const viewed = await api.app.inject({
      method: 'POST',
      url: '/v1/signup/step',
      remoteAddress: api.remoteAddress,
      headers,
      payload: { step: 'pricing.viewed', plan: 'starter' },
    });
    expect(viewed.statusCode).toBe(202);

    await signUp(to, 'Funnel Ltd');
    await verify(tokenFrom(to));

    const steps = await getPlatformDataSource().signup.funnel(new Date(Date.now() - 60_000));
    const names = steps.map((step) => step.step);

    // The whole point of this table: `audit_log` is tenant-scoped and could not
    // have held the first three of these.
    expect(names).toContain('pricing.viewed');
    expect(names).toContain('signup.started');
    expect(names).toContain('signup.email_sent');
    expect(names).toContain('signup.verified');
    expect(names).toContain('signup.provisioned');
  });

  it('carries nothing that identifies a person', async () => {
    const to = address('private');
    await signUp(to, 'Private Ltd');

    const events = await getPlatformDataSource().signup.recentEvents(50);
    const serialised = JSON.stringify(events);

    // The table answers "how many gave up here", never "who".
    expect(serialised).not.toContain(to);
    expect(serialised).not.toContain('Private Ltd');
  });
});
