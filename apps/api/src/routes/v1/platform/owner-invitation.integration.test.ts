import { withTenant } from '@integr8/db';
import { expireInvitation } from '@integr8/db/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordingEmailSender } from '../../../email/sender.js';
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
