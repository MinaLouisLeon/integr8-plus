import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiBaseUrl, REFRESH_COOKIE, refreshCookieOptions } from '~/lib/api';

/**
 * Ends the session on the server, then drops the cookie.
 *
 * The cookie is cleared whether or not the API call succeeded. Somebody who
 * clicked "sign out" has ended their session as far as they are concerned, and
 * leaving a usable refresh token in their browser would be the wrong way to
 * disagree.
 */
export async function POST(): Promise<NextResponse> {
  const store = await cookies();
  const refreshToken = store.get(REFRESH_COOKIE)?.value;

  if (refreshToken !== undefined) {
    try {
      const upstream = await fetch(`${apiBaseUrl()}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (upstream.ok) {
        const tokens = (await upstream.json()) as { accessToken: string };
        await fetch(`${apiBaseUrl()}/v1/auth/sign-out`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tokens.accessToken}`,
          },
          body: JSON.stringify({ everywhere: false }),
        });
      }
    } catch {
      // Best effort; the cookie goes either way.
    }
  }

  const response = NextResponse.json({ signedOut: true });
  // By name *and* path: a cookie is removed only when the two match, and
  // this one was set at `/api/auth`. `delete(name)` alone sends
  // `Path=/`, which the browser ignores — leaving a live refresh token
  // in a browser somebody has just signed out of.
  response.cookies.set(REFRESH_COOKIE, '', refreshCookieOptions(0));
  return response;
}
