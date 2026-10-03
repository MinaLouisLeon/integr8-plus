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
  /**
   * How the owner gets in.
   *
   * `invitation` mints a token for somebody to be emailed — the platform flow,
   * where the owner is a stranger to whoever is onboarding them. `direct` is
   * self-serve: the person is already here, has already proved they own the
   * address, and is made an active owner immediately. Sending somebody an
   * invitation to a company they have just created themselves would be absurd.
   */
  ownerAccess: { kind: 'invitation' } | { kind: 'direct'; userId: string; displayName: string };
  /** Overrides {@link DEFAULT_JOB_TYPES}; an empty array seeds none. */
  jobTypes?: readonly { name: string; code: string }[];
  /**
   * The super admin who onboarded them, or null when nobody did (P18).
   *
   * Null is self-serve: a stranger signed up and verified their own address,
   * and there is no platform user to attribute it to. Everything that used to
   * name the onboarder — the seeded job types, the owner's invitation, the
   * audit entry — has to cope with that rather than borrow somebody's id,
   * because attributing a company's first rows to a super admin who never
   * touched it is a lie in the table people read to work out who did what.
   */
  onboardedBy: PlatformUserId | null;
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
  /** Null when the owner was made directly, which is the self-serve path. */
  invitation: { id: string; email: string; expiresAt: Date; token: string } | null;
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
   * Who the first rows are attributed to.
   *
   * On the platform path, the super admin: `created_by` carries no foreign key,
   * and naming a customer's user for work a super admin did would be a lie in
   * the table people read to work out who changed what. On the self-serve path
   * there is no super admin, so it is the owner — who really did cause it by
   * signing up.
   */
  const actor =
    input.ownerAccess.kind === 'direct'
      ? toUserId(input.ownerAccess.userId)
      : toUserId(input.onboardedBy ?? tenant.id);

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
  let invitation: OnboardedCompany['invitation'];
  try {
    invitation = await withTenant(tenantId, async (tx) => {
      for (const seed of seeds) {
        await tx.jobTypes.create(seed, actor);
      }

      // The owner, one of two ways. On the self-serve path they have already
      // proved they own the address, so they are simply made an active owner;
      // inviting somebody to a company they have just created themselves would
      // be absurd, and would put a live token in an email for no reason.
      let created: OnboardedCompany['invitation'] = null;
      if (input.ownerAccess.kind === 'direct') {
        await tx.tenantUsers.create({
          userId: input.ownerAccess.userId,
          email: input.ownerEmail,
          displayName: input.ownerAccess.displayName,
          role: OWNER_ROLE,
          status: 'active',
        });
      } else {
        const row = await tx.invitations.create({
          email: input.ownerEmail,
          role: OWNER_ROLE,
          invitedByUserId: actor,
          tokenHash: secret.hash,
          expiresAt,
        });
        created = {
          id: row.id,
          email: row.email,
          expiresAt: row.expiresAt,
          token: secret.token,
        };
      }

      await tx.auditLog.append({
        // A company that onboarded itself has no platform actor, and saying so
        // is the truth. `system` rather than inventing one.
        actorKind: input.onboardedBy === null ? 'system' : 'platform_user',
        actorId: input.onboardedBy,
        actorLabel: input.onboardedBy === null ? 'Self-serve signup' : 'Platform onboarding',
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

  // Every company gets its settings row here, so nothing downstream has to
  // cope with its absence.
  await platform.tenantSettings.ensure(tenant.id);

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
    invitation,
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
