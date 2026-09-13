import { withSentryConfig } from '@sentry/nextjs/config';
import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  // The workspace packages ship TypeScript-compiled ESM; Next needs telling
  // which of its dependencies are local source rather than published builds.
  transpilePackages: ['@integr8/api-client', '@integr8/core', '@integr8/i18n', '@integr8/tokens'],

  // The build fails on a type error or a lint error rather than shipping one.
  // Next's defaults already do this; stating it stops a future "just for now"
  // from being invisible.
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: false },

  env: {
    NEXT_PUBLIC_APP_VERSION: process.env.npm_package_version ?? '0.1.0',
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
