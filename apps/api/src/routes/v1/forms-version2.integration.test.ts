import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UPDATE_APP_MARK } from '../../sync/form-formats.js';
import { type ApiHarness, type Member, startApi } from '../../testing/api-harness.js';

/**
 * Form schema version 2 (1.3.0) through the API: the server sets the format a
 * draft needs, submissions leave Information blocks out and work out date and
 * time calculations themselves, and a phone too old for a form is told so in
 * the form's name.
 */

let api: ApiHarness;
let engineer: Member;
let builder: string;
let officeToken: string;
let engineerToken: string;
let formId: string;

const json = <T>(response: LightMyRequestResponse): T => JSON.parse(response.body) as T;

const label = (en: string) => ({ en });

const version2 = {
  schemaVersion: 1,
  title: label('Boiler service'),
  pages: [
    {
      id: 'page_1',
      description: label('Read before you start.'),
      sections: [
        {
          id: 'section_1',
          fields: [
            {
              id: 'result',
              type: 'radio',
              label: label('Result'),
              options: [
                { value: 'pass', label: label('Pass') },
                { value: 'fail', label: label('Fail') },
              ],
            },
            {
              id: 'isolate',
              type: 'information',
              body: label('Isolate the supply first.'),
              style: 'warning',
            },
            { id: 'serviced', type: 'date', label: label('Serviced on') },
            {
              id: 'due',
              type: 'date',
              label: label('Next service due'),
              calculation: {
                kind: 'shift_date',
                operator: 'add',
                unit: 'months',
                date: { kind: 'answer', field: 'serviced' },
                amount: { kind: 'number', value: '1' },
              },
            },
            { id: 'arrived', type: 'datetime', label: label('Arrived') },
            {
              id: 'on_site',
              type: 'number',
              label: label('Minutes on site'),
              calculation: {
                kind: 'difference',
                unit: 'minutes',
                from: { kind: 'answer', field: 'arrived' },
                to: { kind: 'now' },
              },
            },
          ],
        },
      ],
    },
  ],
};

async function call<T>(
  token: string,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
  expected = 200,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await api.call(token, {
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(expected);
  return json<T>(response);
}

beforeAll(async () => {
  api = await startApi();
  const owner = await api.member('owner', 'owner');
  engineer = await api.member('engineer', 'eve');
  builder = await api.staff(owner);
  officeToken = await api.signIn(owner);
  engineerToken = await api.signIn(engineer, 'mobile');
  formId = (
    await call<{ form: { id: string } }>(builder, 'POST', '/v1/forms', { title: 'Boiler' }, 201)
  ).form.id;
});

afterAll(async () => {
  await api.close();
});

describe('form schema version 2 through the API', () => {
  it('stores a draft with the format it needs, whatever the builder sent', async () => {
    const detail = await call<{ draft: { revision: number } }>(
      builder,
      'GET',
      `/v1/forms/${formId}`,
    );
    const saved = await call<{ revision: number; definition: { schemaVersion: number } }>(
      builder,
      'PUT',
      `/v1/forms/${formId}/draft`,
      { expectedRevision: detail.draft.revision, definition: version2 },
    );
    expect(saved.definition.schemaVersion).toBe(2);

    // Without the additions it is a format 1 form again, even if it says 2.
    const plain = await call<{ revision: number; definition: { schemaVersion: number } }>(
      builder,
      'PUT',
      `/v1/forms/${formId}/draft`,
      {
        expectedRevision: saved.revision,
        definition: {
          ...version2,
          schemaVersion: 2,
          pages: [
            {
              id: 'page_1',
              sections: [
                { id: 'section_1', fields: [{ id: 'note', type: 'text', label: label('Note') }] },
              ],
            },
          ],
        },
      },
    );
    expect(plain.definition.schemaVersion).toBe(1);

    const final = await call<{ revision: number }>(builder, 'PUT', `/v1/forms/${formId}/draft`, {
      expectedRevision: plain.revision,
      definition: version2,
    });
    await call(builder, 'POST', `/v1/forms/${formId}/draft/publish`, {
      expectedRevision: final.revision,
    });
  });

  it('refuses an answer to an Information block, and works out date and time calculations itself', async () => {
    const draft = await call<{ submission: { id: string; revision: number } }>(
      engineerToken,
      'POST',
      '/v1/submissions',
      { formId },
      201,
    );
    const refused = await api.call(engineerToken, {
      method: 'POST',
      url: `/v1/submissions/${draft.submission.id}/submit`,
      payload: {
        expectedRevision: draft.submission.revision,
        answers: { result: 'pass', isolate: 'read it' },
      },
    });
    expect(refused.statusCode).toBe(422);
    expect(json<{ error: { details: { code: string }[] } }>(refused).error.details).toEqual([
      expect.objectContaining({ code: 'unknown_field' }),
    ]);

    const arrived = new Date(Date.now() - 90 * 60 * 1000);
    const done = await call<{ submission: { answers: Record<string, unknown> } }>(
      engineerToken,
      'POST',
      `/v1/submissions/${draft.submission.id}/submit`,
      {
        expectedRevision: draft.submission.revision,
        answers: {
          result: 'pass',
          serviced: '2026-01-31',
          arrived: `${arrived.toISOString().slice(0, 19)}Z`,
        },
      },
    );
    expect(done.submission.answers.due).toBe('2026-02-28');
    expect(done.submission.answers.on_site).toBeGreaterThanOrEqual(89);
    expect(done.submission.answers.on_site).toBeLessThanOrEqual(91);
    expect(done.submission.answers).not.toHaveProperty('isolate');
  });

  it('names a form for a phone too old to open it, and only for that phone', async () => {
    const types = await call<{ id: string }>(
      builder,
      'POST',
      '/v1/job-types',
      { name: 'Service', code: 'service-v2', forms: [{ formId, required: true }] },
      201,
    );
    const customer = await call<{ id: string }>(
      officeToken,
      'POST',
      '/v1/customers',
      { name: 'Riverside' },
      201,
    );
    const site = await call<{ id: string }>(
      officeToken,
      'POST',
      `/v1/customers/${customer.id}/sites`,
      { name: 'Block A', address: { line1: '1 River Road' } },
      201,
    );
    await call(
      officeToken,
      'POST',
      '/v1/work-orders',
      {
        customerId: customer.id,
        siteId: site.id,
        jobTypeId: types.id,
        crew: [{ userId: engineer.userId, lead: true }],
      },
      201,
    );

    interface Pulled {
      forms: {
        form: { id: string; title: string };
        live: { definition: { schemaVersion: number } };
      }[];
      workOrders: { forms: { formId: string; title: string }[] }[];
    }
    const pull = (version: string) =>
      call<Pulled>(engineerToken, 'GET', '/v1/sync/pull', undefined, 200, {
        'x-client-version': version,
        'x-client-app': 'mobile',
      });

    const old = await pull('1.2.4');
    const oldForm = old.forms.find((detail) => detail.form.id === formId)!;
    expect(oldForm.form.title).toBe(`Boiler${UPDATE_APP_MARK}`);
    expect(oldForm.live.definition.schemaVersion).toBe(2);
    expect(old.workOrders[0]!.forms.map((form) => form.title)).toEqual([
      `Boiler${UPDATE_APP_MARK}`,
    ]);

    const current = await pull('1.3.0');
    expect(current.forms.find((detail) => detail.form.id === formId)!.form.title).toBe('Boiler');
    expect(current.workOrders[0]!.forms[0]!.title).toBe('Boiler');
  });
});
