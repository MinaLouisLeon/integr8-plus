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

export function secondsUntil(iso: string): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
}
