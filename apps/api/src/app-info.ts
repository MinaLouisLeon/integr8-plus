import { type AppInfo, appInfoSchema, optionalEnv } from '@integr8/core';

/**
 * The product's version, as in the root package.json. Declared here rather
 * than imported because package.json sits outside `rootDir`; app-info.test.ts
 * fails when the two differ, so a release that bumps one has to bump both.
 */
export const VERSION = '1.2.3';

/**
 * Builds this app's identity from the environment. Fails at startup rather
 * than later if APP_ENV holds an unrecognised value.
 */
export function buildAppInfo(env: NodeJS.ProcessEnv = process.env): AppInfo {
  return appInfoSchema.parse({
    id: 'api',
    displayName: 'Integr8 API',
    environment: optionalEnv('APP_ENV', 'development', env),
    version: VERSION,
  });
}
