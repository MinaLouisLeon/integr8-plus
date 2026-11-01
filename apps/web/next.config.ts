import { withSentryConfig } from '@sentry/nextjs/config';
import type { NextConfig } from 'next';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { securityHeaders } from './src/lib/content-security-policy';

/** The product's version: the root package.json, the one number a release bumps. */
function productVersion(): string {
  const root = JSON.parse(
    readFileSync(path.join(import.meta.dirname, '../../package.json'), 'utf8'),
  ) as { version?: unknown };
  return typeof root.version === 'string' ? root.version : '0.0.0';
}

/**
 * Browser defences, and a content-security policy naming what the pages load
 * (src/lib/content-security-policy.ts). Computed here, at build time, because
 * the API's address and the Sentry DSN are build arguments of the image.
 */
const SECURITY_HEADERS = securityHeaders({
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000',
  sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_APP_ENV,
  release: process.env.NEXT_PUBLIC_APP_VERSION || productVersion(),
  development: process.env.NODE_ENV === 'development',
});

const config: NextConfig = {
  reactStrictMode: true,

  // A self-contained server in `.next/standalone`, which is what the Docker
  // image copies: the traced files only, not the workspace's node_modules.
  // The tracing root is the repository, because the workspace packages this
  // app imports live two directories up.
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),

  headers: () => Promise.resolve([{ source: '/:path*', headers: SECURITY_HEADERS }]),

  // The workspace packages ship TypeScript-compiled ESM; Next needs telling
  // which of its dependencies are local source rather than published builds.
  transpilePackages: [
    '@integr8/api-client',
    '@integr8/core',
    '@integr8/form-engine',
    '@integr8/form-renderer-dom',
    '@integr8/i18n',
    '@integr8/tokens',
  ],

  // The build fails on a type error or a lint error rather than shipping one.
  // Next's defaults already do this; stating it stops a future "just for now"
  // from being invisible.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },

  // The build argument when there is one (the image is built per release),
  // otherwise the root package.json: the one number a release bumps. This used
  // to read apps/web's own package.json, which still said 1.1.0.
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION || productVersion(),
  },
};

export default withSentryConfig(config, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // Uploading source maps is what makes a stack trace readable. Without them a
  // production error reports a line number in a minified bundle, which is
  // barely a report at all.
  silent: process.env.CI !== 'true',
  widenClientFileUpload: true,
  // Only attempt an upload when there is somewhere to upload to.
  ...(process.env.SENTRY_AUTH_TOKEN === undefined ? { sourcemaps: { disable: true } } : {}),
});
