import { getPlatformDataSource, withTenant } from '@integr8/db';
import type { ApiConfig } from '../config.js';
import type { Logger } from '../http/logger.js';
import { settleMessage } from './admission.js';
import { resolveEffectiveAiPolicy } from './policy.js';

/**
 * The assistant's housekeeping (docs/ai §4.4 step 10, §10.1; ADR-0001 D3).
 *
 * Three jobs, each idempotent so several workers can run them at once:
 *
 * - **Stale reservations.** A request that was admitted and never settled —
 *   the process died, or the model timed out and the row went `uncertain` —
 *   still holds its slot and its money. Past its expiry, the reconciler looks
 *   for the stored answer: if there is one, the slot is used (the member got
 *   their answer, whatever the connection did); if there is none, the slot is
 *   released, and the money that may have been spent is settled from the
 *   calls that were recorded.
 * - **Expired proposals.** A prepared action nobody confirmed in time is
 *   marked expired so the screen says so.
 * - **Retention.** Conversations older than the company's retention window,
 *   and ones their member deleted, are removed with their messages. The charge
 *   record stays.
 */

export const AI_RETENTION_TASK = 'ai.retention';

export interface AiReconciliationReport {
  reconciled: number;
  released: number;
  charged: number;
  expiredProposals: number;
  sweptConversations: number;
  failures: { tenantId: string; step: string; message: string }[];
}

export async function runAiReconciliation(options: {
  config: ApiConfig;
  logger: Logger;
  workerId: string;
  now?: Date;
  /** Skips the daily turn-claiming for the retention sweep, for tests. */
  force?: boolean;
}): Promise<AiReconciliationReport> {
  const now = options.now ?? new Date();
  const platform = getPlatformDataSource();
  const report: AiReconciliationReport = {
    reconciled: 0,
    released: 0,
    charged: 0,
    expiredProposals: 0,
    sweptConversations: 0,
    failures: [],
  };

  // Stale reservations, company by company.
  for (const tenantId of await platform.ai.tenantsWithStaleReservations(now)) {
    try {
      const stale = await withTenant(tenantId, (tx) => tx.aiUsage.listStale(now));
      for (const reservation of stale) {
        // The answer is the charging boundary (docs/ai §8.6): a slot whose
        // worker died after storing it and before settling is charged, not
        // released, so a stored answer is never free.
        const answer = await withTenant(tenantId, async (tx) =>
          reservation.responseMessageId === null
            ? tx.aiConversations.findAnswerForReservation(reservation.id)
            : tx.aiConversations.findMessage(reservation.responseMessageId),
        );
        const answered = answer !== undefined;
        // A call still holding tokens when its worker died may have been
        // served: its hold is charged as used, once (ADR-0002 D5).
        if (reservation.reservedTokens > 0) {
          await withTenant(tenantId, (tx) =>
            tx.aiUsage.settleTokens({
              reservationId: reservation.id,
              held: reservation.reservedTokens,
              used: reservation.reservedTokens,
            }),
          );
        }
        const calls = await withTenant(tenantId, (tx) => tx.aiUsage.callsFor(reservation.id));
        const spent = calls
          .filter((call) => call.status === 'success')
          .reduce((sum, call) => sum + call.costMicrousd, 0);
        const unknown = calls
          .filter((call) => call.status === 'timeout' || call.status === 'unknown')
          .reduce((sum, call) => sum + call.costMicrousd, 0);
        await settleMessage({
          tenantId,
          reservationId: reservation.id,
          outcome: answered ? 'completed' : 'expired',
          responseMessageId: answer?.id ?? reservation.responseMessageId,
          // What a timed-out call may have cost is counted as spent now: the
          // budget stays conservative, and the slot is no longer held open.
          spentMicrousd: spent + unknown,
          unknownMicrousd: 0,
          errorCode: answered ? null : (reservation.lastErrorCode ?? 'reconciled'),
        });
        report.reconciled += 1;
        if (answered) {
          report.charged += 1;
        } else {
          report.released += 1;
        }
        options.logger.info('ai.quota.recovered', {
          tenantId,
          reservationId: reservation.id,
          outcome: answered ? 'completed' : 'expired',
        });
      }
    } catch (error) {
      report.failures.push({
        tenantId,
        step: 'reservations',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Expired proposals and the retention sweep, once a day across every company.
  const claimed =
    options.force === true ||
    (await platform.metering.claimTask(AI_RETENTION_TASK, { hours: 24 }, options.workerId));
  if (!claimed) {
    return report;
  }
  try {
    for (const tenant of await platform.tenants.list()) {
      try {
        const policy = await resolveEffectiveAiPolicy(tenant.id, options.config, now.getTime());
        const olderThan = new Date(now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000);
        const { expired, swept } = await withTenant(tenant.id, async (tx) => ({
          expired: await tx.aiActions.expirePending(now),
          swept: await tx.aiConversations.sweep(olderThan),
        }));
        report.expiredProposals += expired;
        report.sweptConversations += swept;
      } catch (error) {
        report.failures.push({
          tenantId: tenant.id,
          step: 'retention',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (options.force !== true) {
      await platform.metering.finishTask(
        AI_RETENTION_TASK,
        report.failures.length === 0 ? undefined : `${String(report.failures.length)} failures`,
      );
    }
  } catch (error) {
    if (options.force !== true) {
      await platform.metering.finishTask(
        AI_RETENTION_TASK,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
  return report;
}
