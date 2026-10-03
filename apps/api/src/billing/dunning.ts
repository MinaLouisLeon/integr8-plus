import { getPlatformDataSource, type Subscription } from '@integr8/db';
import type { ApiConfig } from '../config.js';
import { withTenant } from '@integr8/db';
import { deliver } from '../email/deliver.js';
import { billingUrl } from '../email/links.js';
import { dunningEmail } from '../email/messages.js';
import type { EmailSender } from '../email/sender.js';
import { forgetTenantStatus } from '../http/suspension.js';
import type { Logger } from '../http/logger.js';

/**
 * What happens to a company that has not paid (P17).
 *
 * The plan's rule is the whole design: *read-only on non-payment, never
 * deletion. A company that pays late is still a customer; a company whose data
 * you deleted is a lawsuit.* So nothing in this file removes anything. The
 * worst it does is refuse writes, and paying undoes that in one webhook.
 *
 * The sequence, from the first failed charge:
 *
 * 1. the webhook writes `past_due_since` and a `grace_ends_at` that is
 *    `BILLING_GRACE_DAYS` later — a fortnight by default;
 * 2. this run posts a reminder every {@link REMINDER_INTERVAL_DAYS} days;
 * 3. when the grace runs out it sets `read_only_since`, and keeps reminding.
 *
 * A trial that ends unpaid joins at step 1, because "your trial is over" and
 * "your payment failed" need the same fortnight and the same ending.
 *
 * **Where the reminders go.** Two places, since P18: an announcement banner
 * through the P15 channel, and an email to everybody who can do something about
 * it — the owners and admins. P17 could only do the first, because no email
 * sender existed, and said so in this comment. It exists now, so the gap this
 * paragraph used to describe is closed.
 *
 * The email is sent on the same cadence as the banner and is allowed to fail:
 * a reminder that bounced must not stop the account moving through dunning, and
 * must not make a worker retry the whole run.
 *
 * Like the metering sweep, this is not a queued job and there is no cron: the
 * worker runs it on a timer and claims its turn in `scheduled_task_runs`.
 */

export const DUNNING_TASK = 'billing.dunning';

/** How far apart the runs must be. Once a day, judged from the last start. */
const DAILY = { hours: 20 } as const;

/**
 * How often a company in arrears is reminded.
 *
 * Every three days rather than daily: a banner that reappears every morning is
 * one people learn to click past, and a fortnight's grace at this cadence is
 * four or five reminders — enough that nobody can say they were not told,
 * rarely enough that each one still reads as news.
 */
export const REMINDER_INTERVAL_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DunningReport {
  /** Trials that ran out and were moved into the same grace period. */
  trialsEnded: number;
  remindersPosted: number;
  madeReadOnly: number;
  failures: { tenantId: string; step: string; message: string }[];
}

export interface DunningOptions {
  config: ApiConfig;
  logger: Logger;
  /** Who carries the reminders (P18). Absent leaves them in-app only. */
  email?: EmailSender;
  workerId: string;
  now?: Date;
  /** Skips the turn-claiming, for the CLI and for tests. */
  force?: boolean;
}

export async function runDunning(options: DunningOptions): Promise<DunningReport> {
  const report: DunningReport = {
    trialsEnded: 0,
    remindersPosted: 0,
    madeReadOnly: 0,
    failures: [],
  };

  const platform = getPlatformDataSource();
  const claimed =
    options.force === true ||
    (await platform.metering.claimTask(DUNNING_TASK, DAILY, options.workerId));
  if (!claimed) {
    return report;
  }

  try {
    await endLapsedTrials(options, report);
    await remindAndRestrict(options, report);
    await platform.metering.finishTask(DUNNING_TASK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await platform.metering.finishTask(DUNNING_TASK, message);
    throw error;
  }

  return report;
}

/**
 * Moves a finished trial into the same grace period a failed payment gets.
 *
 * Not straight to read-only. Somebody who never got round to entering a card is
 * in exactly the position of somebody whose card expired, and giving the two
 * the same fortnight means one path to test and one story to tell.
 */
async function endLapsedTrials(options: DunningOptions, report: DunningReport): Promise<void> {
  const platform = getPlatformDataSource();
  const now = options.now ?? new Date();

  for (const subscription of await platform.billing.lapsedTrials(now)) {
    try {
      await platform.billing.update(subscription.tenantId, {
        status: 'past_due',
        // Dated from when the trial actually ended, not from whenever this run
        // happened to notice. A worker that was down for a week must not hand
        // out an extra week of grace.
        pastDueSince: subscription.trialEndsAt ?? now,
        graceEndsAt: new Date(
          (subscription.trialEndsAt ?? now).getTime() + options.config.BILLING_GRACE_DAYS * DAY_MS,
        ),
        remindersSent: 0,
      });
      report.trialsEnded += 1;

      options.logger.info('Trial ended', {
        tenantId: subscription.tenantId,
        trialEndedAt: (subscription.trialEndsAt ?? now).toISOString(),
      });
    } catch (error) {
      report.failures.push({
        tenantId: subscription.tenantId,
        step: 'trial',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function remindAndRestrict(options: DunningOptions, report: DunningReport): Promise<void> {
  const platform = getPlatformDataSource();
  const now = options.now ?? new Date();

  for (const subscription of await platform.billing.inDunning()) {
    try {
      const outcome = await stepOne(subscription, options, now);
      if (outcome.madeReadOnly) {
        report.madeReadOnly += 1;
      }
      if (outcome.reminded) {
        report.remindersPosted += 1;
      }
    } catch (error) {
      report.failures.push({
        tenantId: subscription.tenantId,
        step: 'dunning',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * One company's turn through the sequence.
 *
 * `reminders_sent` is a position in the cadence rather than a tally of posts:
 * it is set to whichever reminder is due today, so a worker that missed three
 * days sends the one that is due now instead of three in a row, and a run that
 * happens twice in a day sends nothing the second time.
 */
async function stepOne(
  subscription: Subscription,
  options: DunningOptions,
  now: Date,
): Promise<{ madeReadOnly: boolean; reminded: boolean }> {
  const platform = getPlatformDataSource();
  const { tenantId } = subscription;

  const since = subscription.pastDueSince;
  if (since === null) {
    // `inDunning` filters these out; the check is here so the arithmetic below
    // cannot be read as assuming something the query happens to guarantee.
    return { madeReadOnly: false, reminded: false };
  }

  const days = Math.floor((now.getTime() - since.getTime()) / DAY_MS);
  const due = Math.floor(days / REMINDER_INTERVAL_DAYS) + 1;
  const expired = subscription.graceEndsAt !== null && subscription.graceEndsAt <= now;

  const tenant = await platform.tenants.findById(tenantId);
  if (tenant === undefined) {
    return { madeReadOnly: false, reminded: false };
  }

  let madeReadOnly = false;
  if (expired && tenant.readOnlySince === null) {
    await platform.tenants.setReadOnly(tenantId, READ_ONLY_REASON);
    // The door-check caches a company's status for a minute; without this the
    // first minute of read-only would let writes through.
    forgetTenantStatus(tenantId);
    madeReadOnly = true;

    await platform.platformAudit.append({
      platformUserId: null,
      actorLabel: 'dunning',
      action: 'tenant.read_only',
      tenantId,
      tenantSlug: tenant.slug,
      targetKind: 'tenant',
      targetId: tenantId,
      metadata: {
        reason: 'non_payment',
        pastDueSince: since.toISOString(),
        graceEndedAt: subscription.graceEndsAt?.toISOString() ?? null,
      },
    });

    options.logger.warn('Company moved to read-only for non-payment', {
      tenantId,
      slug: tenant.slug,
      daysPastDue: days,
    });
  }

  // A reminder goes out when one is due, and always on the day the writes stop
  // — being told afterwards is late, but being told nothing at all is worse.
  if (!madeReadOnly && subscription.remindersSent >= due) {
    return { madeReadOnly, reminded: false };
  }

  const endsAt = new Date(now.getTime() + REMINDER_INTERVAL_DAYS * DAY_MS);
  await platform.settings.createAnnouncement({
    tenantId,
    severity: expired ? 'critical' : 'warning',
    message: { en: expired ? readOnlyMessage() : graceMessage(subscription.graceEndsAt) },
    endsAt,
    // Dismissible even when it is critical. A banner somebody cannot close is
    // a banner they stop reading, and this one is reposted every three days
    // until the bill is paid — the nagging is the cadence, not the pinning.
    dismissible: true,
    createdBy: null,
  });

  await notifyByEmail(tenantId, tenant.name, expired, subscription.graceEndsAt, options);

  await platform.billing.update(tenantId, {
    remindersSent: Math.max(due, subscription.remindersSent + 1),
  });

  return { madeReadOnly, reminded: true };
}

/**
 * Emails the people who can actually fix it.
 *
 * Owners and admins, because they are who holds `billing.read`; an engineer
 * cannot update a card and telling them is noise. Failures are logged and
 * swallowed — the account still moves through dunning whether or not the
 * message arrived, and a bounced reminder must not stall the run for everybody
 * else.
 */
async function notifyByEmail(
  tenantId: string,
  companyName: string,
  readOnly: boolean,
  graceEndsAt: Date | null,
  options: DunningOptions,
): Promise<void> {
  const sender = options.email;
  const url = billingUrl(options.config.WEB_APP_URL);
  if (sender === undefined || url === null) {
    return;
  }

  const recipients = (await withTenant(tenantId, (tx) => tx.tenantUsers.list())).filter(
    (member) => member.status === 'active' && (member.role === 'owner' || member.role === 'admin'),
  );

  for (const person of recipients) {
    await deliver(
      sender,
      options.logger,
      dunningEmail({
        to: person.email,
        companyName,
        billingUrl: url,
        deadline: graceEndsAt,
        readOnly,
      }),
      { kind: 'dunning', tenantId },
    );
  }
}

const READ_ONLY_REASON =
  'This account is read-only because a payment is outstanding. Nothing has been deleted — everything is here, and can be read and exported. Paying restores it immediately.';

function graceMessage(graceEndsAt: Date | null): string {
  const when = graceEndsAt === null ? 'shortly' : `on ${graceEndsAt.toISOString().slice(0, 10)}`;
  return `A payment for this account has not gone through. Please update the card in Billing. If it is still outstanding ${when}, the account becomes read-only — your data stays, but new work cannot be saved.`;
}

function readOnlyMessage(): string {
  return 'This account is read-only because a payment is outstanding. Nothing has been deleted and nothing will be: everything can still be read and exported. Update the card in Billing and writing is restored straight away.';
}
