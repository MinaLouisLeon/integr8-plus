import { NextResponse } from 'next/server';
import {
  apiBaseUrl,
  crossSiteRefusal,
  isCrossSiteRequest,
  readJson,
  REFRESH_COOKIE,
  refreshCookieOptions,
  secondsUntil,
} from '~/lib/api';

/**
 * Signs in, and keeps the refresh token on the server.
 *
 * The browser posts credentials here rather than to the API directly, so that
 * the refresh token can be put straight into an httpOnly cookie and never
 * reach JavaScript. The access token goes back in the body and lives in memory
 * for the life of the tab.
 *
 * Either a password or an emailed 6-digit code (P36): `{ email, password }`
 * goes to `/v1/auth/sign-in`, `{ email, code }` to
 * `/v1/auth/magic-link/complete`. Both end in the same cookie.
 */
export async function POST(request: Request): Promise<Response> {
  // A sign-in posted from another site would set this cookie for a session
  // the attacker chose; see `isCrossSiteRequest`.
  if (isCrossSiteRequest(request)) {
    return crossSiteRefusal();
  }

  const credentials = (await readJson(request)) as
    { email?: unknown; password?: unknown; code?: unknown } | undefined;
  if (credentials === undefined || typeof credentials.email !== 'string') {
    return NextResponse.json(
      { error: { code: 'invalid_body', message: 'The request body could not be read as JSON.' } },
      { status: 400 },
    );
  }

  // Only the fields each endpoint takes are passed on, so nothing else in the
  // browser's body reaches the API.
  const withCode = typeof credentials.code === 'string';
  const upstream = await fetch(
    `${apiBaseUrl()}${withCode ? '/v1/auth/magic-link/complete' : '/v1/auth/sign-in'}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-client-app': 'web',
        'x-client-version': process.env.NEXT_PUBLIC_APP_VERSION ?? '1.1.0',
      },
      body: JSON.stringify(
        withCode
          ? { email: credentials.email, token: credentials.code, clientApp: 'web' }
          : { email: credentials.email, password: credentials.password, clientApp: 'web' },
      ),
    },
  );

  const body: unknown = await upstream.json();

  if (!upstream.ok) {
    // The API's error model is passed through unchanged: one shape everywhere,
    // including the request id the person may need to quote.
    return NextResponse.json(body, { status: upstream.status });
  }

  const result = body as {
    tokens: {
      accessToken: string;
      accessTokenExpiresAt: string;
      refreshToken: string;
      refreshTokenExpiresAt: string;
    };
    tenantId: string;
    userId: string;
    memberships: unknown[];
  };

  const response = NextResponse.json({
    accessToken: result.tokens.accessToken,
    accessTokenExpiresAt: result.tokens.accessTokenExpiresAt,
    tenantId: result.tenantId,
    userId: result.userId,
    memberships: result.memberships,
  });

  response.cookies.set(
    REFRESH_COOKIE,
    result.tokens.refreshToken,
    refreshCookieOptions(secondsUntil(result.tokens.refreshTokenExpiresAt)),
  );

  return response;
}
