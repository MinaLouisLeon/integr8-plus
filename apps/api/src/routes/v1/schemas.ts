import { PERMISSIONS, ROLES } from '@integr8/core';
import { z } from 'zod';

/**
 * The response shapes, which are the contract.
 *
 * Every one is declared here rather than beside its handler, because these are
 * what the generated clients become. A field added here appears in three apps;
 * a field removed breaks a signed binary somebody is still running. Keeping
 * them together makes that consequence visible when the change is made.
 *
 * Timestamps are ISO 8601 strings, not numbers. JSON has no date type, and a
 * number leaves every client guessing about seconds versus milliseconds and
 * about the timezone — a mistake that shows up as work logged an hour out
 * twice a year.
 */

const timestamp = z.iso.datetime();

export const roleSchema = z.enum(ROLES);
export const permissionSchema = z.enum(PERMISSIONS);

export const clientAppSchema = z.enum(['web', 'desktop', 'mobile', 'api']);

export const tokensSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: timestamp,
  /**
   * Opaque and single-use. Store it where a script cannot read it — the OS
   * keychain, SecureStore, or an httpOnly cookie — never in `localStorage`.
   */
  refreshToken: z.string(),
  refreshTokenExpiresAt: timestamp,
  sessionId: z.uuid(),
});

export const membershipSchema = z.object({
  tenantId: z.uuid(),
  role: roleSchema,
  status: z.enum(['invited', 'active', 'suspended']),
});

export const signInResponseSchema = z.object({
  tokens: tokensSchema,
  tenantId: z.uuid(),
  userId: z.uuid(),
  /**
   * Every company this person belongs to.
   *
   * Returned even when there is one, so a client can render a switcher without
   * a second call — and so signing in never has to become a two-step flow with
   * a token in between whose only job is to say "password accepted, company not
   * yet chosen".
   */
  memberships: z.array(membershipSchema),
});

export const meSchema = z.object({
  userId: z.uuid(),
  tenantId: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
  /**
   * What this role may do, resolved server-side.
   *
   * Sent so a client can hide a button it would be refused for, rather than
   * reimplementing the matrix and drifting from it. It is not a security
   * control: every request is checked again on arrival.
   */
  permissions: z.array(permissionSchema),
  impersonatedBy: z
    .object({ platformUserId: z.uuid(), grantId: z.uuid() })
    .optional()
    .describe('Present only while a super admin is acting as this user.'),
});

export const sessionSchema = z.object({
  id: z.uuid(),
  clientApp: clientAppSchema,
  deviceLabel: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: timestamp,
  lastSeenAt: timestamp,
  expiresAt: timestamp,
  revokedAt: timestamp.nullable(),
  revokedReason: z.string().nullable(),
  isCurrent: z.boolean(),
});

export const memberSchema = z.object({
  userId: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
  status: z.enum(['invited', 'active', 'suspended']),
  createdAt: timestamp,
});

export const invitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: roleSchema,
  createdAt: timestamp,
  expiresAt: timestamp,
});

export const acceptedSchema = z.object({ accepted: z.boolean() });
export const revokedSchema = z.object({ revoked: z.boolean() });

export const listSchema = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });

/** `Date` to the ISO string the contract promises. */
export const iso = (date: Date): string => date.toISOString();

/** The same, for a field that may be absent. */
export const isoOrNull = (date: Date | null): string | null =>
  date === null ? null : date.toISOString();
