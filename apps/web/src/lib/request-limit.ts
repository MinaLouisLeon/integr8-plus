/**
 * Request limits for the public site's desktop update routes.
 *
 * Those routes answer anybody, and two things about them are worth guarding.
 * An answer says whether an app name has a release, so walking a list of
 * likely company names would map the customers; and the file pass-through
 * (`/desktop-updates/<app>/download/…`) spends this server's bandwidth and
 * the GitHub token's hourly allowance on every call. An installed app asks
 * for its own name, gets a manifest, and downloads each update once, so it
 * never meets either limit.
 *
 * Fixed windows kept in this process's memory: the site runs as one server
 * (`deploy/compose.yml`'s `web`), and losing the counts on a restart costs a
 * guesser nothing they could not get by waiting an hour.
 */

/** Lookups that found nothing, per address per hour (the API's brand routes allow the same). */
export const MISS_LIMIT = 20;
/** Downloads of one file through this server, per address per hour. */
export const DOWNLOAD_LIMIT = 5;
export const WINDOW_MS = 60 * 60 * 1000;

interface Window {
  count: number;
  resetsAt: number;
  /** Set once a hit went over the limit: the bucket then refuses everything until it resets. */
  over: boolean;
}

export interface Limiter {
  /** Seconds until the bucket opens again, or null when it is open. */
  blockedFor(key: string, now?: number): number | null;
  /** Counts one; the seconds to wait when that one went over the limit, else null. */
  hit(key: string, limit: number, now?: number): number | null;
}

export function createLimiter(windowMs: number = WINDOW_MS): Limiter {
  const windows = new Map<string, Window>();
  let nextSweep = 0;

  // Expired windows are dropped now and then, so a stream of new addresses
  // cannot grow the map for ever.
  const sweep = (now: number) => {
    if (now < nextSweep) {
      return;
    }
    nextSweep = now + windowMs;
    for (const [key, window] of windows) {
      if (window.resetsAt <= now) {
        windows.delete(key);
      }
    }
  };

  const live = (key: string, now: number): Window | undefined => {
    const window = windows.get(key);
    if (window !== undefined && window.resetsAt <= now) {
      windows.delete(key);
      return undefined;
    }
    return window;
  };

  const wait = (window: Window, now: number) =>
    Math.max(1, Math.ceil((window.resetsAt - now) / 1000));

  return {
    blockedFor(key, now = Date.now()) {
      sweep(now);
      const window = live(key, now);
      return window?.over === true ? wait(window, now) : null;
    },

    hit(key, limit, now = Date.now()) {
      sweep(now);
      const window = live(key, now) ?? { count: 0, resetsAt: now + windowMs, over: false };
      window.count += 1;
      if (window.count > limit) {
        window.over = true;
      }
      windows.set(key, window);
      return window.over ? wait(window, now) : null;
    },
  };
}

/**
 * The visitor's address, as Caddy passes it on (`X-Forwarded-For`, which it
 * sets itself rather than trusting the visitor's), or null with no proxy in
 * front, as in development. Only Caddy can reach this server: compose
 * publishes its port on 127.0.0.1 alone.
 */
export function visitorAddress(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim() ?? '';
  return first === '' ? null : first;
}

/** The answer when a bucket is closed. */
export function tooManyRequests(retryAfterSeconds: number): Response {
  return Response.json(
    { error: { code: 'rate_limited' } },
    {
      status: 429,
      headers: { 'retry-after': String(retryAfterSeconds), 'cache-control': 'no-store' },
    },
  );
}

/**
 * The site's one limiter, shared by the update routes. Kept on `globalThis`
 * because Next may load this module once per route, and two routes counting
 * apart would double what a guesser gets.
 */
const holder = globalThis as typeof globalThis & { integr8UpdateRouteLimiter?: Limiter };
export const updateRouteLimiter: Limiter = (holder.integr8UpdateRouteLimiter ??= createLimiter());
