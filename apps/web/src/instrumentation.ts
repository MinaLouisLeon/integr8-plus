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
    // error must not become a way of exporting either. Sentry 11 replaced
    // `sendDefaultPii: false` with these per-category switches, and collects
    // every one of them unless told not to.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
    },
  });
}

export const onRequestError = Sentry.captureRequestError;
