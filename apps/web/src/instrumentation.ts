import * as Sentry from '@sentry/nextjs';

/**
 * Server and edge error reporting.
 *
 * `release` is what makes an error bisectable. Without it, "this started after
 * some deploy" stays a guess — which is exactly what P05's exit criterion about
 * app-version tagging is guarding against.
 */
export function register(): void {
  const dsn = process.env.SENTRY_DSN;
  if (dsn === undefined || dsn === '') {
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.APP_ENV ?? 'development',
    release: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.1.0',
    tracesSampleRate: 0.1,
    // Request bodies and headers carry tokens and customer data. Reporting an
    // error must not become a way of exporting either.
    sendDefaultPii: false,
  });
}

export const onRequestError = Sentry.captureRequestError;
