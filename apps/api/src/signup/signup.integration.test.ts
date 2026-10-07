import { IdentityProviderError } from '@integr8/auth';
import { getPlatformDataSource, withTenant } from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  // This suite is about the self-serve flow, so it opens it; the default is
  // off, and `signup-closed.integration.test.ts` covers that.
  api = await startApi({ env: { WEB_APP_URL: WEB, PUBLIC_SIGNUP: 'open' } });
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

  it('makes one company when the same link is followed twice at once', async () => {
    // Not one after the other — at the same time, which is what a prefetching
    // mail client and a person's click produce. Both used to pass the "still
    // pending" read and both provisioned; now the request is claimed before
    // anything is made, and exactly one claim succeeds.
    const to = address('race');
    await signUp(to, 'Race Condition Ltd');
    const token = tokenFrom(to);

    const [first, second] = await Promise.all([verify(token, 'One'), verify(token, 'Two')]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses, `${first.body} / ${second.body}`).toEqual([200, 422]);

    const refused = first.statusCode === 422 ? first : second;
    expect((JSON.parse(refused.body) as { error: { code: string } }).error.code).toBe(
      'invalid_signup_token',
    );

    const companies = await getPlatformDataSource().tenants.directory({ includeDeleted: true });
    expect(companies.filter((company) => company.name === 'Race Condition Ltd')).toHaveLength(1);

    const request = await getPlatformDataSource().signup.findLatestByEmail(to);
    expect(request?.status).toBe('verified');
  });

  it('completes for an address that already has an identity, using that identity', async () => {
    // Somebody who already signs in somewhere — another company, or an account
    // left over from one — starts a company of their own. GoTrue refuses to
    // create a second user for the address, so the existing one must be found
    // and used; the fake provider now refuses duplicates too, so this would
    // fail without the lookup.
    const to = address('returning');
    const existing = await api.services.identity.createIdentity(to, 'their-existing-password');

    await signUp(to, 'Returning Founder Ltd');
    const verified = await verify(tokenFrom(to), 'Returning Founder', 'a-brand-new-password');
    expect(verified.statusCode, verified.body).toBe(200);

    const body = JSON.parse(verified.body) as { tenantId: string };
    const members = await withTenant(body.tenantId, (tx) => tx.tenantUsers.list());
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: existing.userId, role: 'owner', status: 'active' });

    // Their credential is the one they had. A signup link is not a password
    // reset for an identity some other company's sign-in may rest on.
    const signedIn = await api.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      remoteAddress: api.remoteAddress,
      headers,
      payload: { email: to, password: 'their-existing-password', clientApp: 'web' },
    });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
  });

  it('gives the link back when provisioning fails, so the next attempt works', async () => {
    const to = address('outage');
    await signUp(to, 'Outage Ltd');
    const token = tokenFrom(to);

    // The identity provider is down for exactly one call.
    const down = vi
      .spyOn(api.services.identity, 'createIdentity')
      .mockRejectedValueOnce(new IdentityProviderError('GoTrue is not answering'));
    try {
      const failed = await verify(token);
      expect(failed.statusCode, failed.body).toBe(502);
    } finally {
      down.mockRestore();
    }

    // Nothing was made, the claim was released, and the funnel saw it.
    const platform = getPlatformDataSource();
    const companies = await platform.tenants.directory({ includeDeleted: true });
    expect(companies.some((company) => company.name === 'Outage Ltd')).toBe(false);
    expect((await platform.signup.findLatestByEmail(to))?.status).toBe('pending');

    const events = await platform.signup.recentEvents(50);
    expect(
      events.some(
        (event) =>
          event.step === 'signup.failed' && event.metadata.reason === 'provisioning_failed',
      ),
    ).toBe(true);

    // The same link, once the provider is back.
    const retried = await verify(token);
    expect(retried.statusCode, retried.body).toBe(200);
  });

  it('refuses a weak password before creating anything, and keeps the link usable', async () => {
    // Not "weak-password": the policy also refuses a password that repeats
    // part of the address, which would make the good password below fail too.
    const to = address('feeble');
    // A unique name: the suite's database persists between local runs, and the
    // assertion below is that this run created nothing.
    const companyName = `Weak ${randomUUID().slice(0, 8)} Ltd`;
    await signUp(to, companyName);
    const token = tokenFrom(to);

    const refused = await verify(token, 'Sam Owner', 'short');
    expect(refused.statusCode, refused.body).toBe(422);
    expect((JSON.parse(refused.body) as { error: { code: string } }).error.code).toBe(
      'auth.weak_password',
    );

    // Nothing was made, and the same link goes on to work with a real password.
    const companies = await getPlatformDataSource().tenants.directory({ includeDeleted: true });
    expect(companies.some((company) => company.name === companyName)).toBe(false);
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

  it('measures the time from a company existing to its first submitted form', async () => {
    // The second exit criterion, measured rather than walked with a stopwatch:
    // a stranger signs up, gets a company, and submits a form in it.
    const to = address('stopwatch');
    await signUp(to, 'Stopwatch Ltd');
    const verified = await verify(tokenFrom(to));
    expect(verified.statusCode, verified.body).toBe(200);
    const { tenantId } = JSON.parse(verified.body) as { tenantId: string };

    const token = await signInAs(to);
    await submitFirstForm(token);

    const admin = await api.platformAdmin('funnel-reader');
    const response = await api.call(admin.accessToken, {
      method: 'GET',
      url: '/v1/platform/funnel?days=1',
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = JSON.parse(response.body) as {
      timeToFirstForm: {
        companies: number;
        medianSeconds: number | null;
        items: { tenantId: string; seconds: number }[];
      };
    };

    // This company is measured, from `signup.provisioned` to `submitted_at`,
    // and the median exists because at least one company does.
    const mine = body.timeToFirstForm.items.find((item) => item.tenantId === tenantId);
    expect(mine).toBeDefined();
    expect(mine?.seconds).toBeGreaterThanOrEqual(0);
    expect(mine?.seconds).toBeLessThan(600);
    expect(body.timeToFirstForm.companies).toBeGreaterThanOrEqual(1);
    expect(body.timeToFirstForm.medianSeconds).not.toBeNull();

    // Company ids and seconds. The funnel's promise holds for this too.
    const serialised = JSON.stringify(body.timeToFirstForm);
    expect(serialised).not.toContain(to);
    expect(serialised).not.toContain('Stopwatch Ltd');
  });
});

/** Signs in as a self-serve owner, with the password every `verify` in this file chooses. */
async function signInAs(to: string): Promise<string> {
  const signedIn = await api.app.inject({
    method: 'POST',
    url: '/v1/auth/sign-in',
    remoteAddress: api.remoteAddress,
    headers,
    payload: { email: to, password: 'a-long-enough-password', clientApp: 'web' },
  });
  expect(signedIn.statusCode, signedIn.body).toBe(200);
  return (JSON.parse(signedIn.body) as { tokens: { accessToken: string } }).tokens.accessToken;
}

/**
 * The emptiest form the engine accepts, published and submitted once.
 *
 * What is being measured is *that* a form was submitted and when, not what was
 * in it, so one optional question is the whole form.
 */
async function submitFirstForm(token: string): Promise<void> {
  const created = await api.call(token, {
    method: 'POST',
    url: '/v1/forms',
    payload: { title: 'First form' },
  });
  expect(created.statusCode, created.body).toBe(201);
  const formId = (JSON.parse(created.body) as { form: { id: string } }).form.id;

  const detail = JSON.parse(
    (await api.call(token, { method: 'GET', url: `/v1/forms/${formId}` })).body,
  ) as { draft: { revision: number } | null };

  const saved = await api.call(token, {
    method: 'PUT',
    url: `/v1/forms/${formId}/draft`,
    payload: {
      definition: {
        schemaVersion: 1,
        title: { en: 'First form' },
        pages: [
          {
            id: 'page_1',
            sections: [
              {
                id: 'section_1',
                fields: [{ id: 'note', type: 'text', label: { en: 'Anything to add?' } }],
              },
            ],
          },
        ],
      },
      expectedRevision: detail.draft?.revision ?? null,
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);

  const published = await api.call(token, {
    method: 'POST',
    url: `/v1/forms/${formId}/draft/publish`,
    payload: {
      expectedRevision: (JSON.parse(saved.body) as { revision: number }).revision,
      acknowledgeBreakingChanges: false,
    },
  });
  expect(published.statusCode, published.body).toBe(200);

  const draft = await api.call(token, {
    method: 'POST',
    url: '/v1/submissions',
    payload: { formId },
  });
  expect(draft.statusCode, draft.body).toBe(201);
  const started = JSON.parse(draft.body) as { submission: { id: string; revision: number } };

  const submitted = await api.call(token, {
    method: 'POST',
    url: `/v1/submissions/${started.submission.id}/submit`,
    payload: { answers: {}, expectedRevision: started.submission.revision },
  });
  expect(submitted.statusCode, submitted.body).toBe(200);
}
