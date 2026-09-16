/**
 * Server-side helpers for the dashboard's own route handlers (P15).
 *
 * A deliberate near-copy of `api.ts` rather than a shared helper with a
 * parameter. The two sessions must not be able to become one by accident: a
 * different cookie, a different path, a different upstream, and no shared
 * mutable anything. When the customer session and the super-admin session are
 * told apart by an argument, the mistake that merges them is one careless
 * default away.
 */

export const PLATFORM_REFRESH_COOKIE = 'integr8_platform';

export function apiBaseUrl(): string {
  return (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/u, '');
}

/**
 * How the dashboard's refresh cookie is set.
 *
 * Same reasoning as the customer one, with `sameSite: 'strict'` rather than
 * `lax`: nothing should ever navigate into the dashboard from another site, so
 * the looser setting buys nothing here and costs a little CSRF surface.
 *
 * The path is `/api/platform/auth`, so this cookie is not attached to a single
 * customer-facing request — including the ones a super admin makes while
 * impersonating somebody.
 */
export function platformCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/api/platform/auth',
    maxAge: maxAgeSeconds,
  };
}

export function secondsUntil(iso: string): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
}
