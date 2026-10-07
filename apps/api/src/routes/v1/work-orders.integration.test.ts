import { getPlatformDataSource, withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../http/logger.js';
import { buildJobHandlers } from '../../jobs/handlers.js';
import { type ApiHarness, type Member, startApi } from '../../testing/api-harness.js';

/**
 * Customers, sites and work orders through the API (P10), against a real
 * database.
 *
 * Three exit criteria are proven here, through HTTP as any client would send it:
 *
 * - an invalid state transition is rejected by the API, not merely hidden;
 * - a job whose required forms are unsubmitted cannot be marked complete;
 * - importing a thousand jobs from CSV reports per-row errors without
 *   aborting the file.
 */

let api: ApiHarness;
let tokens: Record<
  'owner' | 'builder' | 'dispatcher' | 'engineer' | 'bystander' | 'viewer',
  string
>;
let people: Record<'owner' | 'dispatcher' | 'engineer' | 'bystander' | 'viewer', Member>;
let requiredFormId: string;
let optionalFormId: string;
let jobTypeId: string;
let customerId: string;
let siteId: string;

const logger = createLogger({ level: 'error', write: () => undefined });

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: { field: string; code: string; message: string }[];
  };
}

interface Detail {
  workOrder: {
    id: string;
    reference: number;
    state: string;
    revision: number;
    crew: { id: string; lead: boolean }[];
  };
  site: { access: { gateCode: string | null; hazards: string | null } };
  forms: { formId: string; required: boolean; submission: { id: string; status: string } | null }[];
  checklist: { id: string; done: boolean }[];
  can: { transitions: { to: string; requiresReason: boolean }[]; work: boolean };
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

async function publishForm(title: string) {
  const { form } = await call<{ form: { id: string } }>(
    tokens.builder,
    'POST',
    '/v1/forms',
    { title },
    201,
  );
  const detail = await call<{ draft: { revision: number } }>(
    tokens.builder,
    'GET',
    `/v1/forms/${form.id}`,
  );
  const saved = await call<{ revision: number }>(
    tokens.builder,
    'PUT',
    `/v1/forms/${form.id}/draft`,
    {
      expectedRevision: detail.draft.revision,
      definition: {
        schemaVersion: 1,
        title: { en: title },
        pages: [
          {
            id: 'page_1',
            sections: [
              {
                id: 'section_1',
                fields: [{ id: 'note', type: 'text', label: { en: 'Note' }, required: true }],
              },
            ],
          },
        ],
      },
    },
  );
  await call(tokens.builder, 'POST', `/v1/forms/${form.id}/draft/publish`, {
    expectedRevision: saved.revision,
  });
  return form.id;
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

const newJob = (
  crew: { userId: string; lead?: boolean }[] = [],
  extra: Record<string, unknown> = {},
) =>
  call<Detail>(
    tokens.dispatcher,
    'POST',
    '/v1/work-orders',
    { customerId, siteId, jobTypeId, crew, ...extra },
    201,
  );

const move = (token: string, job: Detail, to: string, reason?: string, expected = 200) =>
  api
    .call(token, {
      method: 'POST',
      url: `/v1/work-orders/${job.workOrder.id}/transitions`,
      payload: {
        to,
        expectedRevision: job.workOrder.revision,
        ...(reason === undefined ? {} : { reason }),
      },
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
    bystander: await api.member('engineer', 'bystander'),
    viewer: await api.member('viewer', 'viewer'),
  };
  tokens = {
    owner: await api.signIn(people.owner),
    // Integr8 staff acting as the owner: forms and job types are built here.
    builder: await api.staff(people.owner),
    dispatcher: await api.signIn(people.dispatcher),
    engineer: await api.signIn(people.engineer),
    bystander: await api.signIn(people.bystander),
    viewer: await api.signIn(people.viewer),
  };

  requiredFormId = await publishForm('Gas safety record');
  optionalFormId = await publishForm('Customer feedback');
  jobTypeId = (
    await call<{ id: string }>(
      tokens.builder,
      'POST',
      '/v1/job-types',
      {
        name: 'Boiler service',
        code: 'boiler-service',
        expectedDurationMinutes: 90,
        checklist: [{ label: 'Isolate supply' }, { label: 'Inspect flue' }],
        forms: [
          { formId: requiredFormId, required: true },
          { formId: optionalFormId, required: false },
        ],
      },
      201,
    )
  ).id;
  customerId = (
    await call<{ id: string }>(
      tokens.dispatcher,
      'POST',
      '/v1/customers',
      { name: 'Riverside Housing', accountNumber: 'RH-001' },
      201,
    )
  ).id;
  siteId = (
    await call<{ id: string }>(
      tokens.dispatcher,
      'POST',
      `/v1/customers/${customerId}/sites`,
      {
        name: 'Block A',
        address: { line1: '1 River Road', city: 'Leeds', postcode: 'LS1 1AA', countryCode: 'GB' },
        access: { gateCode: '4471#', hazards: 'Asbestos in plant room' },
      },
      201,
    )
  ).id;
});

afterAll(async () => {
  await api.close();
});

describe('an invalid state transition is rejected by the API', () => {
  it('refuses a transition the state machine does not have, and names the states', async () => {
    const job = await newJob([{ userId: people.engineer.userId }]);
    const response = await move(tokens.owner, job, 'complete', undefined, 409);
    expect(json<ErrorBody>(response).error).toMatchObject({
      code: 'transition_not_allowed',
      message: 'A job that is scheduled cannot move to complete.',
    });
    const unchanged = await call<Detail>(
      tokens.owner,
      'GET',
      `/v1/work-orders/${job.workOrder.id}`,
    );
    expect(unchanged.workOrder).toMatchObject({
      state: 'scheduled',
      revision: job.workOrder.revision,
    });
    expect(unchanged.can.transitions.map((next) => next.to)).toEqual(['dispatched', 'cancelled']);
  });

  it('keeps each transition to the people allowed to make it', async () => {
    const job = await newJob([{ userId: people.engineer.userId }]);
    // An engineer may not dispatch; a bystander engineer cannot even see the job.
    expect(
      json<ErrorBody>(await move(tokens.engineer, job, 'dispatched', undefined, 403)).error.code,
    ).toBe('forbidden');
    await move(tokens.bystander, job, 'dispatched', undefined, 404);
    await move(tokens.viewer, job, 'dispatched', undefined, 403);

    const dispatched = json<Detail>(await move(tokens.dispatcher, job, 'dispatched'));
    expect(dispatched.workOrder.state).toBe('dispatched');
    const engineerView = await call<Detail>(
      tokens.engineer,
      'GET',
      `/v1/work-orders/${job.workOrder.id}`,
    );
    expect(engineerView.can.transitions.map((next) => next.to)).toEqual(['travelling', 'on_site']);
    expect(engineerView.site.access).toMatchObject({
      gateCode: '4471#',
      hazards: 'Asbestos in plant room',
    });

    const reason = await move(tokens.dispatcher, dispatched, 'cancelled', undefined, 422);
    expect(json<ErrorBody>(reason).error.code).toBe('reason_required');

    const stale = await move(tokens.dispatcher, job, 'scheduled', undefined, 409);
    expect(json<ErrorBody>(stale).error.code).toBe('work_order_changed');
  });

  it('refuses to dispatch a job with nobody on it', async () => {
    const job = await newJob();
    expect(
      json<ErrorBody>(await move(tokens.dispatcher, job, 'dispatched', undefined, 409)).error.code,
    ).toBe('nobody_assigned');
  });
});

describe('a job whose required forms are unsubmitted cannot be completed', () => {
  it('names the missing form, and completes once it is submitted for this job', async () => {
    let job = await newJob([{ userId: people.engineer.userId }]);
    job = json<Detail>(await move(tokens.dispatcher, job, 'dispatched'));
    job = json<Detail>(await move(tokens.engineer, job, 'on_site'));
    job = json<Detail>(await move(tokens.engineer, job, 'in_progress'));

    const refused = json<ErrorBody>(await move(tokens.engineer, job, 'complete', undefined, 409));
    expect(refused.error).toMatchObject({
      code: 'completion_blocked',
      message: 'Before completing this job, submit Gas safety record.',
    });

    // Filled for a different job, it does not count.
    const elsewhere = await newJob([{ userId: people.engineer.userId }]);
    const wrongJob = await call<{ submission: { id: string; revision: number } }>(
      tokens.engineer,
      'POST',
      '/v1/submissions',
      { formId: requiredFormId, workOrderId: elsewhere.workOrder.id },
      201,
    );
    await call(tokens.engineer, 'POST', `/v1/submissions/${wrongJob.submission.id}/submit`, {
      expectedRevision: wrongJob.submission.revision,
      answers: { note: 'wrong job' },
    });
    await move(tokens.engineer, job, 'complete', undefined, 409);

    // A form that is not on the job cannot be filled for it; nor can a bystander fill for it.
    const unrelated = await publishForm('Unrelated');
    const notOnJob = await api.call(tokens.engineer, {
      method: 'POST',
      url: '/v1/submissions',
      payload: { formId: unrelated, workOrderId: job.workOrder.id },
    });
    expect(json<ErrorBody>(notOnJob).error.code).toBe('form_not_on_work_order');
    const bystander = await api.call(tokens.bystander, {
      method: 'POST',
      url: '/v1/submissions',
      payload: { formId: requiredFormId, workOrderId: job.workOrder.id },
    });
    expect(bystander.statusCode).toBe(404);

    const draft = await call<{ submission: { id: string; revision: number } }>(
      tokens.engineer,
      'POST',
      '/v1/submissions',
      { formId: requiredFormId, workOrderId: job.workOrder.id },
      201,
    );
    await move(tokens.engineer, job, 'complete', undefined, 409);
    await call(tokens.engineer, 'POST', `/v1/submissions/${draft.submission.id}/submit`, {
      expectedRevision: draft.submission.revision,
      answers: { note: 'Appliance safe' },
    });

    const withForm = await call<Detail>(
      tokens.engineer,
      'GET',
      `/v1/work-orders/${job.workOrder.id}`,
    );
    expect(withForm.forms.find((form) => form.formId === requiredFormId)?.submission?.status).toBe(
      'submitted',
    );
    const done = json<Detail>(await move(tokens.engineer, withForm, 'complete'));
    expect(done.workOrder.state).toBe('complete');

    // Found again by the job, the site and the customer.
    for (const filter of [
      `workOrderId=${job.workOrder.id}`,
      `siteId=${siteId}`,
      `customerId=${customerId}`,
    ]) {
      const page = await call<{
        items: { id: string; workOrder: { id: string; referenceLabel: string } | null }[];
      }>(tokens.owner, 'GET', `/v1/submissions?${filter}`);
      expect(
        page.items.map((item) => item.id),
        filter,
      ).toContain(draft.submission.id);
    }

    // Sign-off is an owner's or admin's; sending it back needs a reason.
    expect((await move(tokens.dispatcher, done, 'reviewed', undefined, 403)).statusCode).toBe(403);
    await move(tokens.owner, done, 'in_progress', undefined, 422);
    const reviewed = json<Detail>(await move(tokens.owner, done, 'reviewed'));
    expect(reviewed.can.transitions).toEqual([]);
  });
});

describe('customers and sites', () => {
  it('geocodes a new site in the background, and keeps a pin placed by hand', async () => {
    const created = await call<{ id: string; geocodeStatus: string }>(
      tokens.dispatcher,
      'POST',
      `/v1/customers/${customerId}/sites`,
      { name: 'Depot', address: { line1: '9 Mill Lane', city: 'York' } },
      201,
    );
    expect(created.geocodeStatus).toBe('pending');
    const nowhere = await call<{ id: string }>(
      tokens.dispatcher,
      'POST',
      `/v1/customers/${customerId}/sites`,
      { name: 'Lost', address: { line1: '1 Nowhere Street' } },
      201,
    );
    await runJobs('site.geocode');

    const found = await call<{
      site: { geocodeStatus: string; location: { latitude: number } | null };
    }>(tokens.engineer, 'GET', `/v1/sites/${created.id}`);
    expect(found.site.geocodeStatus).toBe('found');
    expect(found.site.location?.latitude).toBeGreaterThan(53);
    expect(
      (
        await call<{ site: { geocodeStatus: string } }>(
          tokens.engineer,
          'GET',
          `/v1/sites/${nowhere.id}`,
        )
      ).site.geocodeStatus,
    ).toBe('not_found');

    const pinned = await call<{ geocodeStatus: string; location: { latitude: number } }>(
      tokens.dispatcher,
      'PATCH',
      `/v1/sites/${created.id}`,
      { location: { latitude: 53.96, longitude: -1.08 } },
    );
    expect(pinned).toMatchObject({ geocodeStatus: 'manual', location: { latitude: 53.96 } });
  });

  it('lets the crew correct access notes at their job’s site, and nobody else but the office', async () => {
    await newJob([{ userId: people.engineer.userId }]);
    const corrected = await call<{ access: { gateCode: string; updatedBy: { id: string } } }>(
      tokens.engineer,
      'PUT',
      `/v1/sites/${siteId}/access`,
      { gateCode: '9902#' },
    );
    expect(corrected.access).toMatchObject({
      gateCode: '9902#',
      updatedBy: { id: people.engineer.userId },
    });
    const refused = await api.call(tokens.bystander, {
      method: 'PUT',
      url: `/v1/sites/${siteId}/access`,
      payload: { gateCode: '0000' },
    });
    expect(refused.statusCode).toBe(403);
    expect(
      (
        await api.call(tokens.engineer, {
          method: 'PATCH',
          url: `/v1/sites/${siteId}`,
          payload: { name: 'X' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('refuses work for a closed customer, and asks before work for one on hold', async () => {
    const held = await call<{ id: string }>(
      tokens.dispatcher,
      'POST',
      '/v1/customers',
      { name: 'Held Ltd', status: 'on_hold' },
      201,
    );
    const heldSite = await call<{ id: string }>(
      tokens.dispatcher,
      'POST',
      `/v1/customers/${held.id}/sites`,
      { name: 'HQ', address: { line1: 'High St' } },
      201,
    );
    const attempt = (extra: Record<string, unknown> = {}) =>
      api.call(tokens.dispatcher, {
        method: 'POST',
        url: '/v1/work-orders',
        payload: { customerId: held.id, siteId: heldSite.id, jobTypeId, ...extra },
      });
    expect(json<ErrorBody>(await attempt()).error.code).toBe('customer_on_hold');
    expect((await attempt({ acknowledgeOnHold: true })).statusCode).toBe(201);
    // A site of another customer is refused.
    const mixed = await api.call(tokens.dispatcher, {
      method: 'POST',
      url: '/v1/work-orders',
      payload: { customerId, siteId: heldSite.id, jobTypeId },
    });
    expect(json<ErrorBody>(mixed).error.code).toBe('site_not_customers');
    await call(tokens.dispatcher, 'PATCH', `/v1/customers/${held.id}`, { status: 'closed' });
    expect(json<ErrorBody>(await attempt({ acknowledgeOnHold: true })).error.code).toBe(
      'customer_closed',
    );
  });

  it('keeps account numbers unique, and shows engineers customers but lets only the office change them', async () => {
    const taken = await api.call(tokens.dispatcher, {
      method: 'POST',
      url: '/v1/customers',
      payload: { name: 'Copy', accountNumber: 'rh-001' },
    });
    expect(json<ErrorBody>(taken).error.code).toBe('account_number_taken');
    expect(
      (await call<{ items: unknown[] }>(tokens.engineer, 'GET', '/v1/customers?q=river')).items
        .length,
    ).toBe(1);
    expect(
      (
        await api.call(tokens.engineer, {
          method: 'POST',
          url: '/v1/customers',
          payload: { name: 'Nope' },
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('lists, bulk changes and saved views', () => {
  it('shows an engineer only their jobs, whatever they ask for', async () => {
    const theirs = await newJob([{ userId: people.engineer.userId }]);
    await newJob([{ userId: people.dispatcher.userId }]);
    const asked = await call<{ items: { id: string; crew: { id: string }[] }[] }>(
      tokens.engineer,
      'GET',
      `/v1/work-orders?assigneeId=${people.dispatcher.userId}&limit=200`,
    );
    expect(asked.items.map((item) => item.id)).toContain(theirs.workOrder.id);
    expect(
      asked.items.every((item) => item.crew.some((member) => member.id === people.engineer.userId)),
    ).toBe(true);
    await call(tokens.bystander, 'GET', `/v1/work-orders/${theirs.workOrder.id}`, undefined, 404);

    // What a phone asks for to keep a month of history: only closed jobs, only their own.
    const since = new Date(Date.now() - 60_000).toISOString();
    const closed = json<Detail>(
      await move(
        tokens.dispatcher,
        await newJob([{ userId: people.engineer.userId }]),
        'cancelled',
        'Duplicate',
      ),
    );
    const history = await call<{ items: { id: string; state: string }[] }>(
      tokens.engineer,
      'GET',
      `/v1/work-orders?closedSince=${encodeURIComponent(since)}&limit=200`,
    );
    expect(history.items.map((item) => item.id)).toContain(closed.workOrder.id);
    expect(history.items.map((item) => item.id)).not.toContain(theirs.workOrder.id);
    expect(
      history.items.every(
        (item) =>
          item.state === 'cancelled' || item.state === 'complete' || item.state === 'reviewed',
      ),
    ).toBe(true);
  });

  it('cancels many jobs, reporting each that cannot be cancelled without stopping the rest', async () => {
    const open = await newJob();
    const other = await newJob();
    let finished = await newJob([{ userId: people.engineer.userId }]);
    finished = json<Detail>(await move(tokens.dispatcher, finished, 'cancelled', 'Duplicate'));

    const { results } = await call<{
      results: { workOrderId: string; outcome: string; code: string | null }[];
    }>(tokens.dispatcher, 'POST', '/v1/work-orders/bulk', {
      action: 'cancel',
      workOrderIds: [open.workOrder.id, finished.workOrder.id, other.workOrder.id],
      reason: 'Contract ended',
    });
    expect(results.map((result) => [result.outcome, result.code])).toEqual([
      ['changed', null],
      ['refused', 'transition_not_allowed'],
      ['changed', null],
    ]);

    const shifted = await newJob([], { dueBy: '2026-10-01T17:00:00Z' });
    await call(tokens.dispatcher, 'POST', '/v1/work-orders/bulk', {
      action: 'reschedule',
      workOrderIds: [shifted.workOrder.id],
      shiftMinutes: 24 * 60,
      reason: 'Engineer off sick',
    });
    const undated = await newJob();
    const shiftUndated = await call<{ results: { outcome: string; code: string | null }[] }>(
      tokens.dispatcher,
      'POST',
      '/v1/work-orders/bulk',
      { action: 'reschedule', workOrderIds: [undated.workOrder.id], shiftMinutes: 60 },
    );
    expect(shiftUndated.results.map((result) => [result.outcome, result.code])).toEqual([
      ['refused', 'no_due_window'],
    ]);
    const after = await call<{ workOrder: { dueBy: string } }>(
      tokens.dispatcher,
      'GET',
      `/v1/work-orders/${shifted.workOrder.id}`,
    );
    expect(after.workOrder.dueBy).toBe('2026-10-02T17:00:00.000Z');

    await call(tokens.dispatcher, 'POST', '/v1/work-orders/bulk', {
      action: 'reassign',
      workOrderIds: [shifted.workOrder.id],
      crew: [{ userId: people.engineer.userId }, { userId: people.bystander.userId, lead: true }],
    });
    const crew = (
      await call<Detail>(tokens.dispatcher, 'GET', `/v1/work-orders/${shifted.workOrder.id}`)
    ).workOrder.crew;
    expect(crew.map((member) => [member.id, member.lead])).toEqual([
      [people.bystander.userId, true],
      [people.engineer.userId, false],
    ]);
  });

  it('saves a view, shares it, and only its owner deletes it', async () => {
    const view = await call<{ id: string }>(
      tokens.dispatcher,
      'POST',
      '/v1/saved-views',
      {
        name: 'Urgent this week',
        filters: { priority: ['urgent'], overdue: 'true' },
        shared: true,
      },
      201,
    );
    const seen = await call<{ items: { id: string; mine: boolean }[] }>(
      tokens.viewer,
      'GET',
      '/v1/saved-views',
    );
    expect(seen.items).toContainEqual(expect.objectContaining({ id: view.id, mine: false }));
    await call(tokens.viewer, 'DELETE', `/v1/saved-views/${view.id}`, undefined, 404);
    await call(tokens.dispatcher, 'DELETE', `/v1/saved-views/${view.id}`, undefined, 204);
  });
});

describe('form settings', () => {
  it('say which job types require a form, as P07’s settings screen shows', async () => {
    const updated = await call<{ requiredByJobTypeIds: string[] }>(
      tokens.builder,
      'PATCH',
      `/v1/forms/${optionalFormId}`,
      {
        requiredByJobTypeIds: [jobTypeId],
      },
    );
    expect(updated.requiredByJobTypeIds).toEqual([jobTypeId]);
    const job = await newJob();
    expect(job.forms.find((form) => form.formId === optionalFormId)?.required).toBe(true);
    await call(tokens.builder, 'PATCH', `/v1/forms/${optionalFormId}`, {
      requiredByJobTypeIds: [],
    });
  });
});

describe('importing a thousand jobs from CSV', () => {
  it(
    'writes every good row and reports each bad one by row and column, without aborting',
    { timeout: 180_000 },
    async () => {
      const header =
        'customer_account_number,site_name,job_type,description,priority,due_from,due_by,engineers,lead,favourite_colour';
      const good = (index: number) =>
        `RH-001,Block A,BOILER-SERVICE,Service flat ${String(index)},normal,2026-10-01 09:00,2026-10-01,${people.engineer.email},,blue`;
      const bad = new Map<number, [string, string]>([
        [17, ['RH-001,Block Z,BOILER-SERVICE,x,normal,,,,,', 'site_name']],
        [101, ['RH-001,Block A,BOILER-SERVICE,x,whenever,,,,,', 'priority']],
        [250, ['RH-001,Block A,BOILER-SERVICE,x,normal,2026-13-40,,,,', 'due_from']],
        [333, [`RH-001,Block A,BOILER-SERVICE,x,normal,,,nobody@nowhere.example,,`, 'engineers']],
        [512, ['RH-001,Block A,BOILER-SERVICE,x,normal,2026-10-02,2026-10-01,,,', 'due_by']],
        [777, ['RH-999,Block A,BOILER-SERVICE,x,normal,,,,,', 'customer_account_number']],
        [998, ['RH-001,Block A,NO-SUCH-TYPE,x,normal,,,,,', 'job_type']],
      ]);
      const lines = [header];
      for (let index = 1; index <= 1000; index += 1) {
        lines.push(bad.get(index)?.[0] ?? good(index));
      }
      const before = (
        await call<{ counts: Record<string, number> }>(tokens.owner, 'GET', '/v1/work-orders')
      ).counts.scheduled!;

      const started = await call<{ id: string; status: string }>(
        tokens.owner,
        'POST',
        '/v1/imports',
        {
          kind: 'work_orders',
          fileName: 'jobs.csv',
          csv: lines.join('\r\n'),
          timeZone: 'Europe/London',
        },
        202,
      );
      expect(started.status).toBe('pending');
      await runJobs('import.run');

      const report = await call<{
        status: string;
        totalRows: number;
        succeededRows: number;
        failedRows: number;
        errors: { row: number; column: string | null; code: string }[];
      }>(tokens.owner, 'GET', `/v1/imports/${started.id}`);
      expect(report).toMatchObject({
        status: 'completed',
        totalRows: 1000,
        succeededRows: 993,
        failedRows: 7,
      });
      // Spreadsheet rows: the header is row 1, so data row n is row n + 1.
      expect(
        report.errors.filter((error) => error.row > 1).map((error) => [error.row, error.column]),
      ).toEqual([...bad.entries()].map(([index, [, column]]) => [index + 1, column]));
      expect(report.errors[0]).toMatchObject({
        row: 1,
        code: 'unknown_column',
        column: 'favourite_colour',
      });

      const after = (
        await call<{ counts: Record<string, number> }>(tokens.owner, 'GET', '/v1/work-orders')
      ).counts.scheduled!;
      expect(after - before).toBe(993);

      // 09:00 in London in October is 08:00 UTC; a date alone for due_by is the end of that day there.
      const imported = await withTenant(api.tenantId, (tx) =>
        tx.workOrders.list({ text: 'flat 1000', order: 'created' }),
      );
      expect(imported.items[0]?.dueFrom?.toISOString()).toBe('2026-10-01T08:00:00.000Z');
      expect(imported.items[0]?.dueBy?.toISOString()).toBe('2026-10-01T22:59:59.000Z');

      const refused = await api.call(tokens.dispatcher, {
        method: 'POST',
        url: '/v1/imports',
        payload: { kind: 'customers', fileName: 'x.csv', csv: 'name\r\nX' },
      });
      expect(refused.statusCode).toBe(403);
    },
  );

  it('fails a file it cannot read as a whole, before writing any row', async () => {
    const started = await call<{ id: string }>(
      tokens.owner,
      'POST',
      '/v1/imports',
      {
        kind: 'sites',
        fileName: 'broken.csv',
        csv: 'customer_account_number,address_line1\r\nRH-001,"unclosed',
      },
      202,
    );
    await runJobs('import.run');
    const report = await call<{ status: string; errors: { code: string }[] }>(
      tokens.owner,
      'GET',
      `/v1/imports/${started.id}`,
    );
    expect(report.status).toBe('failed');
    expect(report.errors.map((error) => error.code)).toEqual(['csv_syntax']);
  });
});
