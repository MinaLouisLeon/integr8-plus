import { aiPeriodOf, type AiPolicy, type Principal } from '@integr8/core';
import {
  AiBudgetExceededError,
  AiMemberBudgetExceededError,
  type AiMessageReservation,
  AiQuotaExceededError,
  getPlatformDataSource,
  withTenant,
} from '@integr8/db';
import type { ApiConfig } from '../config.js';
import {
  aiBudgetUnavailable,
  aiConcurrencyLimit,
  aiMemberBudgetExceeded,
  aiQuotaExceeded,
  aiRequestInProgress,
} from './errors.js';
import { limitsOf, periodKeysAt } from './periods.js';
import { ApiError } from '../http/errors.js';

/**
 * Admitting one message (docs/ai §4.4; ADR-0001 D2, D3).
 *
 * Two reservations, in order: the deployment's own monthly budget, then the
 * company's counters and budget in one tenant transaction. A refusal of the
 * second gives the first back. Both are committed before any provider is
 * called, and nothing here holds a connection while a model thinks.
 *
 * In-flight concurrency is counted in this process: a cap of a few requests
 * per company and per member against runaway clients, not a cross-instance
 * guarantee (the counters are that).
 */

export interface Admission {
  reservation: AiMessageReservation;
  /** `replay` carries a finished answer to return; `claimed` is a fresh slot. */
  outcome: 'claimed' | 'replay';
  periods: { day: string; month: string };
  reservedCostMicrousd: number;
}

const inFlight = new Map<string, number>();

function take(key: string, limit: number): boolean {
  const current = inFlight.get(key) ?? 0;
  if (current >= limit) {
    return false;
  }
  inFlight.set(key, current + 1);
  return true;
}

function give(key: string): void {
  const current = inFlight.get(key) ?? 0;
  if (current <= 1) {
    inFlight.delete(key);
  } else {
    inFlight.set(key, current - 1);
  }
}

/** Counts a request as in flight for its company and member until `release` is called. */
export function acquireSlot(principal: Principal, config: ApiConfig): () => void {
  const tenantKey = `tenant:${principal.tenantId}`;
  const userKey = `user:${principal.tenantId}:${principal.userId}`;
  if (!take(tenantKey, config.AI_MAX_CONCURRENT_PER_TENANT)) {
    throw aiConcurrencyLimit();
  }
  if (!take(userKey, config.AI_MAX_CONCURRENT_PER_USER)) {
    give(tenantKey);
    throw aiConcurrencyLimit();
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    give(userKey);
    give(tenantKey);
  };
}

export async function admitMessage(input: {
  principal: Principal;
  conversationId: string;
  clientRequestId: string;
  requestFingerprint: string;
  policy: AiPolicy;
  /** The member's percentage of the company's allowance (ADR-0002 D6). */
  sharePercent: number | null;
  /** The member's own monthly dollar cap, set by the platform (D7). */
  memberCostCapMicrousd?: number | null;
  worstCaseCostMicrousd: number;
  config: ApiConfig;
  now?: Date;
}): Promise<Admission> {
  const now = input.now ?? new Date();
  const periods = periodKeysAt(now);
  const platform = getPlatformDataSource().ai;

  // A retry of a request that already has a reservation never touches the
  // budget: it is answered from the row it made the first time.
  const existing = await withTenant(input.principal.tenantId, (tx) =>
    tx.aiUsage.findByRequest(input.principal.userId, input.clientRequestId),
  );
  if (existing !== undefined) {
    if (existing.requestFingerprint !== input.requestFingerprint) {
      throw new ApiError(
        409,
        'ai_request_in_progress',
        'This Idempotency-Key was already used for a different question.',
      );
    }
    if (existing.state === 'completed') {
      return { reservation: existing, outcome: 'replay', periods, reservedCostMicrousd: 0 };
    }
    throw aiRequestInProgress();
  }

  const globalOk = await platform.reserveGlobalBudget(
    periods.month,
    input.worstCaseCostMicrousd,
    input.config.AI_GLOBAL_MONTHLY_BUDGET_MICROUSD,
  );
  if (!globalOk) {
    throw aiBudgetUnavailable();
  }

  try {
    const outcome = await withTenant(input.principal.tenantId, (tx) =>
      tx.aiUsage.reserve({
        userId: input.principal.userId,
        conversationId: input.conversationId,
        clientRequestId: input.clientRequestId,
        requestFingerprint: input.requestFingerprint,
        periods,
        limits: limitsOf(input.policy, input.sharePercent),
        costMicrousd: input.worstCaseCostMicrousd,
        costCapMicrousd: input.policy.monthlyCostCapMicrousd,
        memberCostCapMicrousd: input.memberCostCapMicrousd ?? null,
        expiresAt: new Date(now.getTime() + input.config.AI_RESERVATION_TTL_SECONDS * 1000),
      }),
    );
    switch (outcome.outcome) {
      case 'claimed':
        return {
          reservation: outcome.reservation,
          outcome: 'claimed',
          periods,
          reservedCostMicrousd: input.worstCaseCostMicrousd,
        };
      case 'replay':
        await platform.settleGlobalBudget(periods.month, {
          reserved: input.worstCaseCostMicrousd,
          spent: 0,
          unknown: 0,
        });
        return {
          reservation: outcome.reservation,
          outcome: 'replay',
          periods,
          reservedCostMicrousd: 0,
        };
      case 'in_progress':
      case 'fingerprint_mismatch':
        await platform.settleGlobalBudget(periods.month, {
          reserved: input.worstCaseCostMicrousd,
          spent: 0,
          unknown: 0,
        });
        throw aiRequestInProgress();
      default:
        throw new Error('unreachable reservation outcome');
    }
  } catch (error) {
    if (
      error instanceof AiQuotaExceededError ||
      error instanceof AiBudgetExceededError ||
      error instanceof AiMemberBudgetExceededError
    ) {
      await platform.settleGlobalBudget(periods.month, {
        reserved: input.worstCaseCostMicrousd,
        spent: 0,
        unknown: 0,
      });
    }
    if (error instanceof AiQuotaExceededError) {
      throw aiQuotaExceeded(error.axis, aiPeriodOf(error.axis, now).resetsAt);
    }
    if (error instanceof AiBudgetExceededError) {
      throw aiBudgetUnavailable();
    }
    if (error instanceof AiMemberBudgetExceededError) {
      throw aiMemberBudgetExceeded(aiPeriodOf('month', now).resetsAt);
    }
    throw error;
  }
}

/**
 * Settles an admitted message in both ledgers: the company's reservation and
 * counters, then the deployment's budget. A second settlement of the same
 * reservation changes nothing anywhere.
 */
export async function settleMessage(input: {
  tenantId: string;
  reservationId: string;
  outcome: 'completed' | 'released' | 'uncertain' | 'expired';
  responseMessageId?: string | null;
  spentMicrousd: number;
  unknownMicrousd?: number;
  errorCode?: string | null;
}): Promise<AiMessageReservation | undefined> {
  const before = await withTenant(input.tenantId, (tx) => tx.aiUsage.find(input.reservationId));
  if (before === undefined) {
    return undefined;
  }
  const settled = await withTenant(input.tenantId, (tx) =>
    tx.aiUsage.settle({
      reservationId: input.reservationId,
      outcome: input.outcome,
      responseMessageId: input.responseMessageId ?? null,
      spentMicrousd: input.spentMicrousd,
      unknownMicrousd: input.unknownMicrousd ?? 0,
      errorCode: input.errorCode ?? null,
    }),
  );
  if (settled === undefined || before.state === settled.state) {
    // Nothing moved: already settled, or an uncertain row told uncertain again.
    return settled;
  }
  const month = aiPeriodOf('month', before.createdAt).start;
  await getPlatformDataSource().ai.settleGlobalBudget(month, {
    reserved: before.state === 'reserved' ? before.reservedCostMicrousd : 0,
    spent: input.spentMicrousd,
    unknown:
      (input.unknownMicrousd ?? 0) -
      (before.state === 'uncertain' ? before.reservedCostMicrousd : 0),
  });
  return settled;
}
