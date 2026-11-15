import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The staff app's platform session (P42): held in memory only (D2), refreshed
 * with a rotated token, and kept alive while staff work inside a company so
 * Back to the dashboard needs no second sign-in.
 */

interface Call {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
}

const LATER = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function platformTokens(access: string, refresh: string, expiresAt = LATER()) {
  return {
    accessToken: access,
    accessTokenExpiresAt: expiresAt,
    refreshToken: refresh,
    refreshTokenExpiresAt: LATER(),
    sessionId: '00000000-0000-4000-8000-000000000001',
    sessionExpiresAt: LATER(),
  };
}

let calls: Call[];
let answer: (call: Call) => Response;

beforeEach(() => {
  vi.resetModules();
  calls = [];
  vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = await request.text();
    const call: Call = {
      method: request.method,
      path: new URL(request.url).pathname,
      body: text === '' ? null : (JSON.parse(text) as unknown),
      authorization: request.headers.get('authorization'),
    };
    calls.push(call);
    return answer(call);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const USER = { id: 'p-1', email: 'sara@integr8.example', displayName: 'Sara' };

describe('signing in', () => {
  it('keeps the platform session in memory and leaves the company session alone', async () => {
    answer = () => json({ tokens: platformTokens('a1', 'r1'), platformUser: USER });
    const staff = await import('./session');
    const { session } = await import('~/lib/session');

    expect(staff.hasPlatformSession()).toBe(false);
    await staff.staffSignIn({ email: USER.email, password: 'x', code: '123456' });
    expect(staff.hasPlatformSession()).toBe(true);
    expect(staff.staffUser()).toEqual(USER);
    // Nothing reaches the company session, which is the one kept on the device.
    expect(await session().isSignedIn()).toBe(false);

    staff.forgetPlatformSession();
    expect(staff.hasPlatformSession()).toBe(false);
  });
});

describe('refreshing', () => {
  it('trades the refresh token for a new pair, and uses the new access token', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    answer = (call) => {
      if (call.path === '/v1/platform/auth/sign-in') {
        return json({ tokens: platformTokens('a1', 'r1', past), platformUser: USER });
      }
      if (call.path === '/v1/platform/auth/refresh') {
        return json(platformTokens('a2', 'r2'));
      }
      return json({ items: [] });
    };
    const staff = await import('./session');
    await staff.staffSignIn({ email: USER.email, password: 'x', code: '123456' });

    await staff.platformClient().GET('/v1/platform/flags');

    const refresh = calls.find((call) => call.path === '/v1/platform/auth/refresh');
    expect(refresh?.body).toEqual({ refreshToken: 'r1' });
    expect(calls.at(-1)).toMatchObject({ path: '/v1/platform/flags', authorization: 'Bearer a2' });
  });

  it('ends the session when the refresh is refused', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    answer = (call) =>
      call.path === '/v1/platform/auth/sign-in'
        ? json({ tokens: platformTokens('a1', 'r1', past), platformUser: USER })
        : json({ error: { code: 'unauthorised', message: 'no', requestId: 'r' } }, 401);
    const staff = await import('./session');
    await staff.staffSignIn({ email: USER.email, password: 'x', code: '123456' });

    await expect(staff.platformClient().GET('/v1/platform/flags')).rejects.toThrow();
    expect(staff.hasPlatformSession()).toBe(false);
  });
});

describe('working inside a company', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const GRANT = '22222222-2222-4222-8222-222222222222';
  const PERSON = '33333333-3333-4333-8333-333333333333';

  function companyAnswers(call: Call): Response {
    if (call.path === '/v1/platform/auth/sign-in') {
      return json({ tokens: platformTokens('a1', 'r1'), platformUser: USER });
    }
    if (call.path.endsWith('/impersonate')) {
      return json(
        {
          grantId: GRANT,
          tenantId: TENANT,
          targetUserId: null,
          actsAs: 'company',
          reason: 'Building their forms',
          expiresAt: LATER(),
          tokens: {
            accessToken: 'company-access',
            accessTokenExpiresAt: LATER(),
            refreshToken: 'company-refresh',
            refreshTokenExpiresAt: LATER(),
          },
        },
        201,
      );
    }
    return json({}, 204);
  }

  it('acts as the company by default and as a person when named (D3)', async () => {
    answer = companyAnswers;
    const staff = await import('./session');
    await staff.staffSignIn({ email: USER.email, password: 'x', code: '123456' });

    await staff.openCompany({ tenantId: TENANT, reason: 'Building their forms' });
    await staff.openCompany({
      tenantId: TENANT,
      reason: 'Support call 4411',
      targetUserId: PERSON,
    });

    const opened = calls.filter((call) => call.path.endsWith('/impersonate'));
    expect(opened[0]?.body).toEqual({ reason: 'Building their forms' });
    expect(opened[1]?.body).toEqual({ reason: 'Support call 4411', targetUserId: PERSON });
  });

  it('leads back to the company’s page, ending the grant and keeping the staff session', async () => {
    answer = companyAnswers;
    const staff = await import('./session');
    const { session } = await import('~/lib/session');
    const { afterCompanySignOut, staffBridge } = await import('~/lib/staff-bridge');
    await staff.staffSignIn({ email: USER.email, password: 'x', code: '123456' });
    await staff.openCompany({ tenantId: TENANT, reason: 'Building their forms' });

    expect(await session().isSignedIn()).toBe(true);
    expect(staffBridge()?.insideCompany()).toBe(true);

    const to = await staffBridge()!.leaveCompany();

    expect(to).toBe(`/platform/companies/${TENANT}`);
    expect(calls.some((call) => call.path.endsWith(`/impersonate/${GRANT}/end`))).toBe(true);
    expect(await session().isSignedIn()).toBe(false);
    expect(staff.hasPlatformSession()).toBe(true);
    expect(afterCompanySignOut()).toBe('/platform');
  });
});
