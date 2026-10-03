import { z } from 'zod';

/**
 * Branded identifier types.
 *
 * Every identifier in the system is a UUID, but a `TenantId` must never be
 * accepted where a `UserId` is expected. Branding makes that a compile error
 * rather than a runtime incident.
 */

export const tenantIdSchema = z.uuid().brand<'TenantId'>();
export type TenantId = z.infer<typeof tenantIdSchema>;

export const userIdSchema = z.uuid().brand<'UserId'>();
export type UserId = z.infer<typeof userIdSchema>;

export const platformUserIdSchema = z.uuid().brand<'PlatformUserId'>();
export type PlatformUserId = z.infer<typeof platformUserIdSchema>;

/** Parses a value as a `TenantId`, throwing if it is not a valid UUID. */
export function toTenantId(value: string): TenantId {
  return tenantIdSchema.parse(value);
}

/** Parses a value as a `UserId`, throwing if it is not a valid UUID. */
export function toUserId(value: string): UserId {
  return userIdSchema.parse(value);
}

/** Parses a value as a `PlatformUserId`, throwing if it is not a valid UUID. */
export function toPlatformUserId(value: string): PlatformUserId {
  return platformUserIdSchema.parse(value);
}
