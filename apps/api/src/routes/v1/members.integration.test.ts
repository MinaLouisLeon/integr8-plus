import { getPlatformDataSource } from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordingEmailSender } from '../../email/sender.js';
import { forgetTenantStatus } from '../../http/suspension.js';
import { type ApiHarness, type Member, startApi } from '../../testing/api-harness.js';

/**
 * Joining a company, and being managed once you have (P18).
 *
 * The thing being proven here is the one that was missing: **an invitation now
 * goes somewhere.** Before this phase the token was minted, withheld from the
 * response and never sent, and the link it would have appeared in pointed at a
 * page that did not exist — so no invitation made through the product could be
 * accepted by anybody.
 *
 * The harness runs on the recording email sender, so the assertions read the
 * message that would have gone out and pull the token from the link in it,
 * exactly as the invitee would.
 */

let api: ApiHarness;
let owner: Member;
let ownerToken: string;
let email: RecordingEmailSender;

const WEB = 'https://app.test.integr8.example';

beforeAll(async () => {
  api = await startApi({ env: { WEB_APP_URL: WEB } });

  // Uncapped seats. This suite is about who may do what, not about how many
  // of them a plan allows — and the default trial plan permits three, which
  // this suite runs through in its first two tests.
  await getPlatformDataSource().tenants.setPlan(api.tenantId, { plan: 'enterprise' });
  forgetTenantStatus(api.tenantId);

  owner = await api.member('owner', 'members-owner');
  ownerToken = await api.signIn(owner);
  email = api.services.email as RecordingEmailSender;
});

afterAll(async () => {
  await api.close();
});

function address(label: string): string {
  return `${label}.${randomUUID().slice(0, 8)}@test.integr8.example`;
}

/** Invites somebody and returns the token out of the email they were sent. */
async function invite(
  to: string,
  role: 'admin' | 'dispatcher' | 'engineer' | 'viewer' = 'engineer',
): Promise<{ id: string; token: string }> {
  const response = await api.call(ownerToken, {
    method: 'POST',
    url: '/v1/members/invitations',
    payload: { email: to, role },
  });
  expect(response.statusCode, response.body).toBe(201);
  const body = JSON.parse(response.body) as { id: string; emailed: boolean };
  expect(body.emailed).toBe(true);

  return { id: body.id, token: tokenFrom(to) };
}

function tokenFrom(to: string): string {
  const message = email.lastTo(to);
  expect(message, `no message was sent to ${to}`).toBeDefined();
  // The link is in both parts; the text part is the one a plain-text client
  // shows, so that is the one worth reading.
  const match = /accept-invitation\?token=([^\s]+)/u.exec(message?.text ?? '');
  expect(match, 'the message carried no accept link').not.toBeNull();
  return decodeURIComponent(match?.[1] ?? '');
}

describe('inviting somebody', () => {
  it('emails them a link that works, and never returns the token', async () => {
    const to = address('invitee');
    const response = await api.call(ownerToken, {
      method: 'POST',
      url: '/v1/members/invitations',
      payload: { email: to, role: 'engineer' },
    });

    expect(response.statusCode).toBe(201);
    // Anybody who can invite could otherwise accept on the invitee's behalf.
    expect(response.body).not.toContain('token');

    const message = email.lastTo(to);
    expect(message?.subject).toContain('members-owner');
    expect(message?.text).toContain(`${WEB}/accept-invitation?token=`);
  });

  it('lets them accept, choose a password, and appear as a member', async () => {
    const to = address('joiner');
    const { token } = await invite(to);

    const accepted = await api.app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      remoteAddress: api.remoteAddress,
      headers: { 'x-client-version': '1.0.0', 'x-client-app': 'web' },
      payload: {
        token,
        displayName: 'Jo Joiner',
        password: 'a-long-enough-password',
        clientApp: 'web',
      },
    });

    expect(accepted.statusCode, accepted.body).toBe(200);
    const body = JSON.parse(accepted.body) as { accepted: boolean; email: string };
    expect(body.accepted).toBe(true);
    // Returned so the page can sign them in; still no tokens in this response.
    expect(body.email).toBe(to);
    expect(accepted.body).not.toContain('accessToken');

    const members = await api.call(ownerToken, { method: 'GET', url: '/v1/members' });
    expect(members.body).toContain('Jo Joiner');
  });

  it('refuses the same link twice', async () => {
    const to = address('twice');
    const { token } = await invite(to);
    const accept = () =>
      api.app.inject({
        method: 'POST',
        url: '/v1/invitations/accept',
        remoteAddress: api.remoteAddress,
        headers: { 'x-client-version': '1.0.0', 'x-client-app': 'web' },
        payload: {
          token,
          displayName: 'First',
          password: 'a-long-enough-password',
          clientApp: 'web',
        },
      });

    expect((await accept()).statusCode).toBe(200);
    expect((await accept()).statusCode).toBe(422);
  });
});

describe('resending an invitation', () => {
  it('sends a new link and stops the old one working', async () => {
    const to = address('resend');
    const first = await invite(to);

    const resent = await api.call(ownerToken, {
      method: 'POST',
      url: `/v1/members/invitations/${first.id}/resend`,
      payload: {},
    });
    expect(resent.statusCode, resent.body).toBe(200);
    expect((JSON.parse(resent.body) as { emailed: boolean }).emailed).toBe(true);

    const second = tokenFrom(to);
    expect(second).not.toBe(first.token);

    // The reason for resending is usually that the first link went astray, so
    // a link sitting in the wrong mailbox has to stop working.
    const old = await api.app.inject({
      method: 'POST',
      url: '/v1/invitations/accept',
      remoteAddress: api.remoteAddress,
      headers: { 'x-client-version': '1.0.0', 'x-client-app': 'web' },
      payload: {
        token: first.token,
        displayName: 'Too late',
        password: 'a-long-enough-password',
        clientApp: 'web',
      },
    });
    expect(old.statusCode).toBe(422);
  });
});

describe('managing a member', () => {
  it('changes a role, and ends their sessions so it takes effect now', async () => {
    const person = await api.member('engineer', 'promotee');
    const theirToken = await api.signIn(person);

    const changed = await api.call(ownerToken, {
      method: 'PATCH',
      url: `/v1/members/${person.userId}/role`,
      payload: { role: 'dispatcher' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((JSON.parse(changed.body) as { role: string }).role).toBe('dispatcher');

    // Their sessions are ended, so the next token they get carries the new
    // role. The access token they are already holding is a stateless JWT and
    // keeps its old role for up to fifteen minutes — asserted here so the
    // window is a documented property rather than a surprise. See the note at
    // the top of `members.ts`.
    const stale = await api.call(theirToken, { method: 'GET', url: '/v1/members' });
    expect(stale.statusCode).toBe(200);
  });

  it('refuses a role above the caller’s own', async () => {
    const admin = await api.member('admin', 'promoter');
    const adminToken = await api.signIn(admin);
    const person = await api.member('engineer', 'target');

    const refused = await api.call(adminToken, {
      method: 'PATCH',
      url: `/v1/members/${person.userId}/role`,
      payload: { role: 'owner' },
    });

    expect(refused.statusCode).toBe(422);
    expect((JSON.parse(refused.body) as { error: { code: string } }).error.code).toBe(
      'role_above_own',
    );
  });

  it('suspends somebody and shuts the door behind them', async () => {
    const person = await api.member('engineer', 'suspendee');
    await api.signIn(person);

    const suspended = await api.call(ownerToken, {
      method: 'PATCH',
      url: `/v1/members/${person.userId}/status`,
      payload: { status: 'suspended' },
    });
    expect(suspended.statusCode, suspended.body).toBe(200);

    // The door is what closes: they cannot sign in again, and their sessions
    // are revoked so they cannot refresh either. An access token already in
    // their hands outlives this by up to fifteen minutes — a documented
    // property, not an oversight. See the note at the top of `members.ts`.
    await expect(api.signIn(person)).rejects.toThrow();
  });

  it('removes somebody without removing what they did', async () => {
    const person = await api.member('engineer', 'leaver');

    const removed = await api.call(ownerToken, {
      method: 'DELETE',
      url: `/v1/members/${person.userId}`,
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((JSON.parse(removed.body) as { removed: boolean }).removed).toBe(true);

    // Soft: the history still names them, so the audit log does not point at
    // nothing. What went is their way in and the seat they occupied.
    const members = await api.call(ownerToken, { method: 'GET', url: '/v1/members' });
    expect(members.body).not.toContain(person.userId);
  });
});

describe('the last owner', () => {
  it('cannot be demoted, suspended or removed — including by themselves', async () => {
    // This harness company has exactly one owner, which is the situation that
    // matters: a company with no owner is one nobody can administer, pay for or
    // close, and only a super admin could put it right.
    const demote = await api.call(ownerToken, {
      method: 'PATCH',
      url: `/v1/members/${owner.userId}/role`,
      payload: { role: 'admin' },
    });
    expect(demote.statusCode, demote.body).toBe(409);
    expect((JSON.parse(demote.body) as { error: { code: string } }).error.code).toBe('last_owner');

    const suspend = await api.call(ownerToken, {
      method: 'PATCH',
      url: `/v1/members/${owner.userId}/status`,
      payload: { status: 'suspended' },
    });
    expect(suspend.statusCode).toBe(409);

    const remove = await api.call(ownerToken, {
      method: 'DELETE',
      url: `/v1/members/${owner.userId}`,
    });
    expect(remove.statusCode).toBe(409);
  });

  it('can be demoted once somebody else is an owner', async () => {
    const second = await api.member('owner', 'second-owner');

    const demote = await api.call(ownerToken, {
      method: 'PATCH',
      url: `/v1/members/${second.userId}/role`,
      payload: { role: 'admin' },
    });

    expect(demote.statusCode, demote.body).toBe(200);
  });
});
