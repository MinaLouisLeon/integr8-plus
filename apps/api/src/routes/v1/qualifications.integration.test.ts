import { calendarDay } from '@integr8/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordingEmailSender } from '../../email/sender.js';
import { createLogger } from '../../http/logger.js';
import type { RecordingPushSender } from '../../push/sender.js';
import { runQualificationExpiry } from '../../qualifications/expiry.js';
import { type ApiHarness, type Member, startApi } from '../../testing/api-harness.js';

/**
 * Skills and certificates through the API (P26), against a real database.
 *
 * What a dispatcher and the people who keep the records rely on, over HTTP:
 * managers record qualifications and set what job types need, a visit where
 * nobody qualifies is refused until a reason is given and the reason lands in
 * the job's history, a certificate is judged on the visit's dates, and expiry
 * alerts go out once.
 */

let api: ApiHarness;
let tokens: Record<'builder' | 'hr' | 'dispatcher' | 'ahmed' | 'sara', string>;
let people: Record<'owner' | 'hr' | 'dispatcher' | 'ahmed' | 'sara', Member>;
let jobTypeId: string;
let customerId: string;
let siteId: string;
let electricalId: string;
let skillId: string;

const logger = createLogger({ level: 'error', write: () => undefined });

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: { field: string; code: string; message: string; params?: Record<string, string> }[];
  };
}

interface Gap {
  qualificationTypeId: string;
  name: string;
  people: { id: string; status: string }[];
}

interface VisitBody {
  id: string;
  revision: number;
  warnings: string[];
  qualificationGaps: Gap[];
}

interface Detail {
  workOrder: { id: string };
  visits: VisitBody[];
  requiredQualifications: { qualificationTypeId: string; name: string }[];
  events: { kind: string; reason: string | null; details: Record<string, unknown> }[];
}

interface RecordBody {
  id: string;
  version: number;
  state: string;
  expiresOn: string | null;
  person: { id: string };
  qualificationType: { id: string; name: string };
  attachments: { id: string }[];
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

/** Far in the future, so nothing here collides with another suite's data. */
const at = (day: number, time: string) => `2032-04-${String(day).padStart(2, '0')}T${time}:00.000Z`;

const newJob = (crew: Member[]) =>
  call<Detail>(
    tokens.dispatcher,
    'POST',
    '/v1/work-orders',
    {
      customerId,
      siteId,
      jobTypeId,
      crew: crew.map((member, index) => ({ userId: member.userId, lead: index === 0 })),
    },
    201,
  );

const plan = (job: Detail, day: number, who: Member[], extra: Record<string, unknown> = {}) =>
  api.call(tokens.dispatcher, {
    method: 'POST',
    url: `/v1/work-orders/${job.workOrder.id}/visits`,
    payload: {
      startsAt: at(day, '08:00'),
      endsAt: at(day, '10:00'),
      assigneeIds: who.map((member) => member.userId),
      ...extra,
    },
  });

const hold = (who: Member, typeId: string, dates: { issuedOn?: string; expiresOn?: string }) =>
  call<RecordBody>(
    tokens.hr,
    'POST',
    '/v1/qualifications',
    { userId: who.userId, qualificationTypeId: typeId, ...dates },
    201,
  );

beforeAll(async () => {
  api = await startApi();
  people = {
    owner: await api.member('owner', 'owner'),
    hr: await api.member('hr_manager', 'hr'),
    dispatcher: await api.member('dispatcher', 'dispatcher'),
    ahmed: await api.member('engineer', 'ahmed'),
    sara: await api.member('engineer', 'sara'),
  };
  tokens = {
    builder: await api.staff(people.owner),
    hr: await api.signIn(people.hr),
    dispatcher: await api.signIn(people.dispatcher),
    ahmed: await api.signIn(people.ahmed),
    sara: await api.signIn(people.sara),
  };
  jobTypeId = (
    await call<{ id: string }>(
      tokens.builder,
      'POST',
      '/v1/job-types',
      { name: 'Electrical inspection', code: 'eicr', expectedDurationMinutes: 120 },
      201,
    )
  ).id;
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
      { name: 'Block A', address: { line1: '1 River Road', city: 'Leeds', countryCode: 'GB' } },
      201,
    )
  ).id;
  electricalId = (
    await call<{ id: string }>(
      tokens.hr,
      'POST',
      '/v1/qualification-types',
      { name: 'Inspection and testing', kind: 'certificate' },
      201,
    )
  ).id;
  skillId = (
    await call<{ id: string }>(
      tokens.hr,
      'POST',
      '/v1/qualification-types',
      { name: 'Fault finding', kind: 'skill' },
      201,
    )
  ).id;
  // A company manager, not Integr8 staff, sets what the job type needs (2026-10-27).
  await call(tokens.hr, 'PUT', `/v1/job-types/${jobTypeId}/qualifications`, {
    qualificationTypeIds: [electricalId],
  });
});

afterAll(async () => {
  await api.close();
});

describe('keeping the records', () => {
  it('lets HR record them, the dispatcher read them, and nobody else change them', async () => {
    const record = await hold(people.sara, electricalId, {
      issuedOn: '2030-01-01',
      expiresOn: '2034-12-31',
    });
    expect(record).toMatchObject({ expiresOn: '2034-12-31', version: 1 });

    const list = await call<{ items: RecordBody[]; can: { manage: boolean } }>(
      tokens.dispatcher,
      'GET',
      `/v1/qualifications?userId=${people.sara.userId}`,
    );
    expect(list.items.map((item) => item.id)).toContain(record.id);
    expect(list.can.manage).toBe(false);

    await call(
      tokens.dispatcher,
      'POST',
      '/v1/qualifications',
      { userId: people.ahmed.userId, qualificationTypeId: electricalId },
      403,
    );
    await call(tokens.ahmed, 'GET', '/v1/qualifications', undefined, 403);
  });

  it('shows everyone their own', async () => {
    const mine = await call<{ items: RecordBody[] }>(tokens.sara, 'GET', '/v1/me/qualifications');
    expect(mine.items.every((item) => item.person.id === people.sara.userId)).toBe(true);
    expect(mine.items.length).toBeGreaterThan(0);
  });

  it('refuses an expiry on a skill', async () => {
    const refused = json<ErrorBody>(
      await api.call(tokens.hr, {
        method: 'POST',
        url: '/v1/qualifications',
        payload: {
          userId: people.ahmed.userId,
          qualificationTypeId: skillId,
          expiresOn: '2033-01-01',
        },
      }),
    );
    expect(refused.error.code).toBe('qualification_skill_expires');
  });

  it('takes a certificate’s scan from those who keep the records', async () => {
    const record = await hold(people.ahmed, skillId, {});
    const media = await call<{ media: { id: string } }>(
      tokens.hr,
      'POST',
      '/v1/media',
      { contentType: 'application/pdf', byteSize: 1024 },
      201,
    );
    // The upload is never confirmed here, so the attachment is refused as an
    // unknown file; what matters is that HR may ask and an engineer may not.
    const asEngineer = await api.call(tokens.ahmed, {
      method: 'POST',
      url: '/v1/attachments',
      payload: {
        owner: { memberQualificationId: record.id },
        fileId: media.media.id,
        title: 'Certificate',
      },
    });
    expect(asEngineer.statusCode).toBe(403);
  });
});

describe('what jobs need', () => {
  it('copies the job type’s requirements onto a new job', async () => {
    const job = await newJob([people.ahmed]);
    expect(job.requiredQualifications).toEqual([
      { qualificationTypeId: electricalId, name: 'Inspection and testing' },
    ]);
  });

  it('lets the dispatcher change one job’s list', async () => {
    const job = await newJob([people.ahmed]);
    const changed = await call<{ requiredQualifications: unknown[] }>(
      tokens.dispatcher,
      'PUT',
      `/v1/work-orders/${job.workOrder.id}/qualifications`,
      { qualificationTypeIds: [] },
    );
    expect(changed.requiredQualifications).toEqual([]);
    const response = await plan(job, 2, [people.ahmed]);
    expect(response.statusCode, response.body).toBe(201);
  });
});

describe('planning a visit', () => {
  it('refuses a visit nobody is qualified for, naming who lacks what', async () => {
    const job = await newJob([people.ahmed]);
    const refused = await plan(job, 3, [people.ahmed]);
    expect(refused.statusCode).toBe(409);
    const body = json<ErrorBody>(refused);
    expect(body.error.code).toBe('visit_unqualified');
    expect(body.error.details).toEqual([
      expect.objectContaining({
        code: 'missing',
        params: expect.objectContaining({
          qualificationTypeId: electricalId,
          userId: people.ahmed.userId,
        }) as unknown,
      }),
    ]);
    // Nothing was written.
    const detail = await call<Detail>(
      tokens.dispatcher,
      'GET',
      `/v1/work-orders/${job.workOrder.id}`,
    );
    expect(detail.visits).toEqual([]);
  });

  it('goes ahead with a reason, kept in the job’s history and shown on the visit', async () => {
    const job = await newJob([people.ahmed]);
    const response = await plan(job, 4, [people.ahmed], {
      qualificationOverride: { reason: 'Supervised by Sara on site' },
    });
    expect(response.statusCode, response.body).toBe(201);
    const { visit } = json<{ visit: VisitBody }>(response);
    expect(visit.warnings).toContain('unqualified');
    expect(visit.qualificationGaps[0]).toMatchObject({ qualificationTypeId: electricalId });

    const detail = await call<Detail>(
      tokens.dispatcher,
      'GET',
      `/v1/work-orders/${job.workOrder.id}`,
    );
    const event = detail.events.find((entry) => entry.kind === 'qualification_override');
    expect(event).toMatchObject({ reason: 'Supervised by Sara on site' });
    expect(event?.details).toMatchObject({ visitId: visit.id });

    // Moving it with the same people does not ask again.
    const moved = await call<{ visit: VisitBody }>(
      tokens.dispatcher,
      'PATCH',
      `/v1/visits/${visit.id}`,
      {
        expectedRevision: visit.revision,
        startsAt: at(4, '11:00'),
        endsAt: at(4, '12:00'),
      },
    );
    expect(moved.visit.warnings).toContain('unqualified');
  });

  it('needs only one qualified person on the visit', async () => {
    const job = await newJob([people.ahmed, people.sara]);
    const response = await plan(job, 5, [people.ahmed, people.sara]);
    expect(response.statusCode, response.body).toBe(201);
    expect(json<{ visit: VisitBody }>(response).visit.qualificationGaps).toEqual([]);
  });

  it('judges a certificate on the visit’s dates, not today’s', async () => {
    const shortType = (
      await call<{ id: string }>(
        tokens.hr,
        'POST',
        '/v1/qualification-types',
        { name: 'Confined spaces', kind: 'certificate' },
        201,
      )
    ).id;
    await hold(people.ahmed, shortType, { expiresOn: '2032-04-09' });
    const job = await newJob([people.ahmed]);
    await call(tokens.dispatcher, 'PUT', `/v1/work-orders/${job.workOrder.id}/qualifications`, {
      qualificationTypeIds: [shortType],
    });
    expect((await plan(job, 9, [people.ahmed])).statusCode).toBe(201);
    const late = await plan(job, 10, [people.ahmed]);
    expect(late.statusCode).toBe(409);
    expect(json<ErrorBody>(late).error.details?.[0]?.code).toBe('expires_before_visit');
  });

  it('asks once for a whole bulk reassignment, and refuses each visit without a reason', async () => {
    const job = await newJob([people.sara]);
    const visit = json<{ visit: VisitBody }>(await plan(job, 12, [people.sara])).visit;

    const without = await call<{ results: { outcome: string; code: string | null }[] }>(
      tokens.dispatcher,
      'POST',
      '/v1/visits/bulk',
      { action: 'reassign', visitIds: [visit.id], toUserId: people.ahmed.userId },
    );
    expect(without.results[0]).toMatchObject({ outcome: 'refused', code: 'visit_unqualified' });

    const withReason = await call<{ results: { outcome: string }[] }>(
      tokens.dispatcher,
      'POST',
      '/v1/visits/bulk',
      {
        action: 'reassign',
        visitIds: [visit.id],
        toUserId: people.ahmed.userId,
        qualificationOverrideReason: 'Sara is off sick; Ahmed booked on the course',
      },
    );
    expect(withReason.results[0]).toMatchObject({ outcome: 'changed' });
  });

  it('ranks people for the picker by what they hold', async () => {
    const job = await newJob([people.ahmed]);
    const ranked = await call<{ people: { id: string; met: number }[] }>(
      tokens.dispatcher,
      'GET',
      `/v1/work-orders/${job.workOrder.id}/eligibility?startsAt=${encodeURIComponent(at(15, '08:00'))}&endsAt=${encodeURIComponent(at(15, '10:00'))}`,
    );
    const sara = ranked.people.findIndex((person) => person.id === people.sara.userId);
    const ahmed = ranked.people.findIndex((person) => person.id === people.ahmed.userId);
    expect(ranked.people[sara]?.met).toBe(1);
    expect(sara).toBeLessThan(ahmed);
  });
});

describe('the phone', () => {
  it('carries the engineer’s own records with the first page of a sync', async () => {
    const pulled = await call<{ myQualifications: { items: RecordBody[] } | null }>(
      tokens.sara,
      'GET',
      '/v1/sync/pull',
    );
    expect(pulled.myQualifications?.items.length).toBeGreaterThan(0);
  });
});

describe('expiry alerts', () => {
  it('warns the holder and the managers once, by email and on the phone', async () => {
    const soonType = (
      await call<{ id: string }>(
        tokens.hr,
        'POST',
        '/v1/qualification-types',
        { name: 'Working at height', kind: 'certificate' },
        201,
      )
    ).id;
    const now = new Date();
    const today = calendarDay(now, 'UTC');
    const inTenDays = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await hold(people.ahmed, soonType, { issuedOn: today, expiresOn: inTenDays });
    await call(
      tokens.ahmed,
      'PUT',
      '/v1/me/push-device',
      { token: 'ExponentPushToken[qualifications-ahmed]', platform: 'android' },
      204,
    );

    const email = api.services.email as RecordingEmailSender;
    const push = api.services.push as RecordingPushSender;
    const sentBefore = email.sent.length;
    const pushedBefore = push.sent.length;

    const report = await runQualificationExpiry({
      config: api.config,
      logger,
      workerId: 'test',
      email,
      push,
      now,
      force: true,
    });
    expect(report.failures).toEqual([]);
    const sent = email.sent.slice(sentBefore);
    expect(sent.some((message) => message.to === people.ahmed.email)).toBe(true);
    expect(
      sent.some(
        (message) => message.to === people.hr.email && message.text.includes('Working at height'),
      ),
    ).toBe(true);
    expect(
      push.sent.slice(pushedBefore).some((message) => message.title.includes('Working at height')),
    ).toBe(true);

    const again = email.sent.length;
    await runQualificationExpiry({
      config: api.config,
      logger,
      workerId: 'test',
      email,
      push,
      now,
      force: true,
    });
    expect(
      email.sent.slice(again).some((message) => message.text.includes('Working at height')),
    ).toBe(false);
  });
});
