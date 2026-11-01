import { formatWorkOrderReference, type UserId } from '@integr8/core';
import { type TenantTransaction, type WorkOrder, withTenant } from '@integr8/db';
import type { Logger } from '../http/logger.js';
import { fill, messageLocale, type NotificationWords, wordsFor } from '../notifications/words.js';
import type { PushMessage, PushSender } from './sender.js';

/**
 * Telling a crew about their work (P14).
 *
 * Migration 0013 queues a job for every event that could matter — an assignment,
 * a reschedule, a dispatch or cancellation, a priority change — in the same
 * transaction as the change, so a notification is never sent for a change that
 * rolled back and never lost for one that committed. This decides who hears and
 * what they read:
 *
 * - **Assigned:** the person assigned. "Urgent callout" when the job is urgent.
 * - **Rescheduled, dispatched, cancelled:** everyone on the crew.
 * - **Priority changed:** the crew, only when the job became urgent.
 * - **Visits (P25):** a person put on a visit, or taken off one, hears it; the
 *   people on a visit hear when it moves or is called off. Someone added to the
 *   crew and a visit in one change hears about the visit only. A visit called
 *   off because its job closed, or taken off someone who left the crew, is
 *   covered by the job's own message and never queued (migration 0051).
 *
 * Each phone reads it in the language it registered with, English when it did
 * not say (`push_devices.locale`; see notifications/words.ts).
 *
 * Whoever made the change is not told about it. A notification names the job
 * and its site and nothing else about the customer: it can be read from a locked
 * phone. Times are left to the job screen, which shows them in the phone's own
 * time zone; the server has none to write them in.
 */

export const WORK_ORDER_PUSH_QUEUE = 'push.work_order_event';
export const PUSH_RECEIPTS_QUEUE = 'push.receipts';
/** Receipts are ready some minutes after sending; Expo keeps them for a day. */
export const RECEIPT_DELAY_MS = 15 * 60 * 1000;

export type NotifyOutcome =
  | { outcome: 'sent'; messages: number; failed: number }
  | { outcome: 'nobody' }
  | { outcome: 'gone' };

type PushWords = NotificationWords['push'];

interface Plan {
  recipients: UserId[];
  /** Written per phone, in the language it registered with. */
  text: (words: PushWords) => { title: string; body: string };
  urgent: boolean;
}

async function plan(
  tx: TenantTransaction,
  event: NonNullable<Awaited<ReturnType<TenantTransaction['workOrders']['findEvent']>>>,
  job: WorkOrder,
): Promise<Plan | undefined> {
  const crew = (await tx.workOrders.listCrew(job.id)).map((member) => member.userId);
  const others = (people: readonly UserId[]) => people.filter((person) => person !== event.actorId);
  const site = await tx.sites.find(job.siteId);
  const label = { job: `${formatWorkOrderReference(job.reference)} · ${job.title}` };
  const where = site?.name ?? '';
  const urgent = job.priority === 'urgent';
  const closed = ['complete', 'reviewed', 'cancelled'].includes(job.state);

  const visitId = typeof event.details.visitId === 'string' ? event.details.visitId : null;
  const visit = visitId === null ? undefined : await tx.visits.find(visitId);
  const onVisit = visit?.status === 'planned' ? visit.assigneeIds : [];
  const openJob = (words: PushWords) =>
    where === '' ? words.openForTime : fill(words.openForTimeAt, { site: where });
  const titled =
    (title: (words: PushWords) => string, body: (words: PushWords) => string) =>
    (words: PushWords) => ({ title: fill(title(words), label), body: body(words) });
  const atSite = () => where;

  switch (event.kind) {
    case 'assigned':
      if (closed || event.userId === null || !crew.includes(event.userId)) {
        return undefined;
      }
      if (await alsoPutOnVisit(tx, job.id, event)) {
        return undefined;
      }
      return {
        recipients: others([event.userId]),
        text: titled((words) => (urgent ? words.urgentCallout : words.newJob), atSite),
        urgent,
      };
    case 'rescheduled':
      return closed
        ? undefined
        : {
            recipients: others(crew),
            text: titled(
              (words) => words.rescheduled,
              (words) =>
                where === '' ? words.openForNewTime : fill(words.openForNewTimeAt, { site: where }),
            ),
            urgent,
          };
    case 'transitioned':
      if (event.toState === 'dispatched' && job.state === 'dispatched') {
        return {
          recipients: others(crew),
          text: titled((words) => words.dispatched, atSite),
          urgent,
        };
      }
      if (event.toState === 'cancelled') {
        return {
          recipients: others(crew),
          text: titled(
            (words) => words.cancelled,
            () => event.reason ?? where,
          ),
          urgent: false,
        };
      }
      return undefined;
    case 'updated':
      return urgent && !closed
        ? {
            recipients: others(crew),
            text: titled((words) => words.nowUrgent, atSite),
            urgent: true,
          }
        : undefined;
    case 'visit_assigned':
      if (closed || event.userId === null || !onVisit.includes(event.userId)) {
        return undefined;
      }
      return {
        recipients: others([event.userId]),
        text: titled((words) => (urgent ? words.urgentVisit : words.newVisit), openJob),
        urgent,
      };
    case 'visit_rescheduled':
      return closed || onVisit.length === 0
        ? undefined
        : {
            recipients: others(onVisit),
            text: titled((words) => words.visitMoved, openJob),
            urgent,
          };
    case 'visit_cancelled':
      return visit === undefined || closed
        ? undefined
        : {
            recipients: others(visit.assigneeIds),
            text: titled(
              (words) => words.visitCancelled,
              () => event.reason ?? where,
            ),
            urgent: false,
          };
    case 'visit_unassigned':
      return closed || event.userId === null
        ? undefined
        : {
            recipients: others([event.userId]),
            text: titled((words) => words.takenOffVisit, atSite),
            urgent: false,
          };
    default:
      return undefined;
  }
}

/**
 * Whether the person was put on one of the job's visits in the same change that
 * put them on its crew: events from one transaction share `occurredAt`.
 */
async function alsoPutOnVisit(
  tx: TenantTransaction,
  workOrderId: string,
  event: { userId: UserId | null; occurredAt: Date },
): Promise<boolean> {
  const events = await tx.workOrders.listEvents(workOrderId);
  return events.some(
    (other) =>
      other.kind === 'visit_assigned' &&
      other.userId === event.userId &&
      other.occurredAt.getTime() === event.occurredAt.getTime(),
  );
}

export async function notifyWorkOrderEvent(
  sender: PushSender,
  tenantId: string,
  eventId: string,
  logger: Logger,
): Promise<NotifyOutcome> {
  const prepared = await withTenant(tenantId, async (tx) => {
    const event = await tx.workOrders.findEvent(eventId);
    const job = event === undefined ? undefined : await tx.workOrders.find(event.workOrderId);
    if (event === undefined || job === undefined) {
      return 'gone' as const;
    }
    const decided = await plan(tx, event, job);
    if (decided === undefined || decided.recipients.length === 0) {
      return 'nobody' as const;
    }
    const devices = await tx.pushDevices.activeFor(decided.recipients);
    const messages: PushMessage[] = devices.map((device) => ({
      to: device.token,
      ...decided.text(wordsFor(messageLocale(device.locale)).push),
      data: {
        workOrderId: job.id,
        event: event.kind,
        ...(typeof event.details.visitId === 'string' ? { visitId: event.details.visitId } : {}),
      },
      channelId: decided.urgent ? 'urgent' : 'jobs',
      priority: decided.urgent ? 'high' : 'default',
    }));
    return messages;
  });
  if (prepared === 'gone' || prepared === 'nobody') {
    return { outcome: prepared };
  }
  if (prepared.length === 0) {
    return { outcome: 'nobody' };
  }

  const tickets = await sender.send(prepared);
  const pending: { id: string; token: string }[] = [];
  let failed = 0;
  await withTenant(tenantId, async (tx) => {
    for (const [index, ticket] of tickets.entries()) {
      const token = prepared[index]!.to;
      if (ticket.status === 'ok') {
        pending.push({ id: ticket.id, token });
        continue;
      }
      failed += 1;
      if (ticket.notRegistered) {
        await tx.pushDevices.disable(token, 'not_registered');
      } else {
        logger.warn('Push refused', { eventId, message: ticket.message });
      }
    }
    if (pending.length > 0) {
      await tx.jobs.enqueue({
        queue: PUSH_RECEIPTS_QUEUE,
        payload: { tickets: pending },
        availableAt: new Date(Date.now() + RECEIPT_DELAY_MS),
        maxAttempts: 3,
      });
    }
  });
  return { outcome: 'sent', messages: prepared.length, failed };
}

/** Disables phones whose receipts say the app is gone. Returns how many. */
export async function checkReceipts(
  sender: PushSender,
  tenantId: string,
  tickets: readonly { id: string; token: string }[],
  logger: Logger,
): Promise<number> {
  const receipts = await sender.receipts(tickets.map((ticket) => ticket.id));
  let disabled = 0;
  await withTenant(tenantId, async (tx) => {
    for (const ticket of tickets) {
      const receipt = receipts.get(ticket.id);
      if (receipt?.status !== 'error') {
        continue;
      }
      if (receipt.notRegistered) {
        if (await tx.pushDevices.disable(ticket.token, 'not_registered')) {
          disabled += 1;
        }
      } else {
        logger.warn('Push not delivered', { ticketId: ticket.id, message: receipt.message });
      }
    }
  });
  return disabled;
}
