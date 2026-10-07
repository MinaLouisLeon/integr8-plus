import { getPlatformDataSource } from '@integr8/db';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../http/logger.js';
import { buildJobHandlers } from '../../jobs/handlers.js';
import type { RecordingPushSender } from '../../push/sender.js';
import { type ApiHarness, type Member, startApi } from '../../testing/api-harness.js';

/**
 * Running a job through the API (P14), against a real database: before and after
 * photos and the customer's sign-off gating completion, time recorded from what
 * the phone says happened, timesheets, and push notifications to the crew.
 */

let api: ApiHarness;
let tokens: Record<'owner' | 'builder' | 'dispatcher' | 'engineer' | 'colleague', string>;
let people: Record<'owner' | 'dispatcher' | 'engineer' | 'colleague', Member>;
let jobTypeId: string;
let customerId: string;
let siteId: string;

const logger = createLogger({ level: 'error', write: () => undefined });
const json = <T>(response: { body: string }) => JSON.parse(response.body) as T;

interface ErrorBody {
  error: { code: string; message: string; details?: { field: string; code: string }[] };
}

interface Detail {
  workOrder: { id: string; state: string; revision: number };
  attachments: { id: string; stage: string | null; kind: string }[];
  events: { kind: string; toState: string | null; occurredAt: string; recordedAt: string }[];
  execution: {
    beforePhotos: number;
    afterPhotos: number;
    signatureRequired: boolean;
    signoff: { name: string | null; unavailableReason: string | null } | null;
    missing: { forms: unknown[]; beforePhotos: number; afterPhotos: number; signoff: boolean };
  };
}

async function call<T>(
  token: string,
  method: string,
  url: string,
  payload?: unknown,
  expected = 200,
): Promise<T> {
  const response = await api.call(token, {
    method: method as 'GET',
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(expected);
  return (response.body === '' ? undefined : json<T>(response)) as T;
}

async function upload(token: string, contentType = 'image/jpeg', bytes = 2_000) {
  const created = await call<{
    media: { id: string };
    upload: { url: string; headers: Record<string, string> };
  }>(token, 'POST', '/v1/media', { contentType, byteSize: bytes }, 201);
  const target = new URL(created.upload.url);
  const put = await api.app.inject({
    remoteAddress: api.remoteAddress,
    method: 'PUT',
    url: target.pathname + target.search,
    headers: created.upload.headers,
    payload: randomBytes(bytes),
  });
  expect(put.statusCode, put.body).toBe(200);
  await call(token, 'POST', `/v1/media/${created.media.id}/complete`);
  return created.media.id;
}

async function runJobs(queue: string) {
  const handlers = buildJobHandlers(api.services);
  // The test database is shared: other suites leave jobs of their own companies,
  // which stay leased here and are never run. Claim until nothing is left.
  for (;;) {
    const claimed = await getPlatformDataSource().jobs.claim({ workerId: 'test', limit: 50 });
    if (claimed.length === 0) {
      return;
    }
    for (const job of claimed.filter((candidate) => candidate.tenantId === api.tenantId)) {
      if (job.queue === queue) {
        await handlers[queue]!(job.payload, {
          tenantId: job.tenantId,
          jobId: job.id,
          attempt: job.attempts,
          logger,
        });
      }
      await getPlatformDataSource().jobs.complete(job.id);
    }
  }
}

const newJob = async (crew: Member[], extra: Record<string, unknown> = {}) =>
  call<Detail>(
    tokens.dispatcher,
    'POST',
    '/v1/work-orders',
    {
      customerId,
      siteId,
      jobTypeId,
      crew: crew.map((member, index) => ({ userId: member.userId, lead: index === 0 })),
      ...extra,
    },
    201,
  );

const move = (token: string, job: Detail, to: string, expected = 200) =>
  api
    .call(token, {
      method: 'POST',
      url: `/v1/work-orders/${job.workOrder.id}/transitions`,
      payload: { to, expectedRevision: job.workOrder.revision },
    })
    .then((response) => {
      expect(response.statusCode, response.body).toBe(expected);
      return response;
    });

beforeAll(async () => {
  api = await startApi();
  people = {
    owner: await api.member('owner', 'owner'),
    dispatcher: await api.member('dispatcher', 'dispatcher'),
    engineer: await api.member('engineer', 'engineer'),
    colleague: await api.member('engineer', 'colleague'),
  };
  tokens = {
    owner: await api.signIn(people.owner),
    builder: await api.staff(people.owner),
    dispatcher: await api.signIn(people.dispatcher),
    engineer: await api.signIn(people.engineer),
    colleague: await api.signIn(people.colleague),
  };
  const type = await call<{
    id: string;
    beforePhotos: number;
    afterPhotos: number;
    signatureRequired: boolean;
  }>(
    tokens.builder,
    'POST',
    '/v1/job-types',
    {
      name: 'Boiler service',
      code: 'boiler',
      beforePhotos: 1,
      afterPhotos: 1,
      signatureRequired: true,
    },
    201,
  );
  expect(type).toMatchObject({ beforePhotos: 1, afterPhotos: 1, signatureRequired: true });
  jobTypeId = type.id;
  customerId = (
    await call<{ id: string }>(
      tokens.dispatcher,
      'POST',
      '/v1/customers',
      { name: 'Riverside' },
      201,
    )
  ).id;
  siteId = (
    await call<{ id: string }>(
      tokens.dispatcher,
      'POST',
      `/v1/customers/${customerId}/sites`,
      { name: 'Block A', address: { line1: '1 River Road' } },
      201,
    )
  ).id;
});

afterAll(async () => {
  await api.close();
});

describe('completing a job', () => {
  it('says exactly what is missing, and completes once the photos and sign-off are there', async () => {
    let job = await newJob([people.engineer]);
    expect(job.execution).toMatchObject({
      beforePhotos: 1,
      afterPhotos: 1,
      signatureRequired: true,
      signoff: null,
      missing: { forms: [], beforePhotos: 1, afterPhotos: 1, signoff: true },
    });
    for (const to of ['dispatched', 'on_site', 'in_progress']) {
      job = json<Detail>(
        await move(to === 'dispatched' ? tokens.dispatcher : tokens.engineer, job, to),
      );
    }

    const refused = json<ErrorBody>(await move(tokens.engineer, job, 'complete', 409));
    expect(refused.error.code).toBe('completion_blocked');
    expect(refused.error.message).toBe(
      "Before completing this job, take 1 more before photo, take 1 more after photo, get the customer's sign-off.",
    );
    expect(refused.error.details?.map((detail) => detail.code)).toEqual([
      'photos_missing',
      'photos_missing',
      'signoff_missing',
    ]);

    // Photos with a stage go on the job; a stage anywhere else is refused.
    for (const stage of ['before', 'after']) {
      await call(
        tokens.engineer,
        'POST',
        '/v1/attachments',
        {
          owner: { workOrderId: job.workOrder.id },
          fileId: await upload(tokens.engineer),
          title: stage,
          stage,
        },
        201,
      );
    }
    const onSite = json<ErrorBody>(
      await api.call(tokens.dispatcher, {
        method: 'POST',
        url: '/v1/attachments',
        payload: {
          owner: { siteId },
          fileId: await upload(tokens.dispatcher),
          title: 'x',
          stage: 'before',
        },
      }),
    );
    expect(onSite.error.code).toBe('stage_not_allowed');

    // Only the crew signs off: to anyone else the job is not there.
    await call(
      tokens.colleague,
      'PUT',
      `/v1/work-orders/${job.workOrder.id}/signoff`,
      { unavailableReason: 'x' },
      404,
    );
    const signed = await call<Detail>(
      tokens.engineer,
      'PUT',
      `/v1/work-orders/${job.workOrder.id}/signoff`,
      {
        fileId: await upload(tokens.engineer, 'image/png'),
        name: 'Mrs Patel',
        role: 'Tenant',
      },
    );
    expect(signed.execution).toMatchObject({
      signoff: { name: 'Mrs Patel' },
      missing: { beforePhotos: 0, afterPhotos: 0, signoff: false },
    });
    expect(signed.attachments.map((attachment) => attachment.stage).sort()).toEqual([
      'after',
      'before',
    ]);

    const done = json<Detail>(await move(tokens.engineer, signed, 'complete'));
    expect(done.workOrder.state).toBe('complete');
    expect(done.events.map((event) => event.kind)).toContain('signed_off');
    await call(
      tokens.engineer,
      'PUT',
      `/v1/work-orders/${job.workOrder.id}/signoff`,
      { unavailableReason: 'Too late' },
      409,
    );
  });
});

describe('time', () => {
  const push = (token: string, mutations: Record<string, unknown>[], sentAt = new Date()) =>
    call<{ results: { id: string; outcome: string; code?: string }[] }>(
      token,
      'POST',
      '/v1/sync/push',
      {
        sentAt: sentAt.toISOString(),
        mutations,
      },
    );

  it('records the day and the job from when the phone says they happened, and shows them on a timesheet', async () => {
    const job = await newJob([people.engineer]);
    const dispatched = json<Detail>(await move(tokens.dispatcher, job, 'dispatched'));
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // The phone's clock is an hour fast; it clocked in and set off, and synced later.
    const skew = 60 * 60 * 1000;
    const phone = (msAgo: number) => new Date(Date.now() + skew - msAgo).toISOString();
    const shiftId = randomUUID();
    const results = await push(
      tokens.engineer,
      [
        {
          id: randomUUID(),
          kind: 'shift.start',
          entityId: shiftId,
          recordedAt: phone(1000),
          payload: { startedAt: phone(1000), location: { status: 'denied' } },
        },
        {
          id: randomUUID(),
          kind: 'work_order.transition',
          entityId: job.workOrder.id,
          recordedAt: phone(600),
          payload: { to: 'travelling' },
          base: { state: 'dispatched', revision: dispatched.workOrder.revision },
        },
      ],
      new Date(Date.now() + skew),
    );
    expect(results.results.map((result) => result.outcome)).toEqual(['applied', 'applied']);

    // A second phone cannot open another shift while this one is open.
    const second = await push(tokens.engineer, [
      {
        id: randomUUID(),
        kind: 'shift.start',
        entityId: randomUUID(),
        recordedAt: new Date().toISOString(),
        payload: { startedAt: new Date().toISOString(), location: null },
      },
    ]);
    expect(second.results[0]).toMatchObject({ outcome: 'rejected', code: 'shift_open_elsewhere' });

    const detail = await call<Detail>(
      tokens.engineer,
      'GET',
      `/v1/work-orders/${job.workOrder.id}`,
    );
    const travelling = detail.events.find((event) => event.toState === 'travelling')!;
    const recordedAgo = Date.parse(travelling.recordedAt) - Date.parse(travelling.occurredAt);
    expect(recordedAgo).toBeGreaterThanOrEqual(400);
    expect(recordedAgo).toBeLessThan(5_000);

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const own = await call<{
      shifts: { id: string; endedAt: string | null }[];
      changes: { workOrderId: string; toState: string }[];
      workOrders: { id: string }[];
      crews: { workOrderId: string; userId: string }[];
      truncated: boolean;
    }>(
      tokens.engineer,
      'GET',
      `/v1/timesheets?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    expect(own.shifts.map((shift) => shift.id)).toContain(shiftId);
    expect(own.changes).toContainEqual(
      expect.objectContaining({ workOrderId: job.workOrder.id, toState: 'travelling' }),
    );
    expect(own.workOrders.map((order) => order.id)).toContain(job.workOrder.id);
    // The crew is returned, so a job's time counts for everyone on it.
    expect(own.crews).toContainEqual({
      workOrderId: job.workOrder.id,
      userId: people.engineer.userId,
    });
    expect(own.truncated).toBe(false);

    await call(
      tokens.engineer,
      'GET',
      `/v1/timesheets?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&userId=${people.colleague.userId}`,
      undefined,
      403,
    );
    const office = await call<{ shifts: { id: string }[] }>(
      tokens.dispatcher,
      'GET',
      `/v1/timesheets?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    expect(office.shifts.map((shift) => shift.id)).toContain(shiftId);

    const ended = await push(tokens.engineer, [
      {
        id: randomUUID(),
        kind: 'shift.end',
        entityId: shiftId,
        recordedAt: new Date().toISOString(),
        payload: { endedAt: new Date().toISOString(), location: null },
      },
    ]);
    expect(ended.results[0]?.outcome).toBe('applied');
  });
});

describe('push notifications', () => {
  it('tells the person assigned, not the dispatcher who assigned them, and stops at sign-out', async () => {
    const sender = api.services.push as RecordingPushSender;
    const token = 'ExponentPushToken[engineerphone0001]';
    const gone = 'ExponentPushToken[unregistered00001]';
    await call(tokens.engineer, 'PUT', '/v1/me/push-device', { token, platform: 'android' }, 204);
    await call(
      tokens.colleague,
      'PUT',
      '/v1/me/push-device',
      { token: gone, platform: 'ios' },
      204,
    );
    await call(
      tokens.dispatcher,
      'PUT',
      '/v1/me/push-device',
      {
        token: 'ExponentPushToken[dispatcherphone01]',
        platform: 'ios',
      },
      204,
    );

    // Earlier jobs in this file were assigned too: send what they queued first.
    await runJobs('push.work_order_event');
    sender.sent.length = 0;
    const job = await newJob([people.engineer, people.colleague], { priority: 'urgent' });
    await runJobs('push.work_order_event');
    expect(
      sender.sent.map((message) => [message.to, message.title.split(':')[0], message.channelId]),
    ).toEqual(
      expect.arrayContaining([
        [token, 'Urgent callout', 'urgent'],
        [gone, 'Urgent callout', 'urgent'],
      ]),
    );
    expect(sender.sent.some((message) => message.to.includes('dispatcher'))).toBe(false);
    expect(sender.sent.every((message) => message.data.workOrderId === job.workOrder.id)).toBe(
      true,
    );

    // The uninstalled app's token was disabled: the next change does not try it.
    sender.sent.length = 0;
    await call(tokens.dispatcher, 'PATCH', `/v1/work-orders/${job.workOrder.id}`, {
      expectedRevision: job.workOrder.revision,
      dueBy: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await runJobs('push.work_order_event');
    expect(sender.sent.map((message) => message.to)).toEqual([token]);
    expect(sender.sent[0]?.title).toMatch(/^Rescheduled:/u);

    // Turning notifications off on the phone stops them there.
    await call(tokens.engineer, 'POST', '/v1/me/push-device/unregister', { token }, 204);
    sender.sent.length = 0;
    await newJob([people.engineer]);
    await runJobs('push.work_order_event');
    expect(sender.sent).toEqual([]);
    await call(tokens.engineer, 'PUT', '/v1/me/push-device', { token, platform: 'android' }, 204);

    // Signing out stops it.
    await call(tokens.engineer, 'POST', '/v1/auth/sign-out', {});
    sender.sent.length = 0;
    await newJob([people.engineer]);
    await runJobs('push.work_order_event');
    expect(sender.sent).toEqual([]);
  });
});
