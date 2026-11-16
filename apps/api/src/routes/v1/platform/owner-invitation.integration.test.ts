import { withTenant } from '@integr8/db';
import { expireInvitation } from '@integr8/db/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordingEmailSender } from '../../../email/sender.js';
import { RecordingAppReleases } from '../../../platform/app-releases.js';
import { type ApiHarness, type PlatformAdmin, startApi } from '../../../testing/api-harness.js';

/**
 * Inviting a company's owner when the company is ready, not when it is created.
 *
 * Integr8 creates a company, builds its forms, job types and look, and only
 * then invites its owner. So onboarding does not email by default, the
 * company's page lists the invitation, and staff can email it — or copy a
 * fresh link — whenever they choose, including after the first one expired.
 */

const WEB = 'https://app.test.integr8.example';

let api: ApiHarness;
let admin: PlatformAdmin;
let email: RecordingEmailSender;

beforeAll(async () => {
  api = await startApi({ env: { WEB_APP_URL: WEB } });
  admin = await api.platformAdmin();
  email = api.services.email as RecordingEmailSender;
});

afterAll(async () => {
  await api.close();
});

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

interface Onboarded {
  company: { id: string };
  ownerInvitation: { id: string; email: string; acceptUrl: string | null; emailed: boolean };
}

async function onboard(sendInvitation?: boolean): Promise<Onboarded & { owner: string }> {
  const slug = `inv-${randomUUID().slice(0, 8)}`;
  const owner = `owner@${slug}.example`;
  const response = await api.call(admin.accessToken, {
    method: 'POST',
    url: '/v1/platform/companies',
    payload: {
      slug,
      name: 'Ready Later Ltd',
      ownerEmail: owner,
      ...(sendInvitation === undefined ? {} : { sendInvitation }),
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return { ...json<Onboarded>(response), owner };
}

describe('onboarding', () => {
  it('does not email the owner unless asked, and still hands back the link', async () => {
    const before = email.sent.length;
    const onboarded = await onboard();
    expect(onboarded.ownerInvitation.emailed).toBe(false);
    expect(onboarded.ownerInvitation.acceptUrl).toContain(`${WEB}/accept-invitation`);
    expect(email.sent.length).toBe(before);
  });

  it('emails the owner at once when asked', async () => {
    const onboarded = await onboard(true);
    expect(onboarded.ownerInvitation.emailed).toBe(true);
    expect(email.lastTo(onboarded.owner)?.subject).toContain('Integr8 has invited you');
  });
});

describe('the company page', () => {
  it('lists the invitation waiting to be accepted', async () => {
    const onboarded = await onboard();
    const detail = await api.call(admin.accessToken, {
      method: 'GET',
      url: `/v1/platform/companies/${onboarded.company.id}`,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(json<{ invitations: unknown[] }>(detail).invitations).toEqual([
      expect.objectContaining({
        id: onboarded.ownerInvitation.id,
        email: onboarded.owner,
        role: 'owner',
        expired: false,
      }),
    ]);
  });
});

describe('sending it later', () => {
  it('emails a fresh invitation and withdraws the old one', async () => {
    const onboarded = await onboard();
    const response = await api.call(admin.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${onboarded.company.id}/invitations/${onboarded.ownerInvitation.id}/resend`,
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    const resent = json<{ id: string; emailed: boolean; acceptUrl: string }>(response);
    expect(resent.emailed).toBe(true);
    expect(resent.id).not.toBe(onboarded.ownerInvitation.id);
    expect(email.lastTo(onboarded.owner)?.text).toContain(resent.acceptUrl);

    const pending = await withTenant(onboarded.company.id, (tx) => tx.invitations.listPending());
    expect(pending.map((invitation) => invitation.id)).toEqual([resent.id]);
  });

  it('can hand back only a fresh link, sending nothing', async () => {
    const onboarded = await onboard();
    const before = email.sent.length;
    const response = await api.call(admin.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${onboarded.company.id}/invitations/${onboarded.ownerInvitation.id}/resend`,
      payload: { sendEmail: false },
    });
    expect(response.statusCode, response.body).toBe(200);
    const resent = json<{ emailed: boolean; acceptUrl: string }>(response);
    expect(resent.emailed).toBe(false);
    expect(resent.acceptUrl).toContain(`${WEB}/accept-invitation`);
    expect(email.sent.length).toBe(before);
  });

  it('revives an invitation that expired while the company was being set up', async () => {
    const onboarded = await onboard();
    await expireInvitation(onboarded.ownerInvitation.id);

    const detail = await api.call(admin.accessToken, {
      method: 'GET',
      url: `/v1/platform/companies/${onboarded.company.id}`,
    });
    expect(json<{ invitations: { expired: boolean }[] }>(detail).invitations[0]?.expired).toBe(
      true,
    );

    const response = await api.call(admin.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${onboarded.company.id}/invitations/${onboarded.ownerInvitation.id}/resend`,
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    const resent = json<{ expiresAt: string }>(response);
    expect(new Date(resent.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);
  });
});

describe('waiting for the company’s own desktop app (P42, D6)', () => {
  // The harness reads no releases (APP_RELEASES=off), so nothing above waits.
  // Here the releases are a recording stand-in that says what has been built.
  let releases: RecordingAppReleases;
  let original: ApiHarness['services']['appReleases'];

  beforeAll(() => {
    original = api.services.appReleases;
    releases = new RecordingAppReleases();
    api.services.appReleases = releases;
  });

  afterAll(() => {
    api.services.appReleases = original;
  });

  async function appsOn(companyId: string): Promise<void> {
    const response = await api.call(admin.accessToken, {
      method: 'PATCH',
      url: `/v1/platform/companies/${companyId}/settings`,
      payload: { appsEnabled: true },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function resend(onboarded: Onboarded) {
    return api.call(admin.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${onboarded.company.id}/invitations/${onboarded.ownerInvitation.id}/resend`,
      payload: {},
    });
  }

  async function companyApp(companyId: string): Promise<string> {
    const detail = await api.call(admin.accessToken, {
      method: 'GET',
      url: `/v1/platform/companies/${companyId}`,
    });
    return json<{ companyApp: string }>(detail).companyApp;
  }

  it('hands back no link at onboarding and refuses to email one', async () => {
    const onboarded = await onboard();
    expect(onboarded.ownerInvitation.acceptUrl).toBeNull();

    const slug = `inv-${randomUUID().slice(0, 8)}`;
    const refused = await api.call(admin.accessToken, {
      method: 'POST',
      url: '/v1/platform/companies',
      payload: {
        slug,
        name: 'Too Soon Ltd',
        ownerEmail: `owner@${slug}.example`,
        sendInvitation: true,
      },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(json<{ error: { code: string } }>(refused).error.code).toBe('company_app_not_built');
  });

  it('refuses until the apps are on and built, then sends it', async () => {
    const onboarded = await onboard();
    const slug = json<{ slug: string }>(
      await api.call(admin.accessToken, {
        method: 'GET',
        url: `/v1/platform/companies/${onboarded.company.id}`,
      }),
    ).slug;

    expect(await companyApp(onboarded.company.id)).toBe('apps_off');
    const off = await resend(onboarded);
    expect(off.statusCode, off.body).toBe(409);
    expect(json<{ error: { code: string } }>(off).error.code).toBe('company_app_not_built');

    await appsOn(onboarded.company.id);
    expect(await companyApp(onboarded.company.id)).toBe('not_built');
    expect((await resend(onboarded)).statusCode).toBe(409);

    releases.unavailable = true;
    expect(await companyApp(onboarded.company.id)).toBe('unavailable');
    const unknown = await resend(onboarded);
    expect(unknown.statusCode, unknown.body).toBe(503);
    expect(json<{ error: { code: string } }>(unknown).error.code).toBe('releases_unavailable');
    releases.unavailable = false;

    releases.built.add(slug);
    expect(await companyApp(onboarded.company.id)).toBe('ready');
    const sent = await resend(onboarded);
    expect(sent.statusCode, sent.body).toBe(200);
    const body = json<{ emailed: boolean; acceptUrl: string }>(sent);
    expect(body.emailed).toBe(true);
    expect(body.acceptUrl).toContain(`${WEB}/accept-invitation`);
  });

  it('holds invitations sent from inside the company too', async () => {
    // The harness's own company: apps off, nothing built.
    const owner = await api.member('owner', 'gate-owner');
    const token = await api.signIn(owner);
    const refused = await api.call(token, {
      method: 'POST',
      url: '/v1/members/invitations',
      headers: { 'idempotency-key': randomUUID() },
      payload: { email: `engineer-${randomUUID().slice(0, 8)}@gate.example`, role: 'engineer' },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(json<{ error: { code: string } }>(refused).error.code).toBe('company_app_not_built');
  });

  it('does not hold up a test company, which gets no app builds', async () => {
    const slug = `inv-${randomUUID().slice(0, 8)}`;
    const response = await api.call(admin.accessToken, {
      method: 'POST',
      url: '/v1/platform/companies',
      payload: {
        slug,
        name: 'Test Ltd',
        ownerEmail: `owner@${slug}.example`,
        isTest: true,
        sendInvitation: true,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(json<Onboarded>(response).ownerInvitation.acceptUrl).toContain('/accept-invitation');
  });
});

describe('the staff app’s downloads', () => {
  it('lists nothing when the deployment reads no releases', async () => {
    const response = await api.call(admin.accessToken, {
      method: 'GET',
      url: '/v1/platform/downloads',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(json<unknown>(response)).toEqual({
      staff: { status: 'none' },
      formsAi: { status: 'none' },
      devMcp: { status: 'none' },
    });
  });
});
