import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBaseUrl, REFRESH_COOKIE, refreshCookieOptions, secondsUntil } from '~/lib/api';

/**
 * Exchanges the refresh cookie for a new access token.
 *
 * Rotation happens here too: the API returns a new refresh token on every
 * refresh, and the cookie is replaced with it. Failing to replace it would send
 * a spent token next time, which the API treats as theft and which would sign
 * the person out of every device.
 */
export async function POST(): Promise<NextResponse> {
  const store = await cookies();
  const refreshToken = store.get(REFRESH_COOKIE)?.value;

  if (refreshToken === undefined) {
    return NextResponse.json({ error: { code: 'no_session' } }, { status: 401 });
  }

  const upstream = await fetch(`${apiBaseUrl()}/v1/auth/refresh`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-client-app': 'web',
      'x-client-version': process.env.NEXT_PUBLIC_APP_VERSION ?? '0.1.0',
    },
    body: JSON.stringify({ refreshToken }),
  });

  if (!upstream.ok) {
    // Revoked, reused, or expired. None is retriable, so the cookie goes.
    const failed = NextResponse.json(await upstream.json(), { status: upstream.status });
    failed.cookies.delete(REFRESH_COOKIE);
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
    REFRESH_COOKIE,
    tokens.refreshToken,
    refreshCookieOptions(secondsUntil(tokens.refreshTokenExpiresAt)),
  );

  return response;
}
