import {
  advanceAfterCreating,
  type CandidateGroup,
  calendarDay,
  contractLastDay,
  creationDay,
  type CustomRoleOverlay,
  type DueCandidate,
  formatContractReference,
  formatWorkOrderReference,
  groupCandidates,
  holds,
  MAX_PLAN_FAILURES,
  type NextDue,
  type Permission,
  windowDays,
  windowInstants,
  withinPlan,
} from '@integr8/core';
import {
  type DeadlineNotice,
  type DuePlan,
  getPlatformDataSource,
  type MaintenancePlan,
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
import { captureException } from '../observability/sentry.js';
import type { PushMessage, PushSender } from '../push/sender.js';
import {
  fill,
  messageLocale,
  momentFormatter,
  type NotificationWords,
  wordsFor,
} from '../notifications/words.js';
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
export const MAINTENANCE_RETRY_TASK = 'maintenance.retries';
export const DEADLINES_TASK = 'deadlines.alerts';

/** Between the instructions of plans that share a job. */
const PARAGRAPH = '\n\n';

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
  /** Companies whose run failed outright. */
  failures: { tenantId: string; message: string }[];
  /** Plans that could not make their jobs, each rolled back alone (0063). */
  planFailures: { tenantId: string; planId: string; message: string; failureCount: number }[];
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
  const report = emptyReport();
  await eachCompany(
    MAINTENANCE_TASK,
    DAILY,
    options,
    async (tenant) => {
      const now = options.now ?? new Date();
      let touched = false;
      if (await isFeatureEnabled(tenant.id, 'assets')) {
        const made = await withTenant(tenant.id, (tx) => makeJobs(tx, now));
        tally(report, made, tenant.id, options);
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

/**
 * Plans that failed on an earlier run, tried again alone on the worker's next
 * cycle (about every fifteen minutes) rather than the next day, until they
 * succeed or have failed {@link MAX_PLAN_FAILURES} times in a row (0063).
 */
export async function runMaintenanceRetries(options: TaskOptions): Promise<MaintenanceReport> {
  const report = emptyReport();
  await eachCompany(
    MAINTENANCE_RETRY_TASK,
    OFTEN,
    options,
    async (tenant) => {
      if (!(await isFeatureEnabled(tenant.id, 'assets'))) {
        return;
      }
      const now = options.now ?? new Date();
      const made = await withTenant(tenant.id, (tx) => makeJobs(tx, now, { retriesOnly: true }));
      tally(report, made, tenant.id, options);
      if (made.occurrences + made.skipped + made.failures.length > 0) {
        report.companies += 1;
      }
    },
    report.failures,
  );
  return report;
}

function emptyReport(): MaintenanceReport {
  return {
    companies: 0,
    jobsCreated: 0,
    occurrences: 0,
    skipped: 0,
    renewalAlerts: 0,
    failures: [],
    planFailures: [],
  };
}

/** Adds one company's run to the report, and says out loud which plans failed. */
function tally(report: MaintenanceReport, made: MadeJobs, tenantId: string, options: TaskOptions) {
  report.jobsCreated += made.jobsCreated;
  report.occurrences += made.occurrences;
  report.skipped += made.skipped;
  for (const failure of made.failures) {
    report.planFailures.push({
      tenantId,
      planId: failure.planId,
      message: failure.message,
      failureCount: failure.failureCount,
    });
    options.logger.error('A maintenance plan could not make its jobs', {
      tenantId,
      planId: failure.planId,
      failures: failure.failureCount,
      error: failure.message,
    });
    captureException(failure.error, {
      task: MAINTENANCE_TASK,
      tenantId,
      planId: failure.planId,
    });
  }
}

interface Candidate extends DueCandidate {
  due: DuePlan;
  sequence: number;
}

/** What one plan has to do on this run, worked out before anything is written. */
interface PlanWork {
  due: DuePlan;
  /** Due dates passed over because the asset is retired. */
  skips: string[];
  candidates: Candidate[];
  /** Where the plan goes next, once its due dates are made. */
  next: NextDue | undefined;
}

export interface PlanFailure {
  planId: string;
  message: string;
  /** Failures in a row, this one included. */
  failureCount: number;
  error: unknown;
}

export interface MadeJobs {
  jobsCreated: number;
  occurrences: number;
  skipped: number;
  failures: PlanFailure[];
}

type Counts = Omit<MadeJobs, 'failures'>;

/** Whether a run takes a plan: the daily run every plan still retried, a retry run only failed ones. */
function takes(plan: MaintenancePlan, retriesOnly: boolean): boolean {
  if (plan.failureCount >= MAX_PLAN_FAILURES) {
    return false;
  }
  return !retriesOnly || plan.failureCount > 0;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Makes every job due by today, for one company. Plans waiting on a completed
 * job move on first, so a job finished yesterday can lead to the next one today.
 *
 * Each plan's work runs in its own savepoint (0063). Plans whose due dates
 * share a job are written together; when that fails, each is tried again on
 * its own, so a bad plan cannot take a good one down with it. A plan that
 * still fails is rolled back alone and its failure recorded on it; a plan that
 * succeeds after failing has its failure cleared.
 */
export async function makeJobs(
  tx: TenantTransaction,
  now: Date,
  options: { retriesOnly?: boolean } = {},
): Promise<MadeJobs> {
  const retriesOnly = options.retriesOnly === true;
  const { timezone } = await tx.settings.get();
  const today = calendarDay(now, timezone);
  const made: MadeJobs = { jobsCreated: 0, occurrences: 0, skipped: 0, failures: [] };
  const failed = new Map<string, unknown>();
  const succeeded = new Set<string>();
  const fail = (planId: string, error: unknown) => {
    failed.set(planId, error);
    succeeded.delete(planId);
  };

  // Completion plans whose last job has finished.
  const waiting = (await tx.maintenance.waitingOnCompletion()).filter((plan) =>
    takes(plan, retriesOnly),
  );
  const lasts = await tx.maintenance.lastOccurrences(waiting.map((plan) => plan.id));
  for (const plan of waiting) {
    try {
      await tx.maintenance.isolated(async () => {
        const next = nextDueFor(plan, today, lasts.get(plan.id), timezone);
        if (next.nextDueOn !== null) {
          await tx.maintenance.advance(plan.id, next);
        }
      });
      succeeded.add(plan.id);
    } catch (error) {
      fail(plan.id, error);
    }
  }

  // What each due plan has to do, read before anything is written.
  const work = new Map<string, PlanWork>();
  for (const due of await tx.maintenance.dueForCreation(today)) {
    if (!takes(due.plan, retriesOnly) || failed.has(due.plan.id)) {
      continue;
    }
    try {
      work.set(due.plan.id, await planWork(tx, due, today));
    } catch (error) {
      fail(due.plan.id, error);
    }
  }

  // Plans whose due dates would share a job are written together; the rest alone.
  const groups = groupCandidates([...work.values()].flatMap((entry) => entry.candidates));
  for (const unit of unitsOf(work, groups)) {
    try {
      addCounts(made, await tx.maintenance.isolated(() => writeUnit(tx, unit, timezone)));
      for (const entry of unit) {
        succeeded.add(entry.due.plan.id);
      }
    } catch (error) {
      if (unit.length === 1) {
        fail(unit[0]!.due.plan.id, error);
        continue;
      }
      // Together they failed: each on its own, so only the bad one is held back.
      for (const entry of unit) {
        try {
          addCounts(made, await tx.maintenance.isolated(() => writeUnit(tx, [entry], timezone)));
          succeeded.add(entry.due.plan.id);
        } catch (alone) {
          fail(entry.due.plan.id, alone);
        }
      }
    }
  }

  const plans = new Map(
    (await tx.maintenance.findPlans([...failed.keys(), ...succeeded])).map((plan) => [
      plan.id,
      plan,
    ]),
  );
  for (const [planId, error] of failed) {
    const message = messageOf(error);
    await tx.maintenance.recordFailure(planId, message);
    made.failures.push({
      planId,
      message,
      failureCount: (plans.get(planId)?.failureCount ?? 0) + 1,
      error,
    });
  }
  for (const planId of succeeded) {
    if ((plans.get(planId)?.failureCount ?? 0) > 0) {
      await tx.maintenance.clearFailure(planId);
    }
  }
  return made;
}

function addCounts(made: MadeJobs, counts: Counts) {
  made.jobsCreated += counts.jobsCreated;
  made.occurrences += counts.occurrences;
  made.skipped += counts.skipped;
}

/** One plan's due dates up to today: those to skip, those to make, and where it goes next. */
async function planWork(tx: TenantTransaction, due: DuePlan, today: string): Promise<PlanWork> {
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
  const work: PlanWork = { due, skips: [], candidates: [], next: undefined };
  let dueOn = plan.nextDueOn;
  let sequence = plan.nextSequence;
  for (let caught = 0; dueOn !== null && caught < CATCH_UP_LIMIT; caught += 1) {
    if (creationDay(dueOn, plan.leadDays) > today || !withinPlan(dueOn, plan.endsOn, contractEnd)) {
      break;
    }
    if (plan.assetStatus === 'retired') {
      work.skips.push(dueOn);
    } else if (!(await tx.maintenance.hasOccurrence(plan.id, dueOn))) {
      work.candidates.push({
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
    work.next = next;
  }
  return work;
}

/**
 * Plans that must be written together: those whose due dates fall in one
 * group, and so one job, joined through every group they share.
 */
function unitsOf(work: Map<string, PlanWork>, groups: readonly CandidateGroup[]): PlanWork[][] {
  const unitOf = new Map<string, Set<string>>();
  for (const planId of work.keys()) {
    unitOf.set(planId, new Set([planId]));
  }
  for (const group of groups) {
    const planIds = (group.candidates as Candidate[]).map((candidate) => candidate.due.plan.id);
    const merged = new Set(planIds.flatMap((planId) => [...unitOf.get(planId)!]));
    for (const planId of merged) {
      unitOf.set(planId, merged);
    }
  }
  return [...new Set(unitOf.values())].map((planIds) => [...planIds].map((id) => work.get(id)!));
}

/** Writes some plans' skips, jobs and next due dates, as {@link makeJobs} decided. */
async function writeUnit(
  tx: TenantTransaction,
  unit: readonly PlanWork[],
  timezone: string,
): Promise<Counts> {
  const counts: Counts = { jobsCreated: 0, occurrences: 0, skipped: 0 };
  for (const entry of unit) {
    for (const dueOn of entry.skips) {
      if (
        await tx.maintenance.recordOccurrence({
          planId: entry.due.plan.id,
          dueOn,
          workOrderId: null,
          skipReason: 'asset_retired',
        })
      ) {
        counts.skipped += 1;
      }
    }
    if (entry.next !== undefined) {
      await tx.maintenance.advance(entry.due.plan.id, entry.next);
    }
  }

  for (const group of groupCandidates(unit.flatMap((entry) => entry.candidates))) {
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
            : { instructions: [...new Set(instructions)].join(PARAGRAPH).slice(0, 10000) }),
          dueFrom,
          dueBy,
          assetIds: members.map((member) => member.due.plan.assetId),
          maintenance: { contractId: plan.contractId },
        },
        plan.createdBy,
      );
      workOrderId = job.id;
      counts.jobsCreated += 1;
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
        counts.occurrences += 1;
      }
    }
  }
  return counts;
}

async function renewalReminders(
  tenant: { id: string; name: string },
  now: Date,
  options: TaskOptions,
): Promise<number> {
  const prepared = await withTenant(tenant.id, async (tx) => {
    const { timezone, locale } = await tx.settings.get();
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
    return { alerts, managers, items, locale: messageLocale(locale) };
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
          locale: prepared.locale,
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
  // Emails go in the company's language; each phone's push in its own.
  const locale = messageLocale(settings.locale);
  const when = momentFormatter(locale, settings.timezone);
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
        deadlineAlertEmail({ to: member.email, companyName: tenant.name, items, url, locale }),
        { kind: 'deadline_alert', tenantId: tenant.id },
      );
    }
  }

  if (options.push !== undefined) {
    const phones = new Map<string, (typeof devices)[number][]>();
    for (const device of devices) {
      phones.set(device.userId, [...(phones.get(device.userId) ?? []), device]);
    }
    const messages: PushMessage[] = notices.flatMap((notice) => {
      const job = jobById.get(notice.workOrderId);
      if (job === undefined) {
        return [];
      }
      const label = { job: formatWorkOrderReference(job.reference) };
      const title = (words: NotificationWords['push']) =>
        fill(
          notice.kind === 'response'
            ? notice.stage === 'missed'
              ? words.responseDeadlineMissed
              : words.responseDeadlineSoon
            : notice.stage === 'missed'
              ? words.completionDeadlineMissed
              : words.completionDeadlineSoon,
          label,
        );
      return (crews.get(notice.workOrderId) ?? []).flatMap((member) =>
        (phones.get(member.userId) ?? []).map((device) => ({
          to: device.token,
          title: title(wordsFor(messageLocale(device.locale)).push),
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
