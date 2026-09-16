import { NextResponse } from 'next/server';
import {
  apiBaseUrl,
  PLATFORM_REFRESH_COOKIE,
  platformCookieOptions,
  secondsUntil,
} from '~/lib/platform-api';

/**
 * Signs a super admin in to the dashboard (P15).
 *
 * The same split as the customer sign-in — refresh token into an httpOnly
 * cookie, access token back in the body and kept in memory — and a separate
 * cookie, because these two sessions must never be interchangeable.
 *
 * The six-digit code is passed straight through. Nothing here decides whether
 * it is right: the API checks both factors together, and always both, so how
 * long the answer takes says nothing about which half was wrong.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const credentials = (await request.json()) as {
    email: string;
    password: string;
    code: string;
  };

  const upstream = await fetch(`${apiBaseUrl()}/v1/platform/auth/sign-in`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-client-app': 'web',
      'x-client-version': process.env.NEXT_PUBLIC_APP_VERSION ?? '0.1.0',
    },
    body: JSON.stringify(credentials),
  });

  const body: unknown = await upstream.json();

  if (!upstream.ok) {
    return NextResponse.json(body, { status: upstream.status });
  }

  const result = body as {
    tokens: {
      accessToken: string;
      accessTokenExpiresAt: string;
      refreshToken: string;
      refreshTokenExpiresAt: string;
    };
    platformUser: { id: string; email: string; displayName: string };
  };

  const response = NextResponse.json({
    accessToken: result.tokens.accessToken,
    accessTokenExpiresAt: result.tokens.accessTokenExpiresAt,
    platformUser: result.platformUser,
  });

  response.cookies.set(
    PLATFORM_REFRESH_COOKIE,
    result.tokens.refreshToken,
    platformCookieOptions(secondsUntil(result.tokens.refreshTokenExpiresAt)),
  );

  return response;
}
