import * as Sentry from '@sentry/node';
import type { ApiConfig } from '../config.js';

/**
 * Error reporting, behind a small seam.
 *
 * Two reasons it is not called directly. Sentry is optional — a developer's
 * machine has no DSN and should not need one — so every call site would
 * otherwise carry the same `if`. And the release tag matters: an error with no
 * build attached is an error nobody can bisect, so tagging is done once, here,
 * rather than remembered at each report.
 */

let enabled = false;

export function initialiseSentry(config: ApiConfig): void {
  if (config.SENTRY_DSN === undefined || config.SENTRY_DSN === '') {
    return;
  }

  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.APP_ENV,
    // P04's task is "Sentry with release tagging". Without it, "this started
    // failing after some deploy" stays a guess.
    release: config.API_RELEASE,
    tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
    // Request bodies and headers carry tokens and customer data. Reporting an
    // error must not become a way of exporting either.
    sendDefaultPii: false,
  });

  enabled = true;
}

/**
 * Reports an error, tagged with whatever the request knew about itself.
 *
 * `requestId` is the tag that matters: it is the same id on every log line and
 * the one the caller was given, so a Sentry event and a log search meet.
 */
export function captureException(error: unknown, tags: Record<string, string> = {}): void {
  if (!enabled) {
    return;
  }

  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(tags)) {
      scope.setTag(key, value);
    }
    Sentry.captureException(error);
  });
}

/** Waits for queued events on the way out, so a crash still reports. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!enabled) {
    return;
  }
  await Sentry.flush(timeoutMs);
}

/** Whether reporting is on. Surfaced by the readiness endpoint. */
export function sentryEnabled(): boolean {
  return enabled;
}
