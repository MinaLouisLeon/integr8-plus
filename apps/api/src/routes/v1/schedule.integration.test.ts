import { getPlatformDataSource } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../http/logger.js';
import { buildJobHandlers } from '../../jobs/handlers.js';
import type { RecordingPushSender } from '../../push/sender.js';
import { type ApiHarness, type Member, startApi } from '../../testing/api-harness.js';

/**
 * The scheduling board through the API (P25), against a real database.
 *
 * What a dispatcher relies on, proven over HTTP: visits are planned and moved
 * with their own people, nobody is double-booked across jobs, an unavailable
 * engineer's visits are handed to someone else in one request, and the people
 * on a visit hear about it once.
 */

let api: ApiHarness;
let tokens: Record<'builder' | 'dispatcher' | 'ahmed' | 'sara' | 'omar', string>;
let people: Record<'owner' | 'dispatcher' | 'ahmed' | 'sara' | 'omar', Member>;
let jobTypeId: string;
let customerId: string;
let siteId: string;

const logger = createLogger({ level: 'error', write: () => undefined });

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: { field: string; code: string; message: string; params?: Record<string, string> }[];
  };
}

interface VisitBody {
  id: string;
  workOrderId: string;
  startsAt: string;
  endsAt: string;
  status: string;
  completedAt: string | null;
  revision: number;
  assignees: { id: string; name: string }[];
  warnings: string[];
}

interface Detail {
  workOrder: { id: string; revision: number; crew: { id: string; lead: boolean }[] };
  visits: VisitBody[];
}

const json = <T>(response: { body: string }) => JSON.parse(response.body) as T;

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

/** A day well in the future, so nothing here collides with another suite's data. */
const at = (day: number, time: string) => `2031-03-${String(day).padStart(2, '0')}T${time}:00.000Z`;

const newJob = (crew: Member[] = [], extra: Record<string, unknown> = {}) =>
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

const plan = (
  job: Detail,
  day: number,
  from: string,
  to: string,
  who: Member[],
  extra: Record<string, unknown> = {},
  expected = 201,
) =>
  api
    .call(tokens.dispatcher, {
      method: 'POST',
      url: `/v1/work-orders/${job.workOrder.id}/visits`,
      payload: {
        startsAt: at(day, from),
        endsAt: at(day, to),
        assigneeIds: who.map((member) => member.userId),
        ...extra,
      },
    })
    .then((response) => {
      expect(response.statusCode, response.body).toBe(expected);
      return response;
    });

const planned = async (...args: Parameters<typeof plan>) =>
  json<{ visit: VisitBody }>(await plan(...args)).visit;

async function runJobs(queue: string) {
  const handlers = buildJobHandlers(api.services, api.config);
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

beforeAll(async () => {
  api = await startApi();
  people = {
    owner: await api.member('owner', 'owner'),
    dispatcher: await api.member('dispatcher', 'dispatcher'),
    ahmed: await api.member('engineer', 'ahmed'),
    sara: await api.member('engineer', 'sara'),
    omar: await api.member('engineer', 'omar'),
  };
  tokens = {
    builder: await api.staff(people.owner),
    dispatcher: await api.signIn(people.dispatcher),
    ahmed: await api.signIn(people.ahmed),
    sara: await api.signIn(people.sara),
    omar: await api.signIn(people.omar),
  };
  jobTypeId = (
    await call<{ id: string }>(
      tokens.builder,
      'POST',
      '/v1/job-types',
      { name: 'AC service', code: 'ac-service', expectedDurationMinutes: 120 },
      201,
    )
  ).id;
  customerId = (
    await call<{ id: string }>(
      tokens.dispatcher,
      'POST',
      '/v1/customers',
      { name: 'Riverside Housing' },
      201,
    )
  ).id;
  siteId = (
    await call<{ id: string }>(
      tokens.dispatcher,
      'POST',
      `/v1/customers/${customerId}/sites`,
      { name: 'Block A', address: { line1: '1 River Road', city: 'Leeds', countryCode: 'GB' } },
      201,
    )
  ).id;
});

afterAll(async () => {
  await api.close();
});

describe('planning visits', () => {
  it('plans several visits of one job and shows them on the job and the calendar', async () => {
    const job = await newJob([people.ahmed, people.sara]);
    const first = await planned(job, 2, '08:00', '12:00', [people.ahmed, people.sara]);
    const second = await planned(job, 3, '08:00', '10:00', [people.sara]);
    expect(first).toMatchObject({ status: 'planned', revision: 1, warnings: [] });

    const detail = await call<Detail>(
      tokens.dispatcher,
      'GET',
      `/v1/work-orders/${job.workOrder.id}`,
    );
    expect(detail.visits.map((visit) => visit.id)).toEqual([first.id, second.id]);

    const board = await call<{ visits: VisitBody[]; workOrders: { id: string }[] }>(
      tokens.dispatcher,
      'GET',
      `/v1/schedule?from=${at(2, '00:00')}&to=${at(4, '00:00')}&userId=${people.sara.userId}`,
    );
    expect(board.visits.map((visit) => visit.id)).toEqual([first.id, second.id]);
    expect(board.workOrders.map((workOrder) => workOrder.id)).toEqual([job.workOrder.id]);
  });

  it('puts people on the crew when asked, and refuses them otherwise', async () => {
    const job = await newJob([people.ahmed]);
    const refused = await plan(job, 5, '08:00', '09:00', [people.omar], {}, 422);
    expect(json<ErrorBody>(refused).error.code).toBe('visit_assignee_not_on_crew');

    await planned(job, 5, '08:00', '09:00', [people.omar], { addToCrew: true });
    const detail = await call<Detail>(
      tokens.dispatcher,
      'GET',
      `/v1/work-orders/${job.workOrder.id}`,
    );
    expect(detail.workOrder.crew.map((member) => member.id).sort()).toEqual(
      [people.ahmed.userId, people.omar.userId].sort(),
    );
  });

  it('warns about a visit outside the due window and a visit with nobody on it, but saves both', async () => {
    const job = await newJob([], { dueBy: at(6, '10:00') });
    const visit = await planned(job, 6, '09:00', '11:00', []);
    expect(visit.warnings.sort()).toEqual(['no_engineer', 'outside_due_window']);
  });

  it('accepts work at any hour: night shifts are not a conflict', async () => {
    const job = await newJob([people.ahmed]);
    const visit = await planned(job, 7, '22:00', '23:59', [people.ahmed]);
    expect(visit.warnings).toEqual([]);
  });
});

describe('double booking', () => {
  it('refuses the same engineer on two jobs at once, naming the clash', async () => {
    const boiler = await newJob([people.omar]);
    const pump = await newJob([people.omar]);
    const existing = await planned(boiler, 10, '08:00', '10:00', [people.omar]);

    const refused = await plan(pump, 10, '09:00', '11:00', [people.omar], {}, 409);
    const error = json<ErrorBody>(refused).error;
    expect(error.code).toBe('visit_double_booked');
    expect(error.details?.[0]?.params).toMatchObject({
      userId: people.omar.userId,
      visitId: existing.id,
      workOrderId: boiler.workOrder.id,
    });
  });

  it('allows overlapping visits of the same job', async () => {
    const job = await newJob([people.sara]);
    await planned(job, 11, '08:00', '12:00', [people.sara]);
    await planned(job, 11, '10:00', '13:00', [people.sara]);
  });

  it('refuses a move onto someone’s other job, and a move from a stale copy', async () => {
    const morning = await newJob([people.sara]);
    const afternoon = await newJob([people.sara]);
    await planned(morning, 12, '08:00', '10:00', [people.sara]);
    const later = await planned(afternoon, 12, '14:00', '15:00', [people.sara]);

    const clash = await api.call(tokens.dispatcher, {
      method: 'PATCH',
      url: `/v1/visits/${later.id}`,
      payload: {
        expectedRevision: later.revision,
        startsAt: at(12, '09:00'),
        endsAt: at(12, '10:00'),
      },
    });
    expect(clash.statusCode).toBe(409);
    expect(json<ErrorBody>(clash).error.code).toBe('visit_double_booked');

    const moved = await call<{ visit: VisitBody }>(
      tokens.dispatcher,
      'PATCH',
      `/v1/visits/${later.id}`,
      {
        expectedRevision: later.revision,
        startsAt: at(12, '16:00'),
        endsAt: at(12, '17:00'),
      },
    );
    expect(moved.visit.revision).toBe(later.revision + 1);

    const stale = await api.call(tokens.dispatcher, {
      method: 'PATCH',
      url: `/v1/visits/${later.id}`,
      payload: { expectedRevision: later.revision, notes: 'Bring the long ladder' },
    });
    expect(stale.statusCode).toBe(409);
    expect(json<ErrorBody>(stale).error.code).toBe('visit_changed');
  });
});

describe('redistributing an unavailable engineer’s day', () => {
  it('hands every selected visit from one engineer to another in one request', async () => {
    const first = await newJob([people.ahmed]);
    const second = await newJob([people.ahmed, people.sara]);
    const a = await planned(first, 15, '08:00', '10:00', [people.ahmed]);
    const b = await planned(second, 15, '11:00', '13:00', [people.ahmed, people.sara]);

    const { results } = await call<{ results: { visitId: string; outcome: string }[] }>(
      tokens.dispatcher,
      'POST',
      '/v1/visits/bulk',
      {
        action: 'reassign',
        visitIds: [a.id, b.id],
        fromUserId: people.ahmed.userId,
        toUserId: people.omar.userId,
      },
    );
    expect(results.map((result) => result.outcome)).toEqual(['changed', 'changed']);

    const board = await call<{ visits: VisitBody[] }>(
      tokens.dispatcher,
      'GET',
      `/v1/schedule?from=${at(15, '00:00')}&to=${at(16, '00:00')}`,
    );
    const names = (id: string) =>
      board.visits
        .find((visit) => visit.id === id)!
        .assignees.map((person) => person.id)
        .sort();
    expect(names(a.id)).toEqual([people.omar.userId]);
    expect(names(b.id)).toEqual([people.omar.userId, people.sara.userId].sort());
  });

  it('reports a visit it cannot move and moves the rest', async () => {
    const busy = await newJob([people.sara]);
    const blocking = await newJob([people.omar]);
    await planned(blocking, 17, '08:00', '12:00', [people.omar]);
    const clashes = await planned(busy, 17, '09:00', '10:00', [people.sara]);
    const fine = await planned(busy, 17, '13:00', '14:00', [people.sara]);

    const { results } = await call<{
      results: { visitId: string; outcome: string; code: string | null }[];
    }>(tokens.dispatcher, 'POST', '/v1/visits/bulk', {
      action: 'reassign',
      visitIds: [clashes.id, fine.id],
      fromUserId: people.sara.userId,
      toUserId: people.omar.userId,
    });
    expect(results).toEqual([
      expect.objectContaining({
        visitId: clashes.id,
        outcome: 'refused',
        code: 'visit_double_booked',
      }),
      expect.objectContaining({ visitId: fine.id, outcome: 'changed', code: null }),
    ]);
  });
});

describe('who may do what', () => {
  it('lets the crew mark a visit done but not plan or see the board', async () => {
    const job = await newJob([people.ahmed]);
    const visit = await planned(job, 20, '08:00', '09:00', [people.ahmed]);

    await call(
      tokens.ahmed,
      'GET',
      `/v1/schedule?from=${at(20, '00:00')}&to=${at(21, '00:00')}`,
      undefined,
      403,
    );
    const refused = await api.call(tokens.ahmed, {
      method: 'POST',
      url: `/v1/work-orders/${job.workOrder.id}/visits`,
      payload: { startsAt: at(21, '08:00'), endsAt: at(21, '09:00') },
    });
    expect(refused.statusCode).toBe(403);

    const done = await call<{ visit: VisitBody }>(
      tokens.ahmed,
      'POST',
      `/v1/visits/${visit.id}/done`,
      {},
    );
    expect(done.visit.status).toBe('done');
    // Someone not on the job cannot see the visit at all.
    await call(tokens.sara, 'POST', `/v1/visits/${visit.id}/done`, {}, 404);
  });
});

describe('a visit done on the phone', () => {
  it('is applied once from the sync push, at the time the phone recorded it', async () => {
    const job = await newJob([people.ahmed]);
    const visit = await planned(job, 26, '08:00', '09:00', [people.ahmed]);
    const recordedAt = new Date(Date.now() - 60_000).toISOString();
    const mutation = {
      id: crypto.randomUUID(),
      kind: 'work_order.visit_done',
      entityId: job.workOrder.id,
      recordedAt,
      payload: { visitId: visit.id },
    };
    const push = () =>
      call<{ results: { outcome: string; code?: string }[] }>(
        tokens.ahmed,
        'POST',
        '/v1/sync/push',
        {
          sentAt: new Date().toISOString(),
          mutations: [mutation],
        },
      );
    expect((await push()).results[0]?.outcome).toBe('applied');
    expect((await push()).results[0]?.outcome).toBe('applied');

    const detail = await call<Detail>(
      tokens.dispatcher,
      'GET',
      `/v1/work-orders/${job.workOrder.id}`,
    );
    const done = detail.visits.find((found) => found.id === visit.id)!;
    expect(done.status).toBe('done');
    expect(Math.abs(Date.parse(done.completedAt!) - Date.parse(recordedAt))).toBeLessThan(5_000);
  });
});

describe('the unscheduled list', () => {
  it('lists open jobs with no planned visit and the time their type expects', async () => {
    const waiting = await newJob([people.sara], { priority: 'urgent' });
    const { items } = await call<{
      items: { workOrder: { id: string }; expectedDurationMinutes: number | null }[];
    }>(tokens.dispatcher, 'GET', '/v1/schedule/unscheduled');
    expect(items[0]).toMatchObject({
      workOrder: { id: waiting.workOrder.id },
      expectedDurationMinutes: 120,
    });

    await planned(waiting, 22, '08:00', '10:00', [people.sara]);
    const after = await call<{ items: { workOrder: { id: string } }[] }>(
      tokens.dispatcher,
      'GET',
      '/v1/schedule/unscheduled',
    );
    expect(after.items.map((item) => item.workOrder.id)).not.toContain(waiting.workOrder.id);
  });
});

describe('push notifications', () => {
  it('tells someone once when they are put on the crew and a visit together, and when the visit moves', async () => {
    const sender = api.services.push as RecordingPushSender;
    const phone = 'ExponentPushToken[omarphone00000001]';
    await call(
      tokens.omar,
      'PUT',
      '/v1/me/push-device',
      { token: phone, platform: 'android' },
      204,
    );
    await runJobs('push.work_order_event');
    sender.sent.length = 0;

    const job = await newJob([people.sara]);
    const visit = await planned(job, 25, '08:00', '09:00', [people.omar], { addToCrew: true });
    await runJobs('push.work_order_event');
    const toOmar = sender.sent.filter((message) => message.to === phone);
    expect(toOmar.map((message) => message.title.split(':')[0])).toEqual(['New visit']);
    expect(toOmar[0]?.data).toMatchObject({ workOrderId: job.workOrder.id, visitId: visit.id });

    sender.sent.length = 0;
    await call(tokens.dispatcher, 'PATCH', `/v1/visits/${visit.id}`, {
      expectedRevision: visit.revision,
      startsAt: at(25, '10:00'),
      endsAt: at(25, '11:00'),
    });
    await runJobs('push.work_order_event');
    expect(sender.sent.map((message) => message.title.split(':')[0])).toEqual(['Visit moved']);
  });
});
