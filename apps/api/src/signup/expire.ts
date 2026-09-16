import { getPlatformDataSource } from '@integr8/db';
import type { Logger } from '../http/logger.js';

/**
 * Ages out signups nobody verified (P18).
 *
 * The cheapest job in the system, and worth having anyway: a pending request is
 * a live token, and a token that never expires is a token that eventually
 * leaks. Nothing was ever created for these — no company, no bucket, no
 * identity — so expiring one costs the person nothing but a fresh start.
 *
 * Same shape as the metering and dunning runs: no cron, no scheduler, a turn
 * claimed in `scheduled_task_runs` so several workers produce one run.
 */

export const SIGNUP_EXPIRY_TASK = 'signup.expire';

const DAILY = { hours: 20 } as const;

export async function runSignupExpiry(options: {
  logger: Logger;
  workerId: string;
  now?: Date;
  force?: boolean;
}): Promise<{ expired: number }> {
  const platform = getPlatformDataSource();

  const claimed =
    options.force === true ||
    (await platform.metering.claimTask(SIGNUP_EXPIRY_TASK, DAILY, options.workerId));
  if (!claimed) {
    return { expired: 0 };
  }

  try {
    const expired = await platform.signup.expireOverdue(options.now ?? new Date());
    await platform.metering.finishTask(SIGNUP_EXPIRY_TASK);

    if (expired > 0) {
      options.logger.info('Signups expired', { expired });
    }
    return { expired };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await platform.metering.finishTask(SIGNUP_EXPIRY_TASK, message);
    throw error;
  }
}
