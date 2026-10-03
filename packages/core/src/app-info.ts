import { z } from 'zod';
import { appEnvironmentSchema } from './environment.js';

/**
 * The four client applications in the workspace.
 *
 * `desktop` and `web` share a React codebase; `mobile` never builds forms.
 */
export const APP_IDS = ['api', 'web', 'desktop', 'mobile'] as const;

export const appIdSchema = z.enum(APP_IDS);
export type AppId = z.infer<typeof appIdSchema>;

export const appInfoSchema = z.object({
  id: appIdSchema,
  displayName: z.string().min(1),
  environment: appEnvironmentSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+$/u, 'version must be semver, e.g. 0.1.0'),
});

export type AppInfo = z.infer<typeof appInfoSchema>;

/** A one-line banner every app prints on boot, so logs identify their source. */
export function describeApp(info: AppInfo): string {
  return `${info.displayName} (${info.id}) v${info.version} [${info.environment}]`;
}
