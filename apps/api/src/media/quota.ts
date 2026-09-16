import {
  getPlatformDataSource,
  type OveragePolicy,
  type StorageUsage,
  type TenantPlan,
} from '@integr8/db';
import { ApiError } from '../http/errors.js';

/**
 * What a company is allowed to store, and what happens when they pass it
 * (P16).
 *
 * The rule is per plan and editable from the dashboard, so nothing here decides
 * policy — it reads the row and applies it. Two outcomes matter:
 *
 * - **block**: a new upload is refused at a hundred percent, with the numbers
 *   in the error so the client can say what is wrong rather than "failed".
 * - **allow**: the upload goes through and the overage is recorded on the day's
 *   sample, for P17 to bill from.
 *
 * The warning is the more important half. A company told at ninety percent can
 * do something about it; a company told at a hundred has already had an
 * engineer fail to upload a photo from a roof.
 */

export interface StorageQuota {
  usedBytes: number;
  /** Null is uncapped: an enterprise plan, or a plan nobody has capped yet. */
  allowanceBytes: number | null;
  /** 0–100 and beyond; null when there is no allowance to be a percentage of. */
  percentUsed: number | null;
  state: 'ok' | 'warning' | 'over';
  overage: OveragePolicy;
  warnAtPercent: number;
  /** How much is over the line. 0 unless `state` is `over`. */
  overageBytes: number;
}

/**
 * A plan's rule, cached briefly.
 *
 * The allowance is platform data and would otherwise be a second connection's
 * read on the upload path. It changes when somebody edits a plan, which is
 * rare; a minute of staleness costs at most a minute of the old limit, and the
 * dashboard clears the entry when it edits one.
 */
const CACHE_TTL_MS = 60_000;

interface CachedRule {
  storageBytes: number | null;
  overage: OveragePolicy;
  warnAtPercent: number;
  retentionDays: number | null;
  readAt: number;
}

const rules = new Map<TenantPlan, CachedRule>();

export function forgetAllowances(): void {
  rules.clear();
}

export async function allowanceFor(plan: TenantPlan, now = Date.now()): Promise<CachedRule> {
  const cached = rules.get(plan);
  if (cached !== undefined && now - cached.readAt < CACHE_TTL_MS) {
    return cached;
  }

  const row = await getPlatformDataSource().metering.allowanceFor(plan);
  const rule: CachedRule = {
    // A plan with no row is uncapped rather than blocked. A missing rule must
    // not be a silent outage for everybody on that plan.
    storageBytes: row?.storageBytes ?? null,
    overage: row?.overage ?? 'allow',
    warnAtPercent: row?.warnAtPercent ?? 80,
    retentionDays: row?.retentionDays ?? null,
    readAt: now,
  };

  rules.set(plan, rule);
  return rule;
}

/** Where a company stands, given what the ledger says they are using. */
export async function quotaFor(plan: TenantPlan, usage: StorageUsage): Promise<StorageQuota> {
  const rule = await allowanceFor(plan);
  return describe(usage.totalBytes, rule);
}

function describe(usedBytes: number, rule: CachedRule): StorageQuota {
  if (rule.storageBytes === null) {
    return {
      usedBytes,
      allowanceBytes: null,
      percentUsed: null,
      state: 'ok',
      overage: rule.overage,
      warnAtPercent: rule.warnAtPercent,
      overageBytes: 0,
    };
  }

  const percentUsed = (usedBytes / rule.storageBytes) * 100;
  const over = usedBytes >= rule.storageBytes;

  return {
    usedBytes,
    allowanceBytes: rule.storageBytes,
    percentUsed,
    state: over ? 'over' : percentUsed >= rule.warnAtPercent ? 'warning' : 'ok',
    overage: rule.overage,
    warnAtPercent: rule.warnAtPercent,
    overageBytes: Math.max(0, usedBytes - rule.storageBytes),
  };
}

/**
 * Refuses an upload that would take a company past a plan that blocks.
 *
 * The incoming bytes count. Checking what is already stored would let a single
 * upload of any size through as long as the company was one byte under, which
 * on a plan measured in gigabytes is not a rounding error.
 *
 * Nothing is refused on an `allow` plan: the bytes land and the day's sample
 * records the overage.
 */
export async function assertUploadFits(input: {
  plan: TenantPlan;
  usage: StorageUsage;
  incomingBytes: number;
}): Promise<void> {
  const rule = await allowanceFor(input.plan);
  if (rule.storageBytes === null || rule.overage === 'allow') {
    return;
  }

  const after = input.usage.totalBytes + input.incomingBytes;
  if (after <= rule.storageBytes) {
    return;
  }

  throw new ApiError(
    409,
    'storage_quota_exceeded',
    'This upload would take the company past its storage allowance. Delete some files, or ask for a larger plan.',
    [
      {
        field: 'body.byteSize',
        code: 'storage_quota_exceeded',
        message: 'Not enough storage left for this file.',
        params: {
          usedBytes: String(input.usage.totalBytes),
          allowanceBytes: String(rule.storageBytes),
          incomingBytes: String(input.incomingBytes),
          remainingBytes: String(Math.max(0, rule.storageBytes - input.usage.totalBytes)),
        },
      },
    ],
  );
}
