import { holds, formatWorkOrderReference } from '@integr8/core';
import { withTenant } from '@integr8/db';
import { z } from 'zod';
import { forbidden, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { shiftBody } from '../../sync/pull.js';
import { peopleOf, personBody, personSchema, workOrderStateSchema } from './operations.js';
import { submitLocationSchema } from './submissions.js';

/**
 * Time (P14): the working day and the time spent on each job.
 *
 * A shift is clocked in and out on the phone. Time on a job is not recorded
 * separately: it is the job's own history — setting off, arriving, starting,
 * waiting for parts, finishing — each stamped with when the engineer's phone
 * recorded it. `jobTimes` in `@integr8/core` adds those up the same way on every
 * screen, so a timesheet here returns the raw facts and never a total of its own.
 */

const TAGS = ['time'];
const MAX_WINDOW_DAYS = 62;

export const shiftSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  startLocation: submitLocationSchema.nullable(),
  endLocation: submitLocationSchema.nullable(),
});

export const timesheetRoute = defineRoute({
  method: 'get',
  path: '/v1/timesheets',
  operationId: 'getTimesheet',
  summary: 'Shifts and time on jobs in a window',
  description:
    'Every shift that overlaps the window, and the jobs worked in it: each job’s state changes in the window, whoever made them, with the last change before the window so a job already under way is counted from the window’s start, and who was on its crew. For one person, the jobs they changed or were on the crew of; for the office, everyone’s. Totals are for the client to add up with `jobTimes` and `shiftDurationMs` from `@integr8/core`. An engineer may read only their own. At most 62 days; `truncated` says the window held more changes than were returned.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  params: noSchema,
  query: z.object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    userId: z.uuid().optional(),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'The window’s shifts and state changes.',
      schema: z.object({
        people: z.array(personSchema),
        shifts: z.array(shiftSchema),
        changes: z.array(
          z.object({
            workOrderId: z.uuid(),
            fromState: workOrderStateSchema,
            toState: workOrderStateSchema,
            actorId: z.uuid(),
            occurredAt: z.string(),
            recordedAt: z.string(),
          }),
        ),
        workOrders: z.array(
          z.object({
            id: z.uuid(),
            referenceLabel: z.string(),
            title: z.string(),
            state: workOrderStateSchema,
          }),
        ),
        /** Who was on each job's crew at some point in the window. */
        crews: z.array(z.object({ workOrderId: z.uuid(), userId: z.uuid() })),
        truncated: z.boolean(),
      }),
    },
    403: { description: 'Only the office may read someone else’s time.' },
    422: { description: 'The window ends before it starts, or is longer than 62 days.' },
  },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (to <= from || to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
      throw unprocessable('invalid_window', 'Choose a window of up to 62 days.', [
        { field: 'query.to', code: 'invalid_window', message: 'After from, and within 62 days.' },
      ]);
    }
    const office = holds(principal, 'work_order.manage');
    const userId = query.userId ?? (office ? undefined : principal.userId);
    if (!office && userId !== principal.userId) {
      throw forbidden('Only the office can see someone else’s time.');
    }

    const body = await withTenant(principal.tenantId, async (tx) => {
      const [shifts, worked, people] = await Promise.all([
        tx.shifts.list({ from, to, ...(userId === undefined ? {} : { userId }) }),
        tx.workOrders.listTransitions({ from, to, ...(userId === undefined ? {} : { userId }) }),
        peopleOf(tx),
      ]);
      const transitions = worked.changes;
      const jobs = await tx.workOrders.findMany([
        ...new Set(transitions.map((change) => change.workOrderId)),
      ]);
      const involved = new Set(
        [
          ...shifts.map((shift) => shift.userId as string),
          ...transitions.map((change) => change.actorId as string),
          ...worked.crews.map((member) => member.userId),
        ].filter((id) => userId === undefined || id === userId),
      );
      return {
        people: [...involved].map((id) => personBody(id, people)),
        shifts: shifts.map(shiftBody),
        changes: transitions.flatMap((change) =>
          change.fromState === null || change.toState === null
            ? []
            : [
                {
                  workOrderId: change.workOrderId,
                  fromState: change.fromState,
                  toState: change.toState,
                  actorId: change.actorId,
                  occurredAt: change.occurredAt.toISOString(),
                  recordedAt: change.recordedAt.toISOString(),
                },
              ],
        ),
        workOrders: jobs.map((job) => ({
          id: job.id,
          referenceLabel: formatWorkOrderReference(job.reference),
          title: job.title,
          state: job.state,
        })),
        crews: worked.crews,
        truncated: worked.truncated,
      };
    });
    return { status: 200, body };
  },
});

export const registerPushDeviceRoute = defineRoute({
  method: 'put',
  path: '/v1/me/push-device',
  operationId: 'registerPushDevice',
  summary: 'Receive push notifications on this phone',
  description:
    'Registers the phone’s Expo push token for the signed-in person, tied to this session: signing out, or the session being revoked, stops notifications to it. Registering a token already registered moves it to this person and session.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  params: noSchema,
  query: noSchema,
  body: z.object({
    token: z
      .string()
      .regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/u, 'An Expo push token'),
    platform: z.enum(['ios', 'android']),
    deviceLabel: z.string().trim().max(200).nullable().optional(),
  }),
  responses: { 204: { description: 'Registered.' } },
  handler: async ({ body }, context) => {
    const { principal } = context;
    await withTenant(principal.tenantId, (tx) =>
      tx.pushDevices.register({
        userId: principal.userId,
        sessionId: principal.sessionId,
        token: body.token,
        platform: body.platform,
        deviceLabel: body.deviceLabel ?? null,
      }),
    );
    return { status: 204, body: undefined };
  },
});

/**
 * A POST, not a DELETE with a body: DELETE bodies are not part of the contract,
 * and the token does not belong in a URL, where access logs would keep it.
 */
export const unregisterPushDeviceRoute = defineRoute({
  method: 'post',
  path: '/v1/me/push-device/unregister',
  operationId: 'unregisterPushDevice',
  summary: 'Stop push notifications to this phone',
  description: 'For the phone’s own person only. Signing out does this too.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  params: noSchema,
  query: noSchema,
  body: z.object({ token: z.string().max(260) }),
  responses: { 204: { description: 'Stopped, or was not registered.' } },
  handler: async ({ body }, context) => {
    const { principal } = context;
    await withTenant(principal.tenantId, (tx) =>
      tx.pushDevices.disable(body.token, 'signed_out', principal.userId),
    );
    return { status: 204, body: undefined };
  },
});

export const timeRoutes = [timesheetRoute, registerPushDeviceRoute, unregisterPushDeviceRoute];
