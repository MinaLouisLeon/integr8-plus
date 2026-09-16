import { getPlatformDataSource, type TenantPlan, withTenant } from '@integr8/db';
import { ApiError } from '../http/errors.js';
import { allowanceFor } from '../media/quota.js';

/**
 * What a company is allowed, and the refusals that make it true (P17).
 *
 * The plan's exit criterion is the whole design brief: *exceeding a plan limit
 * is blocked by the API even when the request bypasses the UI*. So nothing
 * here is advisory, nothing is checked in a client, and every limit is read
 * from the same `plan_allowances` row the dashboard edits.
 *
 * Three limits are enforced, because three have a meaning today: **seats**,
 * which existed since P15 and were enforced nowhere; **storage**, which P16
 * built; and **submissions per month**, which is the one that grows with use.
 * Form count and module access are in the plan's wording and are not here:
 * both would be limits against concepts the product does not have.
 *
 * The allowance is cached by plan in `media/quota.ts` — one cache, because two
 * caches of the same row disagree eventually.
 */

export interface Entitlements {
  plan: TenantPlan;
  seats: number | null;
  storageBytes: number | null;
  submissionsPerMonth: number | null;
}

export async function entitlementsFor(plan: TenantPlan): Promise<Entitlements> {
  const rule = await allowanceFor(plan);
  return {
    plan,
    seats: rule.seats,
    storageBytes: rule.storageBytes,
    submissionsPerMonth: rule.submissionsPerMonth,
  };
}

/** What a company is using against those limits, for a screen or a check. */
export interface Usage {
  seatsUsed: number;
  submissionsThisMonth: number;
}

export async function usageFor(tenantId: string): Promise<Usage> {
  return withTenant(tenantId, async (tx) => ({
    seatsUsed: await tx.tenantUsers.countActive(),
    submissionsThisMonth: await tx.submissions.countSince(startOfMonth()),
  }));
}

/**
 * The first moment of the current month, in UTC.
 *
 * A month has to start somewhere, and a company's own timezone would mean a
 * limit that resets at a different instant for every customer — and two
 * customers in one timezone disagreeing after a daylight change. UTC is the
 * one boundary nobody is surprised by twice.
 */
export function startOfMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Refuses a seat that is not paid for.
 *
 * Checked where a seat is actually taken — inviting somebody, and accepting an
 * invitation — rather than once at the door, because an invitation sent last
 * week can be accepted after the plan has changed.
 *
 * A seat is an **active member**. An outstanding invitation does not hold one:
 * counting them would let a company lock itself out of its own plan with
 * invitations nobody ever accepted, and the check at acceptance is the one
 * that matters.
 */
export async function assertSeatAvailable(input: {
  tenantId: string;
  plan: TenantPlan;
  /** Somebody already counted, when the caller has just read them. */
  seatsUsed?: number;
}): Promise<void> {
  const rule = await allowanceFor(input.plan);
  if (rule.seats === null) {
    return;
  }

  const used =
    input.seatsUsed ?? (await withTenant(input.tenantId, (tx) => tx.tenantUsers.countActive()));

  if (used < rule.seats) {
    return;
  }

  throw new ApiError(
    409,
    'seat_limit_reached',
    'Every seat on this plan is taken. Remove somebody, or move to a larger plan.',
    [
      {
        field: 'body.email',
        code: 'seat_limit_reached',
        message: 'No seats left.',
        params: { seatsUsed: String(used), seats: String(rule.seats) },
      },
    ],
  );
}

/**
 * Refuses a submission past the month's allowance.
 *
 * Counted from what was actually submitted this month rather than from a
 * running total, so a company that deletes a submission gets the seat back and
 * nobody has to keep a counter honest across a restore.
 */
export async function assertSubmissionAllowed(input: {
  tenantId: string;
  plan: TenantPlan;
  /**
   * The month's count, when the caller is already inside a tenant transaction
   * and has it. Passing it avoids opening a second connection while holding
   * one, which under load is how a pool runs dry.
   */
  submissionsUsed?: number;
}): Promise<void> {
  const rule = await allowanceFor(input.plan);
  if (rule.submissionsPerMonth === null) {
    return;
  }

  const used =
    input.submissionsUsed ??
    (await withTenant(input.tenantId, (tx) => tx.submissions.countSince(startOfMonth())));

  if (used < rule.submissionsPerMonth) {
    return;
  }

  throw new ApiError(
    409,
    'submission_limit_reached',
    'This plan’s submissions for the month are used up. They reset at the start of next month, or a larger plan lifts the limit.',
    [
      {
        field: 'body',
        code: 'submission_limit_reached',
        message: 'No submissions left this month.',
        params: {
          submissionsUsed: String(used),
          submissionsPerMonth: String(rule.submissionsPerMonth),
        },
      },
    ],
  );
}

/**
 * How many seats a company is being billed for.
 *
 * The provider bills a quantity, and the quantity is the number of active
 * members — so adding somebody costs money from that moment and removing them
 * stops costing it, which is what proration means here.
 */
export async function billableSeats(tenantId: string): Promise<number> {
  const used = await withTenant(tenantId, (tx) => tx.tenantUsers.countActive());
  // Never zero: a provider will not bill a subscription for nothing, and a
  // company with no active members still has an owner who is about to accept.
  return Math.max(1, used);
}

/** The company's plan, from the subscription rather than the tenant row. */
export async function planOf(tenantId: string): Promise<TenantPlan> {
  const subscription = await getPlatformDataSource().billing.find(tenantId);
  return subscription?.plan ?? 'trial';
}
