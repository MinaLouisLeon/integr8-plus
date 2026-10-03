import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import {
  apiBaseUrl,
  PLATFORM_REFRESH_COOKIE,
  platformCookieOptions,
  secondsUntil,
} from '~/lib/platform-api';

/**
 * Exchanges the dashboard's refresh cookie for a new access token (P15).
 *
 * Rotated on every refresh, and the cookie replaced with the new one. Failing
 * to replace it would send a spent token next time, which the API treats as
 * theft — correctly — and which would end the session.
 *
 * A platform access token lasts five minutes, so this runs often. That is the
 * price of a token that can reach every company being short-lived.
 */
export async function POST(): Promise<NextResponse> {
  const store = await cookies();
  const refreshToken = store.get(PLATFORM_REFRESH_COOKIE)?.value;

  if (refreshToken === undefined) {
    return NextResponse.json({ error: { code: 'no_session' } }, { status: 401 });
  }

  const upstream = await fetch(`${apiBaseUrl()}/v1/platform/auth/refresh`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-client-app': 'web',
      'x-client-version': process.env.NEXT_PUBLIC_APP_VERSION ?? '0.1.0',
    },
    body: JSON.stringify({ refreshToken }),
  });

  if (!upstream.ok) {
    // Revoked, reused, expired, or the account was disabled. None is retriable.
    const failed = NextResponse.json(await upstream.json(), { status: upstream.status });
    // By name and path; see the sign-out route for why `delete` is not enough.
    failed.cookies.set(PLATFORM_REFRESH_COOKIE, '', platformCookieOptions(0));
    return failed;
  }

  const tokens = (await upstream.json()) as {
    accessToken: string;
    accessTokenExpiresAt: string;
    refreshToken: string;
    refreshTokenExpiresAt: string;
  };

  const response = NextResponse.json({
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
  });

  response.cookies.set(
    PLATFORM_REFRESH_COOKIE,
    tokens.refreshToken,
    platformCookieOptions(secondsUntil(tokens.refreshTokenExpiresAt)),
  );

  return response;
}
