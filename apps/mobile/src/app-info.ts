import { type AppInfo, appInfoSchema, optionalEnv } from '@integr8/core';

/**
 * Kept in step with package.json by the release process (P20). It is declared
 * here rather than imported because package.json sits outside `rootDir`.
 */
const VERSION = '0.1.0';

/**
 * Builds this app's identity from the environment. Fails at startup rather
 * than later if APP_ENV holds an unrecognised value.
 */
export function buildAppInfo(env: NodeJS.ProcessEnv = process.env): AppInfo {
  return appInfoSchema.parse({
    id: 'mobile',
    displayName: 'Integr8 Mobile',
    environment: optionalEnv('APP_ENV', 'development', env),
    version: VERSION,
  });
}
