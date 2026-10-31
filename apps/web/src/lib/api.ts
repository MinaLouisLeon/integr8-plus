/**
 * Server-side helpers for the route handlers that hold the refresh cookie.
 *
 * These run on the Next server, never in the browser. They are the only code in
 * the web app that sees a refresh token.
 */

export const REFRESH_COOKIE = 'integr8_refresh';

export function apiBaseUrl(): string {
  return (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/u, '');
}

/**
 * How the refresh cookie is set.
 *
 * - `httpOnly` so no script can read it, which is the whole reason it is a
 *   cookie rather than a variable.
 * - `sameSite: 'lax'` so it is not sent on cross-site POSTs, which is most of
 *   CSRF protection for a cookie that is only ever used by same-origin fetches.
 * - `secure` outside development, because a cookie sent over plain HTTP is a
 *   cookie somebody on the same network has.
 * - `path: '/api/auth'` so it is not attached to every request for a stylesheet.
 */
export function refreshCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/api/auth',
    maxAge: maxAgeSeconds,
  };
}

/**
 * Whether a request was posted from another site.
 *
 * `sameSite: 'lax'` stops the refresh cookie being *sent* cross-site. It does
 * not stop a cross-site form from *setting* one: a page elsewhere can post the
 * attacker's own credentials to the sign-in handler, the browser stores the
 * cookie that comes back, and on the next refresh the person is quietly signed
 * in as the attacker — so everything they then enter lands in the attacker's
 * company. Browsers say where a request came from; a sign-in from anywhere but
 * this origin is refused.
 *
 * `Sec-Fetch-Site` is the authoritative answer where it is sent (every current
 * browser). `Origin` against `Host` covers the rest. A request with neither is
 * not from a browser form, which cannot omit both.
 */
export function isCrossSiteRequest(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) {
    return site !== 'same-origin' && site !== 'none';
  }

  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (origin === null || host === null) {
    return false;
  }
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/**
 * Who is really asking, passed on to the API.
 *
 * These handlers call the API from the web server, so without these headers
 * every browser reaches the API from the web container's one address. The API
 * limits sign-in attempts and requests per address, and records the address
 * and browser on each session and audit line: all of that would describe the
 * web server rather than the person, and one busy morning would lock every
 * company out of the web app.
 *
 * Caddy sets `X-Forwarded-For` to the visitor's address and discards any value
 * the visitor sent, so the first entry is the person's even if something
 * appends to it on the way here. The API trusts the header because only Caddy
 * and this server can reach it.
 */
export function forwardedClientHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  const address = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (address !== undefined && address !== '') {
    headers['x-forwarded-for'] = address;
  }
  const agent = request.headers.get('user-agent');
  if (agent !== null && agent !== '') {
    headers['user-agent'] = agent;
  }
  return headers;
}

/** The refusal `isCrossSiteRequest` earns, in the API's error shape. */
export function crossSiteRefusal(): Response {
  return Response.json(
    {
      error: {
        code: 'cross_site_request',
        message: 'Sign in from the app itself.',
      },
    },
    { status: 403 },
  );
}

/** The body as JSON, or `undefined` when it is not one. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function secondsUntil(iso: string): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
}
