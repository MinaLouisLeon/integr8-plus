import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBaseUrl, PLATFORM_REFRESH_COOKIE, platformCookieOptions } from '~/lib/platform-api';

/**
 * Ends the dashboard session on the server, then drops the cookie (P15).
 *
 * The cookie goes whether or not the API call succeeded. Somebody who pressed
 * sign out has ended their session as far as they are concerned, and leaving a
 * usable super-admin refresh token in their browser would be the wrong way to
 * disagree.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const everywhere =
    (await request
      .json()
      .then((body: unknown) => (body as { everywhere?: boolean }).everywhere)
      .catch(() => false)) ?? false;

  const store = await cookies();
  const refreshToken = store.get(PLATFORM_REFRESH_COOKIE)?.value;

  if (refreshToken !== undefined) {
    try {
      // One rotation to get an access token to sign out with. The refresh token
      // is spent either way, which is itself most of a sign-out.
      const upstream = await fetch(`${apiBaseUrl()}/v1/platform/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (upstream.ok) {
        const tokens = (await upstream.json()) as { accessToken: string };
        await fetch(`${apiBaseUrl()}/v1/platform/auth/sign-out`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tokens.accessToken}`,
          },
          body: JSON.stringify({ everywhere }),
        });
      }
    } catch {
      // Best effort; the cookie goes either way.
    }
  }

  const response = NextResponse.json({ signedOut: true });
  // By name *and* path: a cookie is removed only when the two match, and
  // this one was set at `/api/platform/auth`. `delete(name)` alone sends
  // `Path=/`, which the browser ignores — leaving a live refresh token
  // in a browser somebody has just signed out of.
  response.cookies.set(PLATFORM_REFRESH_COOKIE, '', platformCookieOptions(0));
  return response;
}
