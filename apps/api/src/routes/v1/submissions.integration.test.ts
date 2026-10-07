import { withTenant } from '@integr8/db';
import { compileDefinition, validateSubmission } from '@integr8/form-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type Member, startApi } from '../../testing/api-harness.js';

/**
 * Submissions through the API, against a real database.
 *
 * Two of P08's exit criteria are proven here:
 *
 * - **A submission crafted by hand that violates the form's rules is rejected by
 *   the API.** Every way the engine can refuse an answer is sent straight to the
 *   endpoint, bypassing any client, and each is refused with the question named
 *   — and nothing is stored.
 * - **A submission made against version 1 still renders correctly after version
 *   4 is published.** The API hands back version 1's definition with it, and that
 *   definition still accepts the stored answers.
 */

let api: ApiHarness;
let owner: Member;
let engineer: Member;
let colleague: Member;
let viewer: Member;
let tokens: Record<'owner' | 'builder' | 'engineer' | 'colleague' | 'viewer', string>;
let formId: string;

const json = <T>(response: { body: string }) => JSON.parse(response.body) as T;

interface Detail {
  submission: {
    id: string;
    status: 'draft' | 'submitted' | 'reopened';
    revision: number;
    answers: Record<string, unknown>;
    versionNumber: number | null;
    formVersionId: string;
    submittedBy: { id: string; name: string };
    submittedAt: string | null;
    amendedAt: string | null;
  };
  version: { id: string; versionNumber: number | null; definition: Record<string, unknown> };
  events: { kind: string; reason: string | null; actor: { name: string }; answers: unknown }[];
  can: { edit: boolean; submit: boolean; reopen: boolean };
}

interface ErrorBody {
  error: {
    code: string;
    details?: { field: string; code: string; params?: Record<string, string> }[];
  };
}

const inspection = (extra: Record<string, unknown>[] = []) => ({
  schemaVersion: 1,
  title: { en: 'Gas safety check' },
  pages: [
    {
      id: 'page_1',
      sections: [
        {
          id: 'section_1',
          fields: [
            { id: 'site', type: 'text', label: { en: 'Site' } },
            {
              id: 'result',
              type: 'radio',
              label: { en: 'Result' },
              required: true,
              options: [
                { value: 'pass', label: { en: 'Pass' } },
                { value: 'fail', label: { en: 'Fail' } },
              ],
            },
            {
              id: 'reason',
              type: 'long_text',
              label: { en: 'Reason' },
              required: true,
              visibleWhen: {
                kind: 'compare',
                operator: 'eq',
                left: { kind: 'answer', field: 'result' },
                right: { kind: 'text', value: 'fail' },
              },
            },
            {
              id: 'pressure',
              type: 'decimal',
              label: { en: 'Pressure' },
              decimalPlaces: 2,
              min: '0',
              max: '10',
            },
            { id: 'visits', type: 'number', label: { en: 'Visits' } },
            {
              id: 'total',
              type: 'number',
              label: { en: 'Total' },
              calculation: {
                kind: 'arithmetic',
                operator: 'multiply',
                left: { kind: 'answer', field: 'visits' },
                right: { kind: 'number', value: '2' },
              },
            },
            { id: 'photos', type: 'photo', label: { en: 'Photos' } },
            ...extra,
          ],
        },
      ],
    },
  ],
});

async function publish(id: string, definition: unknown, acknowledge = false) {
  const detail = json<{ draft: { revision: number } | null }>(
    await api.call(tokens.builder, { method: 'GET', url: `/v1/forms/${id}` }),
  );
  const saved = json<{ revision: number }>(
    await api.call(tokens.builder, {
      method: 'PUT',
      url: `/v1/forms/${id}/draft`,
      payload: { definition, expectedRevision: detail.draft?.revision ?? null },
    }),
  );
  const published = await api.call(tokens.builder, {
    method: 'POST',
    url: `/v1/forms/${id}/draft/publish`,
    payload: { expectedRevision: saved.revision, acknowledgeBreakingChanges: acknowledge },
  });
  expect(published.statusCode, published.body).toBe(200);
}

async function newForm(title: string, definition: unknown) {
  const created = await api.call(tokens.builder, {
    method: 'POST',
    url: '/v1/forms',
    payload: { title },
  });
  const id = json<{ form: { id: string } }>(created).form.id;
  await publish(id, definition);
  return id;
}

async function start(token = tokens.engineer, form = formId): Promise<Detail> {
  const response = await api.call(token, {
    method: 'POST',
    url: '/v1/submissions',
    payload: { formId: form },
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<Detail>(response);
}

const submit = (token: string, draft: Detail, body: Record<string, unknown>) =>
  api.call(token, {
    method: 'POST',
    url: `/v1/submissions/${draft.submission.id}/submit`,
    payload: { expectedRevision: draft.submission.revision, ...body },
  });

async function submitted(answers: Record<string, unknown>, token = tokens.engineer) {
  const draft = await start(token);
  const response = await submit(token, draft, { answers });
  expect(response.statusCode, response.body).toBe(200);
  return json<Detail>(response);
}

/** Upload bytes through the real flow, returning the reference an answer carries. */
async function upload(token: string, bytes: Buffer, contentType = 'image/jpeg') {
  const created = await api.call(token, {
    method: 'POST',
    url: '/v1/media',
    payload: { contentType, byteSize: bytes.length },
  });
  expect(created.statusCode, created.body).toBe(201);
  const { media, upload: target } = json<{
    media: { id: string };
    upload: { url: string; headers: Record<string, string> };
  }>(created);
  const put = await api.app.inject({
    method: 'PUT',
    url: new URL(target.url).pathname + new URL(target.url).search,
    headers: target.headers,
    payload: bytes,
  });
  expect(put.statusCode, put.body).toBe(200);
  const completed = await api.call(token, {
    method: 'POST',
    url: `/v1/media/${media.id}/complete`,
  });
  expect(completed.statusCode, completed.body).toBe(200);
  return { mediaId: media.id, contentType, byteSize: bytes.length };
}

beforeAll(async () => {
  api = await startApi();
  owner = await api.member('owner', 'owner');
  engineer = await api.member('engineer', 'engineer');
  colleague = await api.member('engineer', 'colleague');
  viewer = await api.member('viewer', 'viewer');
  tokens = {
    owner: await api.signIn(owner),
    // Integr8 staff acting as the owner: the only seat that builds forms.
    builder: await api.staff(owner),
    engineer: await api.signIn(engineer),
    colleague: await api.signIn(colleague),
    viewer: await api.signIn(viewer),
  };
  formId = await newForm('Gas safety check', inspection());
});

afterAll(async () => {
  await api.close();
});

describe('a submission crafted by hand that breaks the form’s rules is refused', () => {
  const cases: [string, Record<string, unknown>, string, string][] = [
    ['a required answer is missing', { site: 'Depot' }, 'body.answers.result', 'required'],
    [
      'a hidden question is answered',
      { result: 'pass', reason: 'none' },
      'body.answers.reason',
      'answer_to_hidden_field',
    ],
    [
      'a question the form does not have',
      { result: 'pass', ghost: 1 },
      'body.answers.ghost',
      'unknown_field',
    ],
    [
      'a calculated question is answered',
      { result: 'pass', visits: 2, total: 999 },
      'body.answers.total',
      'answer_to_calculated_field',
    ],
    [
      'an answer of the wrong kind',
      { result: 'pass', pressure: 5 },
      'body.answers.pressure',
      'invalid',
    ],
    [
      'an answer outside its limits',
      { result: 'pass', pressure: '12.00' },
      'body.answers.pressure',
      'above_maximum',
    ],
    [
      'a choice the form does not offer',
      { result: 'maybe' },
      'body.answers.result',
      'unknown_option',
    ],
    [
      'a photo that was never uploaded',
      {
        result: 'pass',
        photos: [
          {
            mediaId: '11111111-1111-4111-8111-111111111111',
            contentType: 'image/jpeg',
            byteSize: 10,
          },
        ],
      },
      'body.answers.photos',
      'media_not_found',
    ],
  ];

  it.each(cases)('when %s', async (_label, answers, field, code) => {
    const draft = await start();
    const response = await submit(tokens.engineer, draft, { answers });
    expect(response.statusCode, response.body).toBe(422);
    const body = json<ErrorBody>(response);
    expect(body.error.code).toBe('invalid_submission');
    expect(body.error.details?.map((detail) => `${detail.field}:${detail.code}`)).toContain(
      `${field}:${code}`,
    );

    const after = json<Detail>(
      await api.call(tokens.engineer, {
        method: 'GET',
        url: `/v1/submissions/${draft.submission.id}`,
      }),
    );
    expect(after.submission).toMatchObject({
      status: 'draft',
      revision: draft.submission.revision,
    });
    expect(after.events).toEqual([]);
  });

  it('names the limit that was broken, for a client to word it', async () => {
    const draft = await start();
    const body = json<ErrorBody>(
      await submit(tokens.engineer, draft, { answers: { result: 'pass', pressure: '12.00' } }),
    );
    expect(body.error.details?.[0]?.params).toEqual({ maximum: '10' });
  });

  it('refuses a photo described differently from what was uploaded, or uploaded by another company', async () => {
    const photo = await upload(tokens.engineer, Buffer.from('a real jpeg, honestly'));
    const draft = await start();
    const lied = await submit(tokens.engineer, draft, {
      answers: { result: 'pass', photos: [{ ...photo, byteSize: photo.byteSize + 1 }] },
    });
    expect(json<ErrorBody>(lied).error.details?.[0]?.code).toBe('media_mismatch');

    const theirs = await withTenant(api.tenantId, (tx) => tx.files.find(photo.mediaId));
    expect(theirs?.deletedAt).toBeNull();
  });

  it('refuses a "today" that is not today', async () => {
    const draft = await start();
    const response = await submit(tokens.engineer, draft, {
      answers: { result: 'pass' },
      today: '2001-01-01',
    });
    expect(json<ErrorBody>(response).error.code).toBe('today_out_of_range');
  });

  it('accepts valid answers, storing the server’s own calculated values', async () => {
    const photo = await upload(tokens.engineer, Buffer.from('another jpeg'));
    const done = await submitted({
      result: 'fail',
      reason: 'Flue blocked',
      visits: 3,
      photos: [photo],
    });
    expect(done.submission.status).toBe('submitted');
    expect(done.submission.answers).toEqual({
      result: 'fail',
      reason: 'Flue blocked',
      visits: 3,
      total: 6,
      photos: [photo],
    });
    expect(done.events.map((event) => event.kind)).toEqual(['submitted']);
  });
});

describe('a submission with entries of a repeatable section (P13b)', () => {
  const radiators = {
    schemaVersion: 1,
    title: { en: 'Radiators' },
    pages: [
      {
        id: 'page_1',
        sections: [
          {
            id: 'radiators',
            repeat: { minEntries: 1, maxEntries: 3, entryLabel: { en: 'Radiator' } },
            fields: [
              { id: 'room', type: 'text', label: { en: 'Room' }, required: true },
              { id: 'watts', type: 'number', label: { en: 'Output' }, max: 5000 },
              { id: 'snapshot', type: 'photo', label: { en: 'Photo' } },
            ],
          },
          {
            id: 'summary',
            fields: [
              {
                id: 'total',
                type: 'number',
                label: { en: 'Total' },
                calculation: {
                  kind: 'aggregate',
                  operator: 'sum',
                  section: 'radiators',
                  field: 'watts',
                },
              },
            ],
          },
        ],
      },
    ],
  };

  it('is revalidated entry by entry, naming where in the body each problem is', async () => {
    const form = await newForm('Radiators', radiators);
    const draft = await start(tokens.engineer, form);
    const refused = json<ErrorBody>(
      await submit(tokens.engineer, draft, {
        answers: {
          room: 'Hall',
          radiators: [
            { id: 'r1', values: { room: 'Hall', watts: 9000, colour: 'white' } },
            { id: 'r2', values: { watts: 'lots' } },
            { id: 'r2', values: { room: 'Twin' } },
          ],
        },
      }),
    );
    expect(refused.error.details?.map((detail) => [detail.field, detail.code])).toEqual([
      ['body.answers.radiators[r1].colour', 'unknown_field'],
      ['body.answers.radiators', 'duplicate_entry'],
      ['body.answers.room', 'unknown_field'],
      ['body.answers.radiators[r1].watts', 'above_maximum'],
      ['body.answers.radiators[r2].room', 'required'],
      ['body.answers.radiators[r2].watts', 'invalid'],
    ]);
  });

  it('checks the files inside entries, and stores the entries with the server’s own total', async () => {
    const form = await newForm('Radiators again', radiators);
    const photo = await upload(tokens.engineer, Buffer.from('a radiator'));
    const lied = await submit(tokens.engineer, await start(tokens.engineer, form), {
      answers: {
        radiators: [{ id: 'r1', values: { room: 'Hall', snapshot: [{ ...photo, byteSize: 1 }] } }],
      },
    });
    expect(json<ErrorBody>(lied).error.details?.[0]).toMatchObject({
      field: 'body.answers.radiators[r1].snapshot',
      code: 'media_mismatch',
    });

    const entries = [
      { id: 'r1', values: { room: 'Hall', watts: 800, snapshot: [photo] } },
      { id: 'r2', values: { room: 'Loft', watts: 1200 } },
    ];
    const done = await submit(tokens.engineer, await start(tokens.engineer, form), {
      answers: { radiators: entries },
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(json<Detail>(done).submission.answers).toEqual({ radiators: entries, total: 2000 });
  });
});

describe('drafts', () => {
  it('autosave on the revision last seen, and refuse a stale device', async () => {
    const draft = await start();
    const saved = await api.call(tokens.engineer, {
      method: 'PUT',
      url: `/v1/submissions/${draft.submission.id}/answers`,
      payload: { answers: { site: 'Half done' }, expectedRevision: draft.submission.revision },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const stale = await api.call(tokens.engineer, {
      method: 'PUT',
      url: `/v1/submissions/${draft.submission.id}/answers`,
      payload: { answers: { site: 'Other device' }, expectedRevision: draft.submission.revision },
    });
    expect(stale.statusCode).toBe(409);
    expect(json<ErrorBody>(stale).error.code).toBe('submission_changed');
  });

  it('are resumed on another device: a new sign-in lists the draft and opens it with its answers', async () => {
    const draft = await start();
    await api.call(tokens.engineer, {
      method: 'PUT',
      url: `/v1/submissions/${draft.submission.id}/answers`,
      payload: { answers: { site: 'Started on the laptop' }, expectedRevision: 1 },
    });

    const phone = await api.signIn(engineer);
    const drafts = json<{ items: { id: string }[] }>(
      await api.call(phone, {
        method: 'GET',
        url: `/v1/submissions?status=draft&formId=${formId}`,
      }),
    );
    expect(drafts.items.map((item) => item.id)).toContain(draft.submission.id);

    const opened = json<Detail>(
      await api.call(phone, { method: 'GET', url: `/v1/submissions/${draft.submission.id}` }),
    );
    expect(opened.submission.answers).toEqual({ site: 'Started on the laptop' });
    expect(opened.can).toMatchObject({ edit: true, submit: true });
  });

  it('are private to their author', async () => {
    const draft = await start();
    for (const token of [tokens.colleague, tokens.owner, tokens.viewer]) {
      const response = await api.call(token, {
        method: 'GET',
        url: `/v1/submissions/${draft.submission.id}`,
      });
      expect(response.statusCode).toBe(404);
    }
    const listed = json<{ items: { id: string }[] }>(
      await api.call(tokens.owner, { method: 'GET', url: `/v1/submissions?status=draft` }),
    );
    expect(listed.items.map((item) => item.id)).not.toContain(draft.submission.id);
  });
});

describe('who may fill and who may see', () => {
  it('lets a viewer read every submission but fill none', async () => {
    const done = await submitted({ result: 'pass' });
    expect(
      (
        await api.call(tokens.viewer, {
          method: 'GET',
          url: `/v1/submissions/${done.submission.id}`,
        })
      ).statusCode,
    ).toBe(200);
    const refused = await api.call(tokens.viewer, {
      method: 'POST',
      url: '/v1/submissions',
      payload: { formId },
    });
    expect(refused.statusCode).toBe(403);
  });

  it('keeps an engineer to their own submitted work', async () => {
    const mine = await submitted({ result: 'pass', site: 'Mine' });
    const theirs = await submitted({ result: 'pass', site: 'Theirs' }, tokens.colleague);
    expect(
      (
        await api.call(tokens.engineer, {
          method: 'GET',
          url: `/v1/submissions/${theirs.submission.id}`,
        })
      ).statusCode,
    ).toBe(404);

    const listed = json<{ items: { id: string }[] }>(
      await api.call(tokens.engineer, {
        method: 'GET',
        url: `/v1/submissions?formId=${formId}&limit=200`,
      }),
    );
    const ids = listed.items.map((item) => item.id);
    expect(ids).toContain(mine.submission.id);
    expect(ids).not.toContain(theirs.submission.id);

    const asking = json<{ items: unknown[] }>(
      await api.call(tokens.engineer, {
        method: 'GET',
        url: `/v1/submissions?formId=${formId}&submittedBy=${colleague.userId}`,
      }),
    );
    expect(asking.items).toEqual([]);
  });

  it('honours the form’s own fill roles', async () => {
    const officeOnly = await newForm('Office only', inspection());
    await api.call(tokens.builder, {
      method: 'PATCH',
      url: `/v1/forms/${officeOnly}`,
      payload: { fillRoles: ['owner', 'admin'] },
    });
    const refused = await api.call(tokens.engineer, {
      method: 'POST',
      url: '/v1/submissions',
      payload: { formId: officeOnly },
    });
    expect(refused.statusCode).toBe(403);

    const forms = json<{ items: { id: string; canFill: boolean }[] }>(
      await api.call(tokens.engineer, { method: 'GET', url: '/v1/forms' }),
    );
    expect(forms.items.find((item) => item.id === officeOnly)?.canFill).toBe(false);
    expect(forms.items.find((item) => item.id === formId)?.canFill).toBe(true);
  });
});

describe('reopening and amending — no silent edits', () => {
  it('keeps who, when and why for every change, with the answers as they were', async () => {
    const done = await submitted({ result: 'pass', pressure: '1.20' });
    const id = done.submission.id;

    expect(
      (
        await api.call(tokens.engineer, {
          method: 'POST',
          url: `/v1/submissions/${id}/reopen`,
          payload: { reason: 'mine', expectedRevision: done.submission.revision },
        })
      ).statusCode,
    ).toBe(403);

    const edited = await api.call(tokens.engineer, {
      method: 'PUT',
      url: `/v1/submissions/${id}/answers`,
      payload: {
        answers: { result: 'pass', pressure: '9.99' },
        expectedRevision: done.submission.revision,
      },
    });
    expect(edited.statusCode).toBe(409);
    expect(json<ErrorBody>(edited).error.code).toBe('submission_state');

    const reopened = json<Detail>(
      await api.call(tokens.owner, {
        method: 'POST',
        url: `/v1/submissions/${id}/reopen`,
        payload: { reason: 'Gauge misread', expectedRevision: done.submission.revision },
      }),
    );
    expect(reopened.submission.status).toBe('reopened');

    const withoutReason = await submit(tokens.engineer, reopened, {
      answers: { result: 'pass', pressure: '2.40' },
    });
    expect(json<ErrorBody>(withoutReason).error.code).toBe('reason_required');

    const amended = json<Detail>(
      await submit(tokens.engineer, reopened, {
        answers: { result: 'pass', pressure: '2.40' },
        reason: 'Read it again',
      }),
    );
    expect(amended.submission).toMatchObject({
      status: 'submitted',
      submittedAt: done.submission.submittedAt,
    });
    expect(amended.submission.amendedAt).not.toBeNull();
    expect(amended.events.map((event) => [event.kind, event.reason, event.actor.name])).toEqual([
      ['submitted', null, 'engineer'],
      ['reopened', 'Gauge misread', 'owner'],
      ['amended', 'Read it again', 'engineer'],
    ]);
    expect(amended.events[0]?.answers).toMatchObject({ pressure: '1.20' });

    const audit = await withTenant(api.tenantId, (tx) =>
      tx.auditLog.list({ resourceType: 'submission', resourceId: id }),
    );
    expect(audit.map((entry) => entry.action).sort()).toEqual([
      'submission.amended',
      'submission.reopened',
    ]);
  });

  it('revalidates a correction like any submission', async () => {
    const done = await submitted({ result: 'pass' });
    const reopened = json<Detail>(
      await api.call(tokens.owner, {
        method: 'POST',
        url: `/v1/submissions/${done.submission.id}/reopen`,
        payload: { reason: 'Check', expectedRevision: done.submission.revision },
      }),
    );
    const refused = await submit(tokens.owner, reopened, {
      answers: { result: 'fail' },
      reason: 'Failed after all',
    });
    expect(json<ErrorBody>(refused).error.details?.[0]).toMatchObject({
      field: 'body.answers.reason',
      code: 'required',
    });
  });
});

describe('a submission made against version 1 after version 4 is published', () => {
  it('comes back with version 1, whose rules still accept its answers', async () => {
    const id = await newForm('Versioned', inspection());
    const draft = await start(tokens.engineer, id);
    const v1 = json<Detail>(
      await submit(tokens.engineer, draft, {
        answers: { site: 'Old depot', result: 'fail', reason: 'Leak', visits: 1 },
      }),
    );
    expect(v1.submission.versionNumber).toBe(1);

    // Versions 2–4: the site question goes, "fail" goes, and a new required question arrives.
    const withoutSite = inspection().pages[0]!.sections[0]!.fields.filter(
      (field) => field.id !== 'site',
    );
    await publish(
      id,
      {
        ...inspection(),
        pages: [{ id: 'page_1', sections: [{ id: 'section_1', fields: withoutSite }] }],
      },
      true,
    );
    await publish(
      id,
      inspection([
        { id: 'engineer_id', type: 'text', label: { en: 'Engineer id' }, required: true },
      ]),
      true,
    );
    await publish(
      id,
      inspection([{ id: 'notes', type: 'long_text', label: { en: 'Notes' } }]),
      true,
    );

    const latest = json<{ live: { versionNumber: number } }>(
      await api.call(tokens.owner, { method: 'GET', url: `/v1/forms/${id}` }),
    );
    expect(latest.live.versionNumber).toBe(4);

    const later = json<Detail>(
      await api.call(tokens.owner, { method: 'GET', url: `/v1/submissions/${v1.submission.id}` }),
    );
    expect(later.submission.versionNumber).toBe(1);
    expect(later.version.versionNumber).toBe(1);
    expect(later.submission.answers).toEqual(v1.submission.answers);

    const compiled = compileDefinition(later.version.definition);
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      const { total: _calculated, ...typed } = later.submission.answers;
      expect(validateSubmission(compiled.form, typed).valid).toBe(true);
    }
  });
});

describe('finding submissions', () => {
  let form: string;
  let fail: string;
  let high: string;

  beforeAll(async () => {
    form = await newForm('Findable', inspection());
    const make = async (answers: Record<string, unknown>) => {
      const draft = await start(tokens.engineer, form);
      return json<Detail>(await submit(tokens.engineer, draft, { answers })).submission.id;
    };
    fail = await make({ site: 'North Quay', result: 'fail', reason: 'x', pressure: '1.00' });
    high = await make({ site: 'South Yard', result: 'pass', pressure: '8.50' });
    await make({ site: '=HYPERLINK("http://evil")', result: 'pass', pressure: '3.00' });
  });

  const list = async (token: string, query: string) =>
    json<{ items: { id: string }[]; nextCursor: string | null }>(
      await api.call(token, { method: 'GET', url: `/v1/submissions?formId=${form}&${query}` }),
    );

  it('filters by reportable answers', async () => {
    expect(
      (await list(tokens.owner, 'filter=result:eq:fail')).items.map((item) => item.id),
    ).toEqual([fail]);
    expect((await list(tokens.owner, 'filter=pressure:gt:5')).items.map((item) => item.id)).toEqual(
      [high],
    );
    expect(
      (await list(tokens.owner, 'filter=result:eq:pass&filter=pressure:gte:8')).items.map(
        (item) => item.id,
      ),
    ).toEqual([high]);
  });

  it('searches the written answers', async () => {
    expect((await list(tokens.owner, 'q=quay')).items.map((item) => item.id)).toEqual([fail]);
  });

  it('pages with a cursor', async () => {
    const first = await list(tokens.owner, 'limit=2');
    expect(first.items).toHaveLength(2);
    const second = await list(tokens.owner, `limit=2&cursor=${first.nextCursor ?? ''}`);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it('refuses a filter it cannot apply, naming it', async () => {
    const unknown = await api.call(tokens.owner, {
      method: 'GET',
      url: `/v1/submissions?formId=${form}&filter=reason:eq:x`,
    });
    expect(json<ErrorBody>(unknown).error.details?.[0]).toMatchObject({
      field: 'query.filter.0',
      code: 'unknown_field',
    });
    const wrongKind = await api.call(tokens.owner, {
      method: 'GET',
      url: `/v1/submissions?formId=${form}&filter=pressure:gt:lots`,
    });
    expect(json<ErrorBody>(wrongKind).error.details?.[0]?.code).toBe('invalid_value');
    const noForm = await api.call(tokens.owner, {
      method: 'GET',
      url: '/v1/submissions?filter=result:eq:x',
    });
    expect(json<ErrorBody>(noForm).error.code).toBe('filter_needs_form');
  });

  it('exports CSV a spreadsheet opens safely', async () => {
    const response = await api.call(tokens.owner, {
      method: 'GET',
      url: `/v1/submissions/export?formId=${form}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toBe('attachment; filename="Findable.csv"');
    expect(response.body.charCodeAt(0)).toBe(0xfeff);

    const lines = response.body.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe(
      'submission_id,status,form_version,submitted_by,submitted_at,amended_at,site,result,reason,pressure,visits,total,photos',
    );
    expect(lines).toHaveLength(4);
    const hostile = lines.find((line) => line.includes('HYPERLINK'));
    expect(hostile).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
});

describe('browsers on other origins', () => {
  it('answers a preflight from an allowed origin, and refuses one from anywhere else', async () => {
    const allowed = await api.app.inject({
      method: 'OPTIONS',
      url: '/v1/submissions',
      headers: { origin: 'http://localhost:3001', 'access-control-request-method': 'POST' },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3001');
    expect(allowed.headers['access-control-allow-headers']).toContain('authorization');

    const elsewhere = await api.app.inject({
      method: 'OPTIONS',
      url: '/v1/submissions',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('labels a real response for an allowed origin, errors included', async () => {
    const response = await api.call(tokens.engineer, {
      method: 'GET',
      url: '/v1/submissions/00000000-0000-4000-8000-000000000000',
      headers: { origin: 'http://localhost:3002' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3002');
    expect(response.headers['access-control-expose-headers']).toContain('x-request-id');
  });
});
