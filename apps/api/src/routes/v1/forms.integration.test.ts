import { withTenant } from '@integr8/db';
import { rowAsText, syncFormTemplates } from '@integr8/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type Member, startApi } from '../../testing/api-harness.js';

/**
 * The form builder's API, end to end, against a real database.
 *
 * Two of P07's exit criteria are proven here rather than asserted:
 *
 * - **Publishing an invalid definition is impossible, and the errors name the
 *   offending fields.** The only route to a published version is `publish`, and
 *   it refuses anything that does not compile.
 * - **Editing and republishing leaves every existing submission byte-identical.**
 *   A submission's row is read as raw JSON text before and after a breaking
 *   republish, and compared as strings.
 */

let api: ApiHarness;
let owner: Member;
let engineer: Member;
let ownerToken: string;
let engineerToken: string;

const json = <T>(response: { body: string }) => JSON.parse(response.body) as T;

interface Version {
  id: string;
  status: 'draft' | 'published';
  versionNumber: number | null;
  revision: number;
  definition: Record<string, unknown>;
  changeNote: string | null;
  changes: Record<string, unknown> | null;
}

interface Detail {
  form: {
    id: string;
    title: string;
    fillRoles: string[];
    signatureRequired: boolean;
    clonedFromFormId: string | null;
    sourceTemplateKey: string | null;
  };
  draft: Version | null;
  live: Version | null;
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: { field: string; code: string; message: string }[];
  };
}

const inspection = (extra: Record<string, unknown>[] = []) => ({
  schemaVersion: 1,
  title: { en: 'Inspection' },
  pages: [
    {
      id: 'page_1',
      sections: [
        {
          id: 'section_1',
          fields: [
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
              visibleWhen: {
                kind: 'compare',
                operator: 'eq',
                left: { kind: 'answer', field: 'result' },
                right: { kind: 'text', value: 'fail' },
              },
            },
            ...extra,
          ],
        },
      ],
    },
  ],
});

async function createForm(title: string): Promise<Detail> {
  const response = await api.call(ownerToken, {
    method: 'POST',
    url: '/v1/forms',
    payload: { title },
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<Detail>(response);
}

async function save(formId: string, definition: unknown, expectedRevision: number | null) {
  return api.call(ownerToken, {
    method: 'PUT',
    url: `/v1/forms/${formId}/draft`,
    payload: { definition, expectedRevision },
  });
}

async function publish(
  formId: string,
  expectedRevision: number,
  extra: Record<string, unknown> = {},
) {
  return api.call(ownerToken, {
    method: 'POST',
    url: `/v1/forms/${formId}/draft/publish`,
    payload: { expectedRevision, ...extra },
  });
}

beforeAll(async () => {
  api = await startApi();
  owner = await api.member('owner', 'owner');
  engineer = await api.member('engineer', 'engineer');
  ownerToken = await api.signIn(owner);
  engineerToken = await api.signIn(engineer);
});

afterAll(async () => {
  await api.close();
});

describe('starting a form', () => {
  it('creates the form with an empty first draft titled in the builder’s language', async () => {
    const response = await api.call(ownerToken, {
      method: 'POST',
      url: '/v1/forms',
      payload: { title: 'صيانة', locale: 'ar' },
    });
    expect(response.statusCode).toBe(201);
    const detail = json<Detail>(response);
    expect(detail.form).toMatchObject({
      title: 'صيانة',
      fillRoles: ['owner', 'admin', 'dispatcher', 'engineer', 'viewer'],
      signatureRequired: false,
    });
    expect(detail.draft).toMatchObject({
      status: 'draft',
      revision: 1,
      definition: { title: { ar: 'صيانة' } },
    });
    expect(detail.live).toBeNull();
  });

  it('is refused to someone who may only fill forms', async () => {
    const response = await api.call(engineerToken, {
      method: 'POST',
      url: '/v1/forms',
      payload: { title: 'Nope' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('autosave', () => {
  it('saves over the revision it last saw, and refuses a stale save', async () => {
    const { form } = await createForm('Autosave');

    const saved = await save(form.id, inspection(), 1);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(json<Version>(saved).revision).toBe(2);

    const stale = await save(
      form.id,
      inspection([{ id: 'extra', type: 'text', label: { en: 'x' } }]),
      1,
    );
    expect(stale.statusCode).toBe(409);
    expect(json<ErrorBody>(stale).error.code).toBe('draft_conflict');
  });

  it('stores a draft that does not compile yet, because a half-built form is what a draft is', async () => {
    const { form } = await createForm('Half built');
    const broken = {
      ...inspection(),
      pages: [
        {
          id: 'page_1',
          sections: [
            {
              id: 'section_1',
              fields: [
                {
                  id: 'x',
                  type: 'text',
                  label: { en: 'x' },
                  visibleWhen: { kind: 'answered', field: 'missing' },
                },
              ],
            },
          ],
        },
      ],
    };
    expect((await save(form.id, broken, 1)).statusCode).toBe(200);
  });

  it('refuses a body that is not a definition at all', async () => {
    const { form } = await createForm('Not a definition');
    expect((await save(form.id, { pages: [] }, 1)).statusCode).toBe(422);
  });
});

describe('checking and publishing — an invalid definition cannot be published', () => {
  it('reports every broken reference at once, naming the fields, before anything is published', async () => {
    const { form } = await createForm('Invalid');
    const invalid = inspection([
      {
        id: 'why',
        type: 'text',
        label: { en: 'Why' },
        visibleWhen: {
          kind: 'compare',
          operator: 'eq',
          left: { kind: 'answer', field: 'result' },
          right: { kind: 'text', value: 'fial' },
        },
      },
      {
        id: 'orphan',
        type: 'text',
        label: { en: 'Orphan' },
        visibleWhen: { kind: 'answered', field: 'ghost' },
      },
    ]);
    await save(form.id, invalid, 1);

    const check = await api.call(ownerToken, {
      method: 'POST',
      url: `/v1/forms/${form.id}/draft/check`,
    });
    expect(check.statusCode).toBe(200);
    const verdict = json<{
      valid: boolean;
      issues: { code: string; message: string; path: string; elements: string[] }[];
    }>(check);
    expect(verdict.valid).toBe(false);
    expect(verdict.issues).toEqual([
      {
        code: 'unknown_option',
        message: '"result" has no option "fial"',
        path: 'pages[0].sections[0].fields[2].visibleWhen',
        elements: ['result'],
      },
      {
        code: 'unknown_field',
        message: 'A rule refers to "ghost", which is not in this form',
        path: 'pages[0].sections[0].fields[3].visibleWhen',
        elements: ['ghost'],
      },
    ]);
  });

  it('refuses to publish it with 422, and the details name the fields', async () => {
    const { form } = await createForm('Refused');
    await save(
      form.id,
      inspection([
        {
          id: 'loop',
          type: 'text',
          label: { en: 'Loop' },
          visibleWhen: { kind: 'answered', field: 'loop' },
        },
      ]),
      1,
    );

    const response = await publish(form.id, 2);
    expect(response.statusCode).toBe(422);
    const body = json<ErrorBody>(response);
    expect(body.error.code).toBe('invalid_definition');
    expect(body.error.details).toEqual([
      {
        field: 'definition.pages[0].sections[0].fields[2]',
        code: 'circular_dependency',
        message:
          'Circular rule: field "loop" is shown depending on itself. None of these can be worked out until another one is.',
      },
    ]);

    const after = json<Detail>(
      await api.call(ownerToken, { method: 'GET', url: `/v1/forms/${form.id}` }),
    );
    expect(after.live).toBeNull();
    expect(after.draft?.status).toBe('draft');
  });

  it('publishes a valid draft as version 1, with its note and change summary, and audits it', async () => {
    const { form } = await createForm('Valid');
    await save(form.id, inspection(), 1);

    const response = await publish(form.id, 2, { changeNote: 'First version' });
    expect(response.statusCode, response.body).toBe(200);
    const version = json<Version>(response);
    expect(version).toMatchObject({
      status: 'published',
      versionNumber: 1,
      changeNote: 'First version',
    });
    expect((version.changes as { changes: unknown[]; breaking: unknown[] }).breaking).toEqual([]);

    const audit = await withTenant(api.tenantId, (tx) =>
      tx.auditLog.list({ resourceType: 'form', resourceId: form.id }),
    );
    expect(audit.map((entry) => entry.action)).toEqual(['form.published']);
  });

  it('refuses to publish a draft that was saved again after it was reviewed', async () => {
    const { form } = await createForm('Stale publish');
    await save(form.id, inspection(), 1);
    await save(form.id, inspection([{ id: 'late', type: 'text', label: { en: 'Late' } }]), 2);

    const response = await publish(form.id, 2);
    expect(response.statusCode).toBe(409);
    expect(json<ErrorBody>(response).error.code).toBe('draft_changed');
  });

  it('answers 404 for a form with no draft to publish', async () => {
    const { form } = await createForm('Published away');
    await save(form.id, inspection(), 1);
    await publish(form.id, 2);
    expect((await publish(form.id, 2)).statusCode).toBe(404);
  });
});

describe('republishing — existing submissions stay byte-identical', () => {
  it('leaves a submission made against version 1 untouched by a breaking version 2', async () => {
    const { form } = await createForm('Republished');
    await save(form.id, inspection(), 1);
    const v1 = json<Version>(await publish(form.id, 2));

    const submission = await withTenant(api.tenantId, (tx) =>
      tx.submissions.create({
        formVersionId: v1.id,
        answers: { result: 'fail', reason: 'Seal perished' },
        submittedBy: engineer.userId,
      }),
    );
    const submissionBefore = await rowAsText('submissions', submission.id);
    const versionBefore = await rowAsText('form_versions', v1.id);

    // Version 2 removes "reason" and the "fail" option: both breaking.
    const detail = json<Detail>(
      await api.call(ownerToken, { method: 'GET', url: `/v1/forms/${form.id}` }),
    );
    expect(detail.draft).toBeNull();
    const edited = {
      ...inspection(),
      pages: [
        {
          id: 'page_1',
          sections: [
            {
              id: 'section_1',
              fields: [
                {
                  id: 'result',
                  type: 'radio',
                  label: { en: 'Result' },
                  required: true,
                  options: [{ value: 'pass', label: { en: 'Pass' } }],
                },
              ],
            },
          ],
        },
      ],
    };
    const draft = json<Version>(await save(form.id, edited, null));

    const unacknowledged = await publish(form.id, draft.revision);
    expect(unacknowledged.statusCode).toBe(409);
    expect(json<ErrorBody>(unacknowledged).error.code).toBe('breaking_changes_unacknowledged');

    const check = json<{ diff: { breaking: { field: string; reason: string }[] } }>(
      await api.call(ownerToken, { method: 'POST', url: `/v1/forms/${form.id}/draft/check` }),
    );
    expect(check.diff.breaking.map((entry) => `${entry.field}:${entry.reason}`)).toEqual([
      'result:option_removed',
      'reason:field_removed',
    ]);

    const v2 = await publish(form.id, draft.revision, {
      acknowledgeBreakingChanges: true,
      changeNote: 'Fail handled elsewhere',
    });
    expect(v2.statusCode, v2.body).toBe(200);
    expect(json<Version>(v2).versionNumber).toBe(2);

    expect(submissionBefore).toBeDefined();
    expect(await rowAsText('submissions', submission.id)).toBe(submissionBefore);
    expect(await rowAsText('form_versions', v1.id)).toBe(versionBefore);
  });
});

describe('who sees what', () => {
  it('shows an engineer only published forms, and never a draft', async () => {
    const unpublished = await createForm('Only a draft');
    const published = await createForm('Published');
    await save(published.form.id, inspection(), 1);
    await publish(published.form.id, 2);
    await save(
      published.form.id,
      inspection([{ id: 'next', type: 'text', label: { en: 'Next' } }]),
      null,
    );

    const list = json<{ items: { id: string; hasDraft: boolean }[] }>(
      await api.call(engineerToken, { method: 'GET', url: '/v1/forms' }),
    );
    expect(list.items.some((item) => item.id === unpublished.form.id)).toBe(false);
    expect(list.items.find((item) => item.id === published.form.id)?.hasDraft).toBe(false);

    const ownerList = json<{ items: { id: string; hasDraft: boolean }[] }>(
      await api.call(ownerToken, { method: 'GET', url: '/v1/forms' }),
    );
    expect(ownerList.items.find((item) => item.id === published.form.id)?.hasDraft).toBe(true);

    const detail = json<Detail>(
      await api.call(engineerToken, { method: 'GET', url: `/v1/forms/${published.form.id}` }),
    );
    expect(detail.draft).toBeNull();
    expect(detail.live?.versionNumber).toBe(1);

    expect(
      (await api.call(engineerToken, { method: 'GET', url: `/v1/forms/${unpublished.form.id}` }))
        .statusCode,
    ).toBe(404);

    const ownerDetail = json<Detail>(
      await api.call(ownerToken, { method: 'GET', url: `/v1/forms/${published.form.id}` }),
    );
    const draftId = ownerDetail.draft?.id ?? '';
    expect(
      (
        await api.call(engineerToken, {
          method: 'GET',
          url: `/v1/forms/${published.form.id}/versions/${draftId}`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await api.call(ownerToken, {
          method: 'GET',
          url: `/v1/forms/${published.form.id}/versions/${draftId}`,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('refuses every builder action to an engineer', async () => {
    const { form } = await createForm('Guarded');
    for (const [method, url, payload] of [
      ['PUT', `/v1/forms/${form.id}/draft`, { definition: inspection(), expectedRevision: 1 }],
      ['POST', `/v1/forms/${form.id}/draft/check`, undefined],
      ['POST', `/v1/forms/${form.id}/draft/publish`, { expectedRevision: 1 }],
      ['POST', `/v1/forms/${form.id}/draft/test-submission`, { answers: {} }],
      ['PATCH', `/v1/forms/${form.id}`, { title: 'x' }],
      ['POST', `/v1/forms/${form.id}/clone`, { title: 'x' }],
    ] as const) {
      const response = await api.call(engineerToken, {
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});

describe('history', () => {
  it('lists published versions newest first, and serves any one read-only', async () => {
    const { form } = await createForm('History');
    await save(form.id, inspection(), 1);
    await publish(form.id, 2, { changeNote: 'One' });
    const second = json<Version>(
      await save(
        form.id,
        inspection([{ id: 'added', type: 'checkbox', label: { en: 'Added' } }]),
        null,
      ),
    );
    await publish(form.id, second.revision, { changeNote: 'Two' });

    const history = json<{ items: Version[] }>(
      await api.call(engineerToken, { method: 'GET', url: `/v1/forms/${form.id}/versions` }),
    );
    expect(
      history.items.map(
        (version) => `${String(version.versionNumber)}:${version.changeNote ?? ''}`,
      ),
    ).toEqual(['2:Two', '1:One']);

    const v1 = history.items[1]!;
    const read = await api.call(engineerToken, {
      method: 'GET',
      url: `/v1/forms/${form.id}/versions/${v1.id}`,
    });
    expect(read.statusCode).toBe(200);
    expect(json<Version>(read).definition).toEqual(inspection());

    expect(
      (
        await api.call(ownerToken, {
          method: 'GET',
          url: `/v1/forms/${form.id}/versions/00000000-0000-4000-8000-000000000000`,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('test fill', () => {
  it('runs the server’s real validation against the draft and stores nothing', async () => {
    const { form } = await createForm('Test fill');
    await save(form.id, inspection(), 1);
    const before = await withTenant(api.tenantId, (tx) => tx.submissions.listForVersion(form.id));

    const invalid = await api.call(ownerToken, {
      method: 'POST',
      url: `/v1/forms/${form.id}/draft/test-submission`,
      payload: { answers: { result: 'pass', reason: 'hidden, so refused', ghost: 1 } },
    });
    expect(invalid.statusCode).toBe(200);
    expect(json(invalid)).toEqual({
      valid: false,
      issues: [
        { code: 'unknown_field', field: 'ghost' },
        { code: 'answer_to_hidden_field', field: 'reason' },
      ],
      errors: [],
      answers: { result: 'pass' },
      stored: false,
    });

    const valid = json<{ valid: boolean }>(
      await api.call(ownerToken, {
        method: 'POST',
        url: `/v1/forms/${form.id}/draft/test-submission`,
        payload: { answers: { result: 'fail', reason: 'x' } },
      }),
    );
    expect(valid.valid).toBe(true);

    const draftId =
      json<Detail>(await api.call(ownerToken, { method: 'GET', url: `/v1/forms/${form.id}` })).draft
        ?.id ?? '';
    const after = await withTenant(api.tenantId, (tx) => tx.submissions.listForVersion(draftId));
    expect(after).toEqual([]);
    expect(before).toEqual([]);
  });

  it('refuses to test-fill a draft that does not compile, naming the fields', async () => {
    const { form } = await createForm('Broken test fill');
    await save(
      form.id,
      inspection([
        {
          id: 'loop',
          type: 'text',
          label: { en: 'Loop' },
          visibleWhen: { kind: 'answered', field: 'loop' },
        },
      ]),
      1,
    );
    const response = await api.call(ownerToken, {
      method: 'POST',
      url: `/v1/forms/${form.id}/draft/test-submission`,
      payload: { answers: {} },
    });
    expect(response.statusCode).toBe(422);
    expect(json<ErrorBody>(response).error.details?.[0]?.code).toBe('circular_dependency');
  });
});

describe('settings and cloning', () => {
  it('changes who may fill a form and whether a signature is required', async () => {
    const { form } = await createForm('Settings');
    const response = await api.call(ownerToken, {
      method: 'PATCH',
      url: `/v1/forms/${form.id}`,
      payload: { fillRoles: ['engineer', 'dispatcher'], signatureRequired: true, title: 'Renamed' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(json(response)).toMatchObject({
      title: 'Renamed',
      fillRoles: ['engineer', 'dispatcher'],
      signatureRequired: true,
    });

    expect(
      (await api.call(ownerToken, { method: 'PATCH', url: `/v1/forms/${form.id}`, payload: {} }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await api.call(ownerToken, {
          method: 'PATCH',
          url: `/v1/forms/${form.id}`,
          payload: { fillRoles: [] },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await api.call(ownerToken, {
          method: 'PATCH',
          url: '/v1/forms/00000000-0000-4000-8000-000000000000',
          payload: { title: 'x' },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('copies a form from its live version into a new form with no history', async () => {
    const { form } = await createForm('Original');
    await save(form.id, inspection(), 1);
    await publish(form.id, 2);

    const response = await api.call(ownerToken, {
      method: 'POST',
      url: `/v1/forms/${form.id}/clone`,
      payload: { title: 'Copy' },
    });
    expect(response.statusCode, response.body).toBe(201);
    const copy = json<Detail>(response);
    expect(copy.form).toMatchObject({ title: 'Copy', clonedFromFormId: form.id });
    expect(copy.live).toBeNull();
    expect(copy.draft?.definition.pages).toEqual(inspection().pages);
  });
});

describe('the template library', () => {
  beforeAll(async () => {
    await syncFormTemplates();
  });

  it('is listed and previewable by anyone, and cloned only by builders', async () => {
    const list = json<{ items: { key: string; fieldCount: number }[] }>(
      await api.call(engineerToken, { method: 'GET', url: '/v1/form-templates' }),
    );
    expect(list.items.map((item) => item.key)).toEqual([
      'job_completion',
      'boiler_service',
      'site_risk_assessment',
    ]);
    expect(list.items.every((item) => item.fieldCount > 0)).toBe(true);

    const preview = await api.call(engineerToken, {
      method: 'GET',
      url: '/v1/form-templates/boiler_service',
    });
    expect(preview.statusCode).toBe(200);
    expect(
      (await api.call(engineerToken, { method: 'GET', url: '/v1/form-templates/nope' })).statusCode,
    ).toBe(404);

    expect(
      (
        await api.call(engineerToken, {
          method: 'POST',
          url: '/v1/form-templates/boiler_service/clone',
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });

  it('starts a new form from a template whose draft publishes as it stands', async () => {
    const response = await api.call(ownerToken, {
      method: 'POST',
      url: '/v1/form-templates/job_completion/clone',
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(201);
    const detail = json<Detail>(response);
    expect(detail.form).toMatchObject({
      title: 'Job completion',
      sourceTemplateKey: 'job_completion',
    });

    const published = await publish(detail.form.id, detail.draft?.revision ?? 1);
    expect(published.statusCode, published.body).toBe(200);
    expect(
      (
        await api.call(ownerToken, {
          method: 'POST',
          url: '/v1/form-templates/nope/clone',
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });
});
