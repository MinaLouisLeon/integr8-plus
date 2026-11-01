import {
  addDays,
  calendarDay,
  type CustomRoleOverlay,
  formatWorkOrderReference,
  holds,
} from '@integr8/core';
import {
  type ExpiryAlert,
  getPlatformDataSource,
  type PushDevice,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import type { ApiConfig } from '../config.js';
import { deliver } from '../email/deliver.js';
import { qualificationsUrl } from '../email/links.js';
import { type ExpiryItem, qualificationExpiryEmail } from '../email/messages.js';
import type { EmailSender } from '../email/sender.js';
import type { Logger } from '../http/logger.js';
import type { PushMessage, PushSender } from '../push/sender.js';
import {
  fill,
  type MessageLocale,
  messageLocale,
  momentFormatter,
  wordsFor,
} from '../notifications/words.js';

/**
 * Certificate expiry alerts (P26).
 *
 * Once a day, for every company: certificates expiring within the company's
 * warning period are announced once, and certificates that have lapsed are
 * announced once more, with the planned visits that now lack them. The holder
 * hears by email and on their phone; the people who keep the records
 * (`qualification.manage`) get one email listing everything.
 *
 * A certificate already renewed — another record of the same qualification
 * lasting longer — is marked and passed over, and so is one held by somebody
 * no longer active. An alert that could not be sent is not retried: like
 * dunning's, it is allowed to fail, and the screens show the same thing.
 *
 * Same shape as the other daily runs: no cron, a turn claimed in
 * `scheduled_task_runs` so several workers make one run.
 */

export const QUALIFICATION_EXPIRY_TASK = 'qualifications.expiry';

const DAILY = { hours: 20 } as const;

/** How far ahead a lapse looks for planned visits that now lack the certificate. */
const AFFECTED_VISIT_DAYS = 60;

export interface QualificationExpiryReport {
  companies: number;
  warned: number;
  lapsed: number;
  passedOver: number;
  failures: { tenantId: string; message: string }[];
}

export interface QualificationExpiryOptions {
  config: ApiConfig;
  logger: Logger;
  email?: EmailSender;
  push?: PushSender;
  workerId: string;
  now?: Date;
  /** Skips the turn-claiming, for tests. */
  force?: boolean;
}

export async function runQualificationExpiry(
  options: QualificationExpiryOptions,
): Promise<QualificationExpiryReport> {
  const report: QualificationExpiryReport = {
    companies: 0,
    warned: 0,
    lapsed: 0,
    passedOver: 0,
    failures: [],
  };
  const platform = getPlatformDataSource();
  const claimed =
    options.force === true ||
    (await platform.metering.claimTask(QUALIFICATION_EXPIRY_TASK, DAILY, options.workerId));
  if (!claimed) {
    return report;
  }

  try {
    const tenants = (await platform.tenants.list()).filter(
      (tenant) => tenant.status === 'active' && tenant.deletedAt === null,
    );
    for (const tenant of tenants) {
      try {
        const outcome = await alertCompany(tenant.id, tenant.name, options);
        if (outcome.warned + outcome.lapsed + outcome.passedOver > 0) {
          report.companies += 1;
        }
        report.warned += outcome.warned;
        report.lapsed += outcome.lapsed;
        report.passedOver += outcome.passedOver;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.failures.push({ tenantId: tenant.id, message });
        options.logger.error('Qualification expiry failed for a company', {
          tenantId: tenant.id,
          error: message,
        });
      }
    }
    await platform.metering.finishTask(QUALIFICATION_EXPIRY_TASK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await platform.metering.finishTask(QUALIFICATION_EXPIRY_TASK, message);
    throw error;
  }
  return report;
}

interface Person {
  userId: string;
  name: string;
  email: string;
}

interface Prepared {
  alerts: ExpiryAlert[];
  passedOver: { id: string; stage: 'warning' | 'lapsed' }[];
  holders: Map<string, Person>;
  managers: Person[];
  affected: Map<string, string[]>;
  /** Each holder's phones, with the language each reads in. */
  phones: Map<string, PushDevice[]>;
  /** The company's language, which its emails are written in. */
  locale: MessageLocale;
}

async function alertCompany(
  tenantId: string,
  companyName: string,
  options: QualificationExpiryOptions,
): Promise<{ warned: number; lapsed: number; passedOver: number }> {
  const now = options.now ?? new Date();
  const prepared = await withTenant(tenantId, (tx) => prepare(tx, now));
  if (prepared.alerts.length === 0 && prepared.passedOver.length === 0) {
    return { warned: 0, lapsed: 0, passedOver: 0 };
  }

  await send(tenantId, companyName, prepared, options);

  await withTenant(tenantId, async (tx) => {
    for (const stage of ['warning', 'lapsed'] as const) {
      await tx.qualifications.markAlerted(
        [
          ...prepared.alerts
            .filter((alert) => alert.stage === stage)
            .map((alert) => alert.record.id),
          ...prepared.passedOver.filter((entry) => entry.stage === stage).map((entry) => entry.id),
        ],
        stage,
      );
    }
  });
  return {
    warned: prepared.alerts.filter((alert) => alert.stage === 'warning').length,
    lapsed: prepared.alerts.filter((alert) => alert.stage === 'lapsed').length,
    passedOver: prepared.passedOver.length,
  };
}

async function prepare(tx: TenantTransaction, now: Date): Promise<Prepared> {
  const settings = await tx.settings.get();
  const today = calendarDay(now, settings.timezone);
  const due = await tx.qualifications.dueExpiryAlerts(
    today,
    addDays(today, settings.qualificationWarningDays),
  );
  const empty: Prepared = {
    alerts: due.alerts,
    passedOver: due.renewed,
    holders: new Map(),
    managers: [],
    affected: new Map(),
    phones: new Map(),
    locale: messageLocale(settings.locale),
  };
  if (due.alerts.length === 0) {
    return empty;
  }

  const members = (await tx.tenantUsers.list()).filter((member) => member.status === 'active');
  const [roles, grants] = await Promise.all([
    tx.tenantRoles.list({ includeArchived: true }),
    tx.memberGrants.forUsers(members.map((member) => member.userId)),
  ]);
  const overlay = new Map<string, CustomRoleOverlay>(
    roles.map((role) => [role.id, { id: role.id, added: role.added, removed: role.removed }]),
  );
  const managers = members
    .filter((member) =>
      holds(
        {
          role: member.role,
          grants: grants.get(member.userId) ?? [],
          customRole: member.customRoleId === null ? undefined : overlay.get(member.customRoleId),
        },
        'qualification.manage',
      ),
    )
    .map((member) => ({ userId: member.userId, name: member.displayName, email: member.email }));
  const holders = new Map(
    members.map((member) => [
      member.userId as string,
      { userId: member.userId, name: member.displayName, email: member.email },
    ]),
  );

  // Planned visits from now that a lapse leaves without the certificate.
  const affected = new Map<string, string[]>();
  for (const alert of due.alerts.filter((entry) => entry.stage === 'lapsed')) {
    const visits = (
      await tx.visits.listInRange({
        from: now,
        to: new Date(now.getTime() + AFFECTED_VISIT_DAYS * 24 * 60 * 60 * 1000),
        userIds: [alert.record.userId],
      })
    ).filter((visit) => visit.status === 'planned');
    if (visits.length === 0) {
      continue;
    }
    const requirements = await tx.qualifications.workOrderRequirements(
      visits.map((visit) => visit.workOrderId),
    );
    const needing = visits.filter((visit) =>
      (requirements.get(visit.workOrderId) ?? []).some(
        (requirement) => requirement.qualificationTypeId === alert.record.qualificationTypeId,
      ),
    );
    if (needing.length === 0) {
      continue;
    }
    const jobs = new Map(
      (await tx.workOrders.findMany(needing.map((visit) => visit.workOrderId))).map((job) => [
        job.id,
        job,
      ]),
    );
    const when = momentFormatter(empty.locale, settings.timezone);
    const words = wordsFor(empty.locale).email.certificates;
    affected.set(
      alert.record.id,
      needing.map((visit) => {
        const job = jobs.get(visit.workOrderId);
        const label =
          job === undefined
            ? words.aJob
            : `${formatWorkOrderReference(job.reference)} ${job.title}`;
        return fill(words.visit, { job: label, when: when.format(visit.startsAt) });
      }),
    );
  }

  const devices = await tx.pushDevices.activeFor([
    ...new Set(due.alerts.map((alert) => alert.record.userId)),
  ]);
  const phones = new Map<string, PushDevice[]>();
  for (const device of devices) {
    phones.set(device.userId, [...(phones.get(device.userId) ?? []), device]);
  }

  return { ...empty, holders, managers, affected, phones };
}

async function send(
  tenantId: string,
  companyName: string,
  prepared: Prepared,
  options: QualificationExpiryOptions,
): Promise<void> {
  const alerts = prepared.alerts.filter((alert) => prepared.holders.has(alert.record.userId));
  if (alerts.length === 0) {
    return;
  }
  const item = (alert: ExpiryAlert, withPerson: boolean): ExpiryItem => ({
    ...(withPerson ? { person: prepared.holders.get(alert.record.userId)?.name ?? '' } : {}),
    qualification: alert.typeName,
    expiresOn: alert.record.expiresOn ?? '',
    stage: alert.stage,
    affectedVisits: prepared.affected.get(alert.record.id) ?? [],
  });

  if (options.email !== undefined) {
    const url = qualificationsUrl(options.config.WEB_APP_URL);
    for (const manager of prepared.managers) {
      await deliver(
        options.email,
        options.logger,
        qualificationExpiryEmail({
          to: manager.email,
          companyName,
          items: alerts.map((alert) => item(alert, true)),
          own: false,
          url,
          locale: prepared.locale,
        }),
        { kind: 'qualification_expiry', tenantId },
      );
    }
    const byHolder = new Map<string, ExpiryAlert[]>();
    for (const alert of alerts) {
      byHolder.set(alert.record.userId, [...(byHolder.get(alert.record.userId) ?? []), alert]);
    }
    // The holder hears in their own words, managers included.
    for (const [userId, own] of byHolder) {
      const holder = prepared.holders.get(userId);
      if (holder === undefined) {
        continue;
      }
      await deliver(
        options.email,
        options.logger,
        qualificationExpiryEmail({
          to: holder.email,
          companyName,
          items: own.map((alert) => item(alert, false)),
          own: true,
          url: null,
          locale: prepared.locale,
        }),
        { kind: 'qualification_expiry', tenantId },
      );
    }
  }

  if (options.push !== undefined) {
    const messages: PushMessage[] = alerts.flatMap((alert) =>
      (prepared.phones.get(alert.record.userId) ?? []).map((device) => {
        const words = wordsFor(messageLocale(device.locale)).push;
        const qualification = { qualification: alert.typeName };
        return {
          to: device.token,
          title: fill(
            alert.stage === 'lapsed' ? words.certificateExpired : words.certificateExpiring,
            qualification,
          ),
          body:
            alert.stage === 'lapsed'
              ? words.certificateExpiredBody
              : fill(words.certificateExpiringBody, { date: alert.record.expiresOn ?? '' }),
          data: { kind: 'qualification_expiry', qualificationId: alert.record.id },
          channelId: 'jobs' as const,
          priority: 'default' as const,
        };
      }),
    );
    if (messages.length > 0) {
      try {
        await options.push.send(messages);
      } catch (error) {
        options.logger.warn('Qualification expiry push failed', {
          tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
