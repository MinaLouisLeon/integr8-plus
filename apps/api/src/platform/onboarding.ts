import { type PlatformUserId, type Role, toTenantId, toUserId } from '@integr8/core';
import { mintInvitationToken } from '@integr8/auth';
import { getPlatformDataSource, type Tenant, type TenantPlan, withTenant } from '@integr8/db';
import type { MediaStorage } from '../media/storage.js';
import { provisionTenantStorage } from '../media/tenant-storage.js';

/**
 * Onboarding a company, in one action (P15).
 *
 * The plan is blunt about why this exists: "Any manual step becomes the
 * bottleneck the moment you have ten customers." So everything a company needs
 * to be usable happens here, and the exit criterion — no manual database or
 * Cloudflare step — is a test rather than a hope.
 *
 * What that means concretely:
 *
 * - **the company row**, with its plan and seat count;
 * - **roles** — nothing to do. Roles are a fixed set in `@integr8/core`, not
 *   rows, so there is no per-company seeding to get wrong;
 * - **job types**, because a company with none cannot raise a job, and an empty
 *   list is the first thing that makes a new customer think the product is
 *   broken;
 * - **the owner's invitation**, which is the only way in: we never create a
 *   password for somebody else;
 * - **the R2 bucket**, so their first upload does not fail.
 *
 * The first four are one transaction. The bucket is not — it is a call to
 * Cloudflare, which cannot join a database transaction — so it happens last and
 * a failure there leaves a company that is complete except for storage. That is
 * recoverable and already handled: the media maintenance sweep provisions any
 * company whose bucket is missing, and this function reports what happened
 * rather than pretending.
 */

export interface OnboardCompanyInput {
  slug: string;
  name: string;
  plan: TenantPlan;
  seats: number | null;
  ownerEmail: string;
  /** Overrides {@link DEFAULT_JOB_TYPES}; an empty array seeds none. */
  jobTypes?: readonly { name: string; code: string }[];
  onboardedBy: PlatformUserId;
  invitationTtlSeconds: number;
  media: MediaStorage;
  /**
   * How long the trial runs, in days, and who will take the money (P17).
   *
   * Every company gets a subscription row on its first day, trialing, with the
   * end date written down. A trial that is inferred from the absence of a row
   * is a trial nobody can extend, shorten or explain to a customer.
   */
  billing: { provider: string; trialDays: number };
}

export interface OnboardedCompany {
  tenant: Tenant;
  /** When the trial this company starts on runs out. */
  trialEndsAt: Date;
  invitation: { id: string; email: string; expiresAt: Date; token: string };
  jobTypes: number;
  storage: { bucket: string | null; created: boolean; error: string | null };
}

/**
 * The job types a new company starts with.
 *
 * Generic on purpose: these are a starting point a dispatcher renames on day
 * one, not an opinion about anybody's business. The point is that the list is
 * not empty.
 */
export const DEFAULT_JOB_TYPES: readonly { name: string; code: string }[] = [
  { name: 'Installation', code: 'INSTALL' },
  { name: 'Planned maintenance', code: 'PPM' },
  { name: 'Repair', code: 'REPAIR' },
  { name: 'Inspection', code: 'INSPECT' },
  { name: 'Callout', code: 'CALLOUT' },
];

const OWNER_ROLE: Role = 'owner';

export async function onboardCompany(input: OnboardCompanyInput): Promise<OnboardedCompany> {
  const platform = getPlatformDataSource();

  const tenant = await platform.tenants.create({
    slug: input.slug,
    name: input.name,
    plan: input.plan,
    seats: input.seats,
    onboardedBy: input.onboardedBy,
  });

  const tenantId = toTenantId(tenant.id);
  const secret = mintInvitationToken(tenantId);
  const expiresAt = new Date(Date.now() + input.invitationTtlSeconds * 1000);
  const seeds = input.jobTypes ?? DEFAULT_JOB_TYPES;

  /**
   * Everything inside the company, in one transaction.
   *
   * The company row itself cannot join it — `withTenant` opens a connection
   * scoped to a company that has to exist first — so a failure in here would
   * otherwise leave a company with no owner and no job types, which no route
   * can then remove: deleting one needs a finished export and a week. So the
   * row is taken back out by hand, and `on delete restrict` everywhere else is
   * the safety net if anything did manage to attach to it.
   */
  let invitation;
  try {
    invitation = await withTenant(tenantId, async (tx) => {
      for (const seed of seeds) {
        // `created_by` is the super admin who onboarded them. It carries no
        // foreign key, and attributing these to a customer's user would be a
        // small lie in a table people read to work out who changed what.
        await tx.jobTypes.create(seed, toUserId(input.onboardedBy));
      }

      const created = await tx.invitations.create({
        email: input.ownerEmail,
        role: OWNER_ROLE,
        invitedByUserId: toUserId(input.onboardedBy),
        tokenHash: secret.hash,
        expiresAt,
      });

      await tx.auditLog.append({
        actorKind: 'platform_user',
        actorId: input.onboardedBy,
        actorLabel: 'Platform onboarding',
        action: 'tenant.onboarded',
        resourceType: 'tenant',
        resourceId: tenant.id,
        metadata: { plan: input.plan, seats: input.seats, ownerEmail: input.ownerEmail },
      });

      return created;
    });
  } catch (error) {
    await platform.tenants.deleteEmpty(tenant.id);
    throw error;
  }

  // After the transaction, because a failure in there takes the company row
  // back out and a subscription pointing at a deleted company would block it.
  const trialEndsAt = new Date(Date.now() + input.billing.trialDays * 24 * 60 * 60 * 1000);
  await platform.billing.start({
    tenantId: tenant.id,
    provider: input.billing.provider,
    plan: input.plan,
    trialEndsAt,
  });

  const storage = await provision(input.media, tenant.id);

  return {
    tenant,
    trialEndsAt,
    invitation: {
      id: invitation.id,
      email: invitation.email,
      expiresAt: invitation.expiresAt,
      token: secret.token,
    },
    jobTypes: seeds.length,
    storage,
  };
}

/**
 * Creates the bucket, and survives failing to.
 *
 * A Cloudflare outage must not cost us the company row we just wrote — the rest
 * of onboarding is done and correct, and re-running it would collide on the
 * slug. So the failure is reported, not thrown, and the maintenance sweep
 * finishes the job when Cloudflare is back.
 */
async function provision(
  media: MediaStorage,
  tenantId: string,
): Promise<OnboardedCompany['storage']> {
  const existing = await getPlatformDataSource().storage.find(tenantId);
  try {
    const bucket = await provisionTenantStorage(media, tenantId);
    return { bucket: bucket.bucket, created: existing === undefined, error: null };
  } catch (error) {
    return {
      bucket: null,
      created: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
