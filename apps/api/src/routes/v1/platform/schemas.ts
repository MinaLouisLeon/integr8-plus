import {
  ANNOUNCEMENT_SEVERITIES,
  BILLING_INTERVALS,
  SUBSCRIPTION_STATUSES,
  TENANT_EXPORT_STATUSES,
  TENANT_PLANS,
  TENANT_STATUSES,
} from '@integr8/db';
import { z } from 'zod';

/**
 * The dashboard's response shapes (P15).
 *
 * Kept apart from the customer-facing schemas next door for the same reason the
 * token type is separate: nothing here is part of the contract three shipped
 * apps depend on. These serve one first-party dashboard, so they can change
 * with it — and keeping them in their own file makes that boundary visible
 * rather than a matter of remembering which of forty schemas is which.
 */

const timestamp = z.iso.datetime();

export const platformTokensSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: timestamp,
  /** Opaque, single-use, rotated. Belongs in an httpOnly cookie and nowhere else. */
  refreshToken: z.string(),
  refreshTokenExpiresAt: timestamp,
  sessionId: z.uuid(),
});

export const platformUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
});

export const platformSignInResponseSchema = z.object({
  tokens: platformTokensSchema,
  platformUser: platformUserSchema,
});

export const planSchema = z.enum(TENANT_PLANS);
export const statusSchema = z.enum(TENANT_STATUSES);

/** One row of the company directory. */
export const companySummarySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  status: statusSchema,
  plan: planSchema,
  /** How many seats the plan allows; null means uncapped. */
  seats: z.number().int().nullable(),
  members: z.number().int(),
  activeMembers: z.number().int(),
  storageBytes: z.number().int(),
  createdAt: timestamp,
  /** The most recent thing anybody in this company did, or null if nobody has. */
  lastActivityAt: timestamp.nullable(),
  suspendedAt: timestamp.nullable(),
  suspendedReason: z.string().nullable(),
  /** Set when a deletion is scheduled; the company is purged after this. */
  deletionScheduledFor: timestamp.nullable(),
});

export const companyActivitySchema = z.object({
  /** `YYYY-MM`. */
  month: z.string(),
  jobs: z.number().int(),
  submissions: z.number().int(),
  activeUsers: z.number().int(),
  /**
   * Everything recorded in this company's audit log.
   *
   * Not "API calls", which is what the plan asked for: there is no
   * request-level counter in this system and no honest way to derive one. What
   * the audit log holds is every action worth recording, which is the question
   * people actually mean when they ask how busy a customer is.
   */
  auditedActions: z.number().int(),
});

/**
 * What a company is paying, as the platform sees it (P17).
 *
 * Null when a company has no subscription row at all — companies onboarded
 * before P17, which are on a plan somebody set by hand and are charged by
 * nobody. Saying null is the honest answer; inventing a trial would hide them.
 */
export const companyBillingSchema = z.object({
  provider: z.string(),
  status: z.enum(SUBSCRIPTION_STATUSES),
  plan: planSchema,
  interval: z.enum(BILLING_INTERVALS).nullable(),
  currentPeriodEnd: timestamp.nullable(),
  cancelAtPeriodEnd: z.boolean(),
  trialEndsAt: timestamp.nullable(),
  pastDueSince: timestamp.nullable(),
  graceEndsAt: timestamp.nullable(),
  remindersSent: z.number().int(),
  /** Whether writes are refused right now, and the words the customer is shown. */
  readOnlySince: timestamp.nullable(),
  readOnlyReason: z.string().nullable(),
  /** The provider's own ids, for looking the customer up in their dashboard. */
  providerCustomerId: z.string().nullable(),
  providerSubscriptionId: z.string().nullable(),
});

export const companyDetailSchema = companySummarySchema.extend({
  activity: z.array(companyActivitySchema),
  billing: companyBillingSchema.nullable(),
  featureFlags: z.record(z.string(), z.boolean()),
  members: z.number().int(),
  owners: z.array(
    z.object({ userId: z.uuid(), email: z.string(), role: z.string(), status: z.string() }),
  ),
});

export const onboardResponseSchema = z.object({
  company: companySummarySchema,
  /** What the owner was sent, so the dashboard can show it or resend it. */
  ownerInvitation: z.object({
    id: z.uuid(),
    email: z.string(),
    expiresAt: timestamp,
    /** Present only when the API is configured to return it; never logged. */
    acceptUrl: z.string().nullable(),
  }),
  /** The bucket that now exists in Cloudflare, so the exit criterion is checkable. */
  storage: z.object({ bucket: z.string(), created: z.boolean() }),
});

export const platformAuditEntrySchema = z.object({
  id: z.uuid(),
  occurredAt: timestamp,
  platformUserId: z.uuid().nullable(),
  actorLabel: z.string(),
  action: z.string(),
  tenantId: z.uuid().nullable(),
  tenantSlug: z.string().nullable(),
  targetKind: z.string().nullable(),
  targetId: z.string().nullable(),
  reason: z.string().nullable(),
  requestId: z.string().nullable(),
  ipAddress: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

export const platformAuditPageSchema = z.object({
  entries: z.array(platformAuditEntrySchema),
  /** Pass back as `before` to read the next page. Absent on the last one. */
  next: z.object({ occurredAt: timestamp, id: z.uuid() }).nullable(),
});

export const featureFlagSchema = z.object({
  key: z.string(),
  description: z.string(),
  /** What a company gets when it has no override of its own. */
  defaultEnabled: z.boolean(),
});

export const tenantFlagSchema = z.object({
  tenantId: z.uuid(),
  key: z.string(),
  enabled: z.boolean(),
});

export const announcementSchema = z.object({
  id: z.uuid(),
  /** Null means every company. */
  tenantId: z.uuid().nullable(),
  severity: z.enum(ANNOUNCEMENT_SEVERITIES),
  /** The text by language tag, so one banner serves every locale the apps run in. */
  message: z.record(z.string(), z.string()),
  startsAt: timestamp,
  endsAt: timestamp.nullable(),
  /** Whether somebody can close it, or has to live with it until it ends. */
  dismissible: z.boolean(),
  createdAt: timestamp,
});

export const exportSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  tenantSlug: z.string(),
  status: z.enum(TENANT_EXPORT_STATUSES),
  createdAt: timestamp,
  completedAt: timestamp.nullable(),
  /** Where the archive landed, once it is ready. */
  objectKey: z.string().nullable(),
  byteSize: z.number().int().nullable(),
  /** How many rows of each kind it holds, so somebody can sanity-check it. */
  contents: z.record(z.string(), z.number().int()),
  expiresAt: timestamp.nullable(),
  error: z.string().nullable(),
});

export const deletionSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  tenantSlug: z.string(),
  /** Nothing is removed before this moment, and cancelling until then undoes it. */
  purgeAfter: timestamp,
  createdAt: timestamp,
  reason: z.string(),
  /** The export that had to finish before this could be scheduled. */
  exportId: z.uuid(),
  cancelledAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
});

export const impersonationSchema = z.object({
  grantId: z.uuid(),
  tenantId: z.uuid(),
  /** Null when acting as the company rather than as one of its members. */
  targetUserId: z.uuid().nullable(),
  actsAs: z.enum(['user', 'company']),
  reason: z.string(),
  expiresAt: timestamp,
  tokens: z.object({
    accessToken: z.string(),
    accessTokenExpiresAt: timestamp,
    refreshToken: z.string(),
    refreshTokenExpiresAt: timestamp,
    sessionId: z.uuid(),
  }),
});

export const releaseSchema = z.object({
  clientApp: z.enum(['web', 'desktop', 'mobile']),
  version: z.string(),
  devices: z.number().int(),
  lastSeenAt: timestamp,
});

export const platformListSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item) });
