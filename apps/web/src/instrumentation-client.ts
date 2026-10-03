import * as Sentry from '@sentry/nextjs';

/**
 * Browser error reporting.
 *
 * Tagged with the app version, so a report can be tied to the build that
 * produced it — the property P05's fourth exit criterion asks for.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn !== undefined && dsn !== '') {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_APP_ENV ?? 'development',
    release: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.1.0',
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
