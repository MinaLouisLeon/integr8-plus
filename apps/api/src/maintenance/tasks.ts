import {
  advanceAfterCreating,
  calendarDay,
  contractLastDay,
  creationDay,
  type CustomRoleOverlay,
  type DueCandidate,
  formatContractReference,
  formatWorkOrderReference,
  groupCandidates,
  holds,
  type Permission,
  windowDays,
  windowInstants,
  withinPlan,
} from '@integr8/core';
import {
  type DeadlineNotice,
  type DuePlan,
  getPlatformDataSource,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import type { ApiConfig } from '../config.js';
import { deliver } from '../email/deliver.js';
import { contractsUrl, deadlinesUrl, workOrderUrl } from '../email/links.js';
import {
  contractRenewalEmail,
  type DeadlineItem,
  deadlineAlertEmail,
  type RenewalItem,
} from '../email/messages.js';
import type { EmailSender } from '../email/sender.js';
import { isFeatureEnabled } from '../http/features.js';
import type { Logger } from '../http/logger.js';
import type { PushMessage, PushSender } from '../push/sender.js';
import { nextDueFor } from '../routes/v1/maintenance.js';

/**
 * The worker's part in P27.
 *
 * Once a day: every active maintenance plan whose next job is due to be made
 * makes it (or joins one another plan made at the same site), and contracts
 * entering their notice period, or ended without renewal, are announced to
 * the people who keep contracts.
 *
 * Every few minutes: deadlines that passed unmet are recorded — which writes
 * the job's history — and announced, and deadlines within their warning are
 * announced once.
 *
 * Same shape as the other recurring runs: no cron, a turn claimed in
 * `scheduled_task_runs` so several workers make one run. A message that could
 * not be sent is not retried; the screens show the same thing.
 */

export const MAINTENANCE_TASK = 'maintenance.plans';
export const DEADLINES_TASK = 'deadlines.alerts';

const DAILY = { hours: 20 } as const;
const OFTEN = { minutes: 10 } as const;

/** At most this many due dates of one plan are caught up in one run. */
const CATCH_UP_LIMIT = 24;

export interface TaskOptions {
  config: ApiConfig;
  logger: Logger;
  email?: EmailSender;
  push?: PushSender;
  workerId: string;
  now?: Date;
  /** Skips the turn-claiming, for tests. */
  force?: boolean;
}

export interface MaintenanceReport {
  companies: number;
  jobsCreated: number;
  occurrences: number;
  skipped: number;
  renewalAlerts: number;
  failures: { tenantId: string; message: string }[];
}

export interface DeadlineReport {
  companies: number;
  warned: number;
  missed: number;
  failures: { tenantId: string; message: string }[];
}

async function eachCompany(
  task: string,
  every: { hours: number } | { minutes: number },
  options: TaskOptions,
  run: (tenant: { id: string; name: string }) => Promise<void>,
  failures: { tenantId: string; message: string }[],
): Promise<boolean> {
  const platform = getPlatformDataSource();
  const claimed =
    options.force === true || (await platform.metering.claimTask(task, every, options.workerId));
  if (!claimed) {
    return false;
  }
  try {
    const tenants = (await platform.tenants.list()).filter(
      (tenant) => tenant.status === 'active' && tenant.deletedAt === null,
    );
    for (const tenant of tenants) {
      try {
        await run(tenant);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ tenantId: tenant.id, message });
        options.logger.error(`${task} failed for a company`, {
          tenantId: tenant.id,
          error: message,
        });
      }
    }
    await platform.metering.finishTask(task);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await platform.metering.finishTask(task, message);
    throw error;
  }
  return true;
}

interface Person {
  userId: string;
  name: string;
  email: string;
}

/** The active members holding a permission. */
async function holdersOf(tx: TenantTransaction, permission: Permission): Promise<Person[]> {
  const members = (await tx.tenantUsers.list()).filter((member) => member.status === 'active');
  const [roles, grants] = await Promise.all([
    tx.tenantRoles.list({ includeArchived: true }),
    tx.memberGrants.forUsers(members.map((member) => member.userId)),
  ]);
  const overlay = new Map<string, CustomRoleOverlay>(
    roles.map((role) => [role.id, { id: role.id, added: role.added, removed: role.removed }]),
  );
  return members
    .filter((member) =>
      holds(
        {
          role: member.role,
          grants: grants.get(member.userId) ?? [],
          customRole: member.customRoleId === null ? undefined : overlay.get(member.customRoleId),
        },
        permission,
      ),
    )
    .map((member) => ({ userId: member.userId, name: member.displayName, email: member.email }));
}

// ---------------------------------------------------------------------------
// Maintenance plans and contract renewals, daily
// ---------------------------------------------------------------------------

export async function runMaintenancePlans(options: TaskOptions): Promise<MaintenanceReport> {
  const report: MaintenanceReport = {
    companies: 0,
    jobsCreated: 0,
    occurrences: 0,
    skipped: 0,
    renewalAlerts: 0,
    failures: [],
  };
  await eachCompany(
    MAINTENANCE_TASK,
    DAILY,
    options,
    async (tenant) => {
      const now = options.now ?? new Date();
      let touched = false;
      if (await isFeatureEnabled(tenant.id, 'assets')) {
        const made = await withTenant(tenant.id, (tx) => makeJobs(tx, now));
        report.jobsCreated += made.jobsCreated;
        report.occurrences += made.occurrences;
        report.skipped += made.skipped;
        touched = made.occurrences + made.skipped > 0;
      }
      const alerts = await renewalReminders(tenant, now, options);
      report.renewalAlerts += alerts;
      if (touched || alerts > 0) {
        report.companies += 1;
      }
    },
    report.failures,
  );
  return report;
}

interface Candidate extends DueCandidate {
  due: DuePlan;
  sequence: number;
}

/**
 * Makes every job due by today, for one company, in one transaction. Plans
 * waiting on a completed job move on first, so a job finished yesterday can
 * lead to the next one today.
 */
export async function makeJobs(
  tx: TenantTransaction,
  now: Date,
): Promise<{ jobsCreated: number; occurrences: number; skipped: number }> {
  const { timezone } = await tx.settings.get();
  const today = calendarDay(now, timezone);
  let jobsCreated = 0;
  let occurrences = 0;
  let skipped = 0;

  // Completion plans whose last job has finished.
  const waiting = await tx.maintenance.waitingOnCompletion();
  const lasts = await tx.maintenance.lastOccurrences(waiting.map((plan) => plan.id));
  for (const plan of waiting) {
    const next = nextDueFor(plan, today, lasts.get(plan.id), timezone);
    if (next.nextDueOn !== null) {
      await tx.maintenance.advance(plan.id, next);
    }
  }

  const candidates: Candidate[] = [];
  for (const due of await tx.maintenance.dueForCreation(today)) {
    const { plan } = due;
    const contractEnd =
      due.contractEndsOn === null
        ? null
        : contractLastDay({ endsOn: due.contractEndsOn, cancelledOn: due.contractCancelledOn });
    const schedule = {
      counting: plan.counting,
      interval: { count: plan.intervalCount, unit: plan.intervalUnit },
      startsOn: plan.startsOn,
      endsOn: plan.endsOn,
    };
    let dueOn = plan.nextDueOn;
    let sequence = plan.nextSequence;
    for (let caught = 0; dueOn !== null && caught < CATCH_UP_LIMIT; caught += 1) {
      if (
        creationDay(dueOn, plan.leadDays) > today ||
        !withinPlan(dueOn, plan.endsOn, contractEnd)
      ) {
        break;
      }
      if (plan.assetStatus === 'retired') {
        if (
          await tx.maintenance.recordOccurrence({
            planId: plan.id,
            dueOn,
            workOrderId: null,
            skipReason: 'asset_retired',
          })
        ) {
          skipped += 1;
        }
      } else if (!(await tx.maintenance.hasOccurrence(plan.id, dueOn))) {
        candidates.push({
          key: `${plan.id}:${dueOn}`,
          siteId: plan.siteId,
          jobTypeId: plan.jobTypeId,
          contractId: plan.contractId,
          canShare: plan.canShare,
          dueOn,
          window: windowDays(dueOn, plan.windowBeforeDays, plan.windowAfterDays),
          due,
          sequence,
        });
      }
      const next = advanceAfterCreating(schedule, sequence);
      dueOn = next.nextDueOn;
      sequence = next.nextSequence;
      await tx.maintenance.advance(plan.id, next);
    }
  }

  for (const group of groupCandidates(candidates)) {
    const members = group.candidates as Candidate[];
    const first = members[0]!;
    const plan = first.due.plan;
    const customer = await tx.customers.find(plan.customerId);
    if (customer === undefined || customer.status === 'closed') {
      continue;
    }
    let workOrderId = first.canShare
      ? await tx.maintenance.joinableJob({
          siteId: plan.siteId,
          jobTypeId: plan.jobTypeId,
          contractId: plan.contractId,
          window: group.window,
          timeZone: timezone,
        })
      : undefined;
    if (workOrderId === undefined) {
      const { dueFrom, dueBy } = windowInstants(group.window, timezone);
      const titles = [...new Set(members.map((member) => member.due.plan.title))];
      const instructions = members
        .map((member) => member.due.plan.instructions)
        .filter((text): text is string => text !== null && text.trim() !== '');
      const job = await tx.workOrders.create(
        {
          customerId: plan.customerId,
          siteId: plan.siteId,
          jobTypeId: plan.jobTypeId,
          title: titles.join(', ').slice(0, 200),
          ...(instructions.length === 0
            ? {}
            : { instructions: [...new Set(instructions)].join('\n\n').slice(0, 10000) }),
          dueFrom,
          dueBy,
          assetIds: members.map((member) => member.due.plan.assetId),
          maintenance: { contractId: plan.contractId },
        },
        plan.createdBy,
      );
      workOrderId = job.id;
      jobsCreated += 1;
    } else {
      for (const member of members) {
        await tx.assets.link(workOrderId, member.due.plan.assetId, member.due.plan.createdBy);
      }
    }
    for (const member of members) {
      if (
        await tx.maintenance.recordOccurrence({
          planId: member.due.plan.id,
          dueOn: member.dueOn,
          workOrderId,
        })
      ) {
        occurrences += 1;
      }
    }
  }
  return { jobsCreated, occurrences, skipped };
}

async function renewalReminders(
  tenant: { id: string; name: string },
  now: Date,
  options: TaskOptions,
): Promise<number> {
  const prepared = await withTenant(tenant.id, async (tx) => {
    const { timezone } = await tx.settings.get();
    const alerts = await tx.contracts.dueRenewalAlerts(calendarDay(now, timezone));
    if (alerts.length === 0) {
      return undefined;
    }
    const [managers, customers] = await Promise.all([
      holdersOf(tx, 'contract.manage'),
      tx.customers.findMany(alerts.map((alert) => alert.contract.customerId)),
    ]);
    const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));
    const items: RenewalItem[] = alerts.map((alert) => ({
      reference: formatContractReference(alert.contract.reference),
      title: alert.contract.title,
      customer: customerName.get(alert.contract.customerId) ?? '',
      endsOn: alert.contract.endsOn,
      stage: alert.stage,
    }));
    return { alerts, managers, items };
  });
  if (prepared === undefined) {
    return 0;
  }
  if (options.email !== undefined) {
    const url = contractsUrl(options.config.WEB_APP_URL);
    for (const manager of prepared.managers) {
      await deliver(
        options.email,
        options.logger,
        contractRenewalEmail({
          to: manager.email,
          companyName: tenant.name,
          items: prepared.items,
          url,
        }),
        { kind: 'contract_renewal', tenantId: tenant.id },
      );
    }
  }
  await withTenant(tenant.id, async (tx) => {
    for (const alert of prepared.alerts) {
      await tx.contracts.markRenewalAlerted(alert.contract.id, alert.stage);
    }
  });
  return prepared.alerts.length;
}

// ---------------------------------------------------------------------------
// Deadlines, every few minutes
// ---------------------------------------------------------------------------

export async function runDeadlineAlerts(options: TaskOptions): Promise<DeadlineReport> {
  const report: DeadlineReport = { companies: 0, warned: 0, missed: 0, failures: [] };
  await eachCompany(
    DEADLINES_TASK,
    OFTEN,
    options,
    async (tenant) => {
      const outcome = await deadlineAlertsFor(tenant, options);
      report.warned += outcome.warned;
      report.missed += outcome.missed;
      if (outcome.warned + outcome.missed > 0) {
        report.companies += 1;
      }
    },
    report.failures,
  );
  return report;
}

interface Notice extends DeadlineNotice {
  stage: 'warning' | 'missed';
}

async function deadlineAlertsFor(
  tenant: { id: string; name: string },
  options: TaskOptions,
): Promise<{ warned: number; missed: number }> {
  const now = options.now ?? new Date();
  // Recording a miss writes the job's history; it is done whatever happens to the messages.
  const prepared = await withTenant(tenant.id, async (tx) => {
    const missed = await tx.deadlines.recordMisses(now);
    const warnings = await tx.deadlines.dueWarnings(now);
    const notices: Notice[] = [
      ...missed.map((notice) => ({ ...notice, stage: 'missed' as const })),
      ...warnings.map((notice) => ({ ...notice, stage: 'warning' as const })),
    ];
    if (notices.length === 0) {
      return undefined;
    }
    const jobIds = [...new Set(notices.map((notice) => notice.workOrderId))];
    const [jobs, crews, managers, settings] = await Promise.all([
      tx.workOrders.findMany(jobIds),
      tx.workOrders.listCrews(jobIds),
      holdersOf(tx, 'work_order.manage'),
      tx.settings.get(),
    ]);
    const customers = await tx.customers.findMany(jobs.map((job) => job.customerId));
    const members = (await tx.tenantUsers.list()).filter((member) => member.status === 'active');
    const devices = await tx.pushDevices.activeFor([
      ...new Set([...crews.values()].flat().map((member) => member.userId)),
    ]);
    return { notices, warnings, jobs, crews, managers, settings, customers, members, devices };
  });
  if (prepared === undefined) {
    return { warned: 0, missed: 0 };
  }
  const { notices, jobs, crews, managers, settings, customers, members, devices } = prepared;
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));
  const memberById = new Map(members.map((member) => [member.userId as string, member]));
  const when = new Intl.DateTimeFormat('en-GB', {
    timeZone: settings.timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const itemOf = (notice: Notice): DeadlineItem | undefined => {
    const job = jobById.get(notice.workOrderId);
    if (job === undefined) {
      return undefined;
    }
    return {
      job: `${formatWorkOrderReference(job.reference)} ${job.title}`,
      customer: customerName.get(job.customerId) ?? '',
      kind: notice.kind,
      dueAt: when.format(notice.dueAt),
      stage: notice.stage,
      url: workOrderUrl(options.config.WEB_APP_URL, job.id),
    };
  };

  if (options.email !== undefined) {
    // Everyone hears once per run: managers about every job, the crew about theirs.
    const byPerson = new Map<string, Notice[]>();
    for (const manager of managers) {
      byPerson.set(manager.userId, [...notices]);
    }
    for (const notice of notices) {
      for (const member of crews.get(notice.workOrderId) ?? []) {
        const list = byPerson.get(member.userId) ?? [];
        if (!list.includes(notice)) {
          byPerson.set(member.userId, [...list, notice]);
        }
      }
    }
    const url = deadlinesUrl(options.config.WEB_APP_URL);
    for (const [userId, list] of byPerson) {
      const member = memberById.get(userId);
      const items = list.map(itemOf).filter((item): item is DeadlineItem => item !== undefined);
      if (member === undefined || items.length === 0) {
        continue;
      }
      await deliver(
        options.email,
        options.logger,
        deadlineAlertEmail({ to: member.email, companyName: tenant.name, items, url }),
        { kind: 'deadline_alert', tenantId: tenant.id },
      );
    }
  }

  if (options.push !== undefined) {
    const tokens = new Map<string, string[]>();
    for (const device of devices) {
      tokens.set(device.userId, [...(tokens.get(device.userId) ?? []), device.token]);
    }
    const messages: PushMessage[] = notices.flatMap((notice) => {
      const job = jobById.get(notice.workOrderId);
      if (job === undefined) {
        return [];
      }
      const label = formatWorkOrderReference(job.reference);
      const what = notice.kind === 'response' ? 'response' : 'completion';
      return (crews.get(notice.workOrderId) ?? []).flatMap((member) =>
        (tokens.get(member.userId) ?? []).map((token) => ({
          to: token,
          title:
            notice.stage === 'missed'
              ? `${label}: ${what} deadline missed`
              : `${label}: ${what} deadline soon`,
          // No time: the phone shows it in its own time zone, which may not be the company's.
          body: job.title,
          data: { kind: 'deadline_alert', workOrderId: job.id },
          channelId: 'jobs' as const,
          priority: notice.stage === 'missed' ? ('high' as const) : ('default' as const),
        })),
      );
    });
    if (messages.length > 0) {
      try {
        await options.push.send(messages);
      } catch (error) {
        options.logger.warn('Deadline alert push failed', {
          tenantId: tenant.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Warnings are marked once they have gone out, whatever became of each message.
  await withTenant(tenant.id, async (tx) => {
    for (const warning of prepared.warnings) {
      await tx.deadlines.markWarned(warning.workOrderId, warning.kind);
    }
  });
  return {
    warned: prepared.warnings.length,
    missed: notices.filter((notice) => notice.stage === 'missed').length,
  };
}
