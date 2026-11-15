import { randomUUID } from 'node:crypto';
import { withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimActionId } from '../../forms/actions.js';
import { type ApiHarness, type Member, startApi } from '../../testing/api-harness.js';

/**
 * Form actions over HTTP (P40): a form that makes expense claims from its
 * answers and opens a follow-up form for the same job. Claims are made once
 * through either submit path, an approver corrects an amount and the ledger
 * posts what was approved, a claim's decider reads the one submission it came
 * from, a claim that cannot be made leaves the submission saved, and a required
 * follow-up holds the job open.
 */

let api: ApiHarness;
let owner: Member;
let admin: Member;
let engineer: Member;
let accountant: Member;
let builder: string;
const tokens = new Map<Member, string>();

let tripFormId: string;
let handoverFormId: string;
let customerId: string;
let siteId: string;
let jobTypeId: string;

const today = new Date().toISOString().slice(0, 10);
let staffToken: string;

async function flag(key: string, enabled = true) {
  const response = await api.call(staffToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/${key}`,
    payload: { enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

async function token(who: Member): Promise<string> {
  let value = tokens.get(who);
  if (value === undefined) {
    value = await api.signIn(who);
    tokens.set(who, value);
  }
  return value;
}

async function call(
  who: Member | string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: Record<string, unknown>,
) {
  return api.call(typeof who === 'string' ? who : await token(who), {
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
}

async function ok<T>(
  who: Member | string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: Record<string, unknown>,
  status = 200,
): Promise<T> {
  const response = await call(who, method, url, payload);
  expect(response.statusCode, response.body).toBe(status);
  return json<T>(response);
}

const decimal = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'decimal',
  label: { en: id },
  decimalPlaces: 2,
  ...extra,
});

const tripDefinition = {
  schemaVersion: 1,
  title: { en: 'Trip and allowance' },
  pages: [
    {
      id: 'page_1',
      sections: [
        {
          id: 'section_1',
          fields: [
            decimal('km'),
            decimal('mileage_total', {
              calculation: {
                kind: 'arithmetic',
                operator: 'multiply',
                left: { kind: 'answer', field: 'km' },
                right: { kind: 'number', value: '2.5' },
              },
            }),
            decimal('allowance_total'),
            {
              id: 'needs_handover',
              type: 'radio',
              label: { en: 'Handover needed?' },
              options: [
                { value: 'yes', label: { en: 'Yes' } },
                { value: 'no', label: { en: 'No' } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const handoverDefinition = {
  schemaVersion: 1,
  title: { en: 'Handover' },
  pages: [
    {
      id: 'page_1',
      sections: [
        { id: 'section_1', fields: [{ id: 'note', type: 'text', label: { en: 'Note' } }] },
      ],
    },
  ],
};

const claimActions = (category = 'Mileage') => [
  {
    id: 'mileage',
    kind: 'expense_claim',
    when: { kind: 'answered', field: 'km' },
    category,
    amount: { field: 'mileage_total' },
    description: { en: 'Mileage, {{job.reference}}', ar: 'بدل انتقال، {{job.reference}}' },
  },
  {
    id: 'allowance',
    kind: 'expense_claim',
    category: 'Allowance',
    amount: { field: 'allowance_total' },
    description: { en: 'Daily allowance' },
  },
];

const followUpAction = (required: boolean) => ({
  id: 'handover',
  kind: 'open_form',
  form: handoverFormId,
  when: {
    kind: 'compare',
    operator: 'eq',
    left: { kind: 'answer', field: 'needs_handover' },
    right: { kind: 'text', value: 'yes' },
  },
  required,
});

interface Draft {
  revision: number;
  actions: unknown[];
}

async function saveDraft(formId: string, definition: unknown): Promise<Draft> {
  const detail = await ok<{ draft: { revision: number } | null }>(
    builder,
    'GET',
    `/v1/forms/${formId}`,
  );
  return ok<Draft>(builder, 'PUT', `/v1/forms/${formId}/draft`, {
    definition,
    expectedRevision: detail.draft?.revision ?? null,
  });
}

async function publishWithActions(formId: string, actions: unknown[]) {
  const draft = await saveDraft(formId, tripDefinition);
  const withActions = await ok<Draft>(builder, 'PUT', `/v1/forms/${formId}/draft/actions`, {
    actions,
    expectedRevision: draft.revision,
  });
  return call(builder, 'POST', `/v1/forms/${formId}/draft/publish`, {
    expectedRevision: withActions.revision,
    acknowledgeBreakingChanges: true,
  });
}

async function newForm(title: string, definition: unknown): Promise<string> {
  const id = (await ok<{ form: { id: string } }>(builder, 'POST', '/v1/forms', { title }, 201)).form
    .id;
  const draft = await saveDraft(id, definition);
  await ok(builder, 'POST', `/v1/forms/${id}/draft/publish`, { expectedRevision: draft.revision });
  return id;
}

interface WorkOrderDetail {
  workOrder: { id: string; reference: number; state: string; revision: number };
}

async function newJob(): Promise<WorkOrderDetail> {
  const created = await ok<WorkOrderDetail>(
    admin,
    'POST',
    '/v1/work-orders',
    { customerId, siteId, jobTypeId, crew: [{ userId: engineer.userId, lead: true }] },
    201,
  );
  return ok<WorkOrderDetail>(admin, 'POST', `/v1/work-orders/${created.workOrder.id}/transitions`, {
    to: 'dispatched',
    expectedRevision: created.workOrder.revision,
  });
}

interface SubmissionDetail {
  submission: { id: string; revision: number; status: string };
  formActions: {
    results: {
      actionId: string;
      outcome: string;
      reasonCode: string | null;
      claim: { id: string; amount: string; payableAmount: string; status: string } | null;
      followUp: { submissionId: string; required: boolean; status: string } | null;
    }[];
    openedFrom: { submissionId: string } | null;
    canRetry: boolean;
  };
  nextForms: { submissionId: string; formId: string; required: boolean }[];
  can: { edit: boolean; submit: boolean; reopen: boolean };
}

async function startOn(job: WorkOrderDetail, formId = tripFormId): Promise<SubmissionDetail> {
  return ok<SubmissionDetail>(
    engineer,
    'POST',
    '/v1/submissions',
    { formId, workOrderId: job.workOrder.id },
    201,
  );
}

async function submitOnWeb(draft: SubmissionDetail, answers: Record<string, unknown>) {
  return ok<SubmissionDetail>(engineer, 'POST', `/v1/submissions/${draft.submission.id}/submit`, {
    answers,
    expectedRevision: draft.submission.revision,
  });
}

interface Claim {
  id: string;
  amount: string;
  approvedAmount: string | null;
  amountNote: string | null;
  payableAmount: string;
  description: string;
  status: string;
  version: number;
  workOrder: { id: string } | null;
  claimant: { id: string };
  submission: { id: string; title: string } | null;
}

async function claimsOf(submissionId: string): Promise<Claim[]> {
  const page = await ok<{ items: Claim[] }>(admin, 'GET', '/v1/expenses?scope=all&limit=200');
  return page.items.filter((claim) => claim.submission?.id === submissionId);
}

beforeAll(async () => {
  api = await startApi();
  owner = await api.member('owner', 'fa-owner');
  admin = await api.member('admin', 'fa-admin');
  engineer = await api.member('engineer', 'fa-engineer');
  accountant = await api.member('accountant', 'fa-accountant');
  builder = await api.staff(owner);

  staffToken = (await api.platformAdmin('fa-staff')).accessToken;
  await flag('hr');
  for (const name of ['Mileage', 'Allowance']) {
    await ok(admin, 'POST', '/v1/expenses/categories', { name }, 201);
  }

  handoverFormId = await newForm('Handover', handoverDefinition);
  tripFormId = await newForm('Trip and allowance', tripDefinition);
  jobTypeId = (
    await ok<{ id: string }>(
      builder,
      'POST',
      '/v1/job-types',
      { name: 'Repair', code: 'repair', forms: [{ formId: tripFormId, required: false }] },
      201,
    )
  ).id;
  customerId = (
    await ok<{ id: string }>(admin, 'POST', '/v1/customers', { name: 'Nile Towers' }, 201)
  ).id;
  siteId = (
    await ok<{ id: string }>(
      admin,
      'POST',
      `/v1/customers/${customerId}/sites`,
      { name: 'Tower 1', address: { line1: '1 Corniche' } },
      201,
    )
  ).id;
});

afterAll(async () => {
  await api.close();
});

describe('saving and publishing actions', () => {
  it('refuses actions of the wrong shape when saved', async () => {
    const draft = await saveDraft(tripFormId, tripDefinition);
    const response = await call(builder, 'PUT', `/v1/forms/${tripFormId}/draft/actions`, {
      actions: [{ id: 'x', kind: 'webhook' }],
      expectedRevision: draft.revision,
    });
    expect(response.statusCode).toBe(422);
    expect(code(response)).toBe('invalid_actions');
  });

  it('is staff-only, like the rest of the builder', async () => {
    const response = await call(owner, 'PUT', `/v1/forms/${tripFormId}/draft/actions`, {
      actions: [],
      expectedRevision: 1,
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses to publish a claim in a category the company does not have', async () => {
    const response = await publishWithActions(tripFormId, claimActions('Tolls'));
    expect(response.statusCode).toBe(422);
    expect(code(response)).toBe('invalid_actions');
    const check = await ok<{ valid: boolean; actionIssues: { code: string; action: string }[] }>(
      builder,
      'POST',
      `/v1/forms/${tripFormId}/draft/check`,
    );
    expect(check.valid).toBe(false);
    expect(check.actionIssues).toEqual([
      expect.objectContaining({ code: 'unknown_category', action: 'mileage' }),
    ]);
  });

  it('publishes claims and a follow-up, and a new draft keeps them', async () => {
    const response = await publishWithActions(tripFormId, [
      ...claimActions(),
      followUpAction(true),
    ]);
    expect(response.statusCode, response.body).toBe(200);
    const next = await saveDraft(tripFormId, tripDefinition);
    expect(next.actions).toHaveLength(3);
  });
});

describe('claims made by a form', () => {
  it('are made once from a web submit, linked to the job, the engineer and the submission', async () => {
    const job = await newJob();
    const draft = await startOn(job);
    const submitted = await submitOnWeb(draft, {
      km: '48.5',
      allowance_total: '150',
      needs_handover: 'no',
    });

    expect(
      submitted.formActions.results.map((result) => [result.actionId, result.outcome]),
    ).toEqual([
      ['mileage', 'made'],
      ['allowance', 'made'],
      ['handover', 'skipped'],
    ]);
    const claims = await claimsOf(submitted.submission.id);
    expect(claims).toHaveLength(2);
    const mileage = claims.find((claim) => claim.amount === '121.25');
    expect(mileage).toMatchObject({
      status: 'submitted',
      workOrder: { id: job.workOrder.id },
      claimant: { id: engineer.userId },
      submission: { id: submitted.submission.id, title: 'Trip and allowance' },
    });
    expect(mileage?.description).toMatch(/^Mileage, WO-\d+$/u);
    expect(claims.map((claim) => claim.amount).sort()).toEqual(['121.25', '150']);
  });

  it('are made once from a phone, however often it sends the submit', async () => {
    const job = await newJob();
    const draft = await startOn(job);
    const phone = await api.signIn(engineer, 'mobile');
    const mutation = {
      id: randomUUID(),
      kind: 'submission.submit',
      entityId: draft.submission.id,
      recordedAt: new Date().toISOString(),
      payload: {
        answers: { km: '10', allowance_total: '80', needs_handover: 'no' },
        filledOn: today,
      },
      base: { revision: draft.submission.revision, answers: {} },
    };
    const push = (mutations: unknown[]) =>
      api.call(phone, {
        method: 'POST',
        url: '/v1/sync/push',
        payload: { sentAt: new Date().toISOString(), mutations },
      });
    // Sent, then sent again under the same id as a phone does when it never
    // heard back, then once more as a separate change: one submit, two claims.
    for (const attempt of [mutation, mutation]) {
      const response = await push([attempt]);
      expect(response.statusCode, response.body).toBe(200);
      expect(json<{ results: { outcome: string }[] }>(response).results[0]?.outcome).toBe(
        'applied',
      );
    }
    const separate = await push([{ ...mutation, id: randomUUID() }]);
    expect(json<{ results: { code?: string }[] }>(separate).results[0]?.code).toBe(
      'already_submitted',
    );
    const claims = await claimsOf(draft.submission.id);
    expect(claims.map((claim) => claim.amount).sort()).toEqual(['25', '80']);
    // The claim's phone id is derived from the submission and the action.
    await withTenant(api.tenantId, async (tx) => {
      const made = await tx.hrExpenses.findByClientAction(
        claimActionId(draft.submission.id, 'mileage'),
      );
      expect(made?.amount).toBe('25');
    });
  });

  it('are skipped when there is nothing to claim', async () => {
    const job = await newJob();
    const submitted = await submitOnWeb(await startOn(job), { allowance_total: '0' });
    expect(submitted.formActions.results.map((result) => result.outcome)).toEqual([
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(await claimsOf(submitted.submission.id)).toEqual([]);
  });
});

describe('the approver’s correction', () => {
  it('approves a lower amount with a note, posts it, and keeps what was claimed', async () => {
    await flag('ledger');
    await ok(owner, 'POST', '/v1/ledger/setup', { startDate: `${today.slice(0, 7)}-01` }, 201);
    const job = await newJob();
    const submitted = await submitOnWeb(await startOn(job), { km: '100', allowance_total: '50' });
    const mileage = (await claimsOf(submitted.submission.id)).find(
      (claim) => claim.amount === '250',
    );
    expect(mileage).toBeDefined();

    const noNote = await call(admin, 'POST', `/v1/expenses/${mileage!.id}/approve`, {
      expectedVersion: mileage!.version,
      approvedAmount: '200',
    });
    expect(noNote.statusCode).toBe(422);
    expect(code(noNote)).toBe('amount_note_required');

    const approved = await ok<Claim>(accountant, 'POST', `/v1/expenses/${mileage!.id}/approve`, {
      expectedVersion: mileage!.version,
      approvedAmount: '200',
      amountNote: 'Wrong rate: 2.00 a kilometre',
    });
    expect(approved).toMatchObject({
      status: 'approved',
      amount: '250',
      approvedAmount: '200',
      amountNote: 'Wrong rate: 2.00 a kilometre',
      payableAmount: '200',
    });

    // The journal posts what was approved, not what was claimed.
    const postings = await ok<{
      items: { source: { kind: string; id: string }; journal: { id: string } | null }[];
    }>(owner, 'GET', '/v1/ledger/postings?status=posted&limit=200');
    const posting = postings.items.find(
      (item) => item.source.kind === 'expense_claim' && item.source.id === mileage!.id,
    );
    const journal = await ok<{ totals: { debit: string; credit: string } }>(
      owner,
      'GET',
      `/v1/ledger/journals/${posting!.journal!.id}`,
    );
    expect(Number(journal.totals.debit)).toBe(200);
    expect(Number(journal.totals.credit)).toBe(200);

    await withTenant(api.tenantId, async (tx) => {
      const entries = await tx.auditLog.list({ limit: 50 });
      expect(
        entries.find(
          (entry) => entry.action === 'expense.approved' && entry.resourceId === mileage!.id,
        )?.metadata,
      ).toMatchObject({ amount: '250', approvedAmount: '200' });
    });
  });

  it('approves at the amount claimed when the same amount is given', async () => {
    const job = await newJob();
    const submitted = await submitOnWeb(await startOn(job), { allowance_total: '75' });
    const [claim] = await claimsOf(submitted.submission.id);
    const approved = await ok<Claim>(admin, 'POST', `/v1/expenses/${claim!.id}/approve`, {
      expectedVersion: claim!.version,
      approvedAmount: '75.00',
    });
    expect(approved).toMatchObject({ approvedAmount: null, payableAmount: '75' });
  });
});

describe('reading the submission a claim came from', () => {
  it('is open to the claim’s decider, read-only, and only that submission', async () => {
    const job = await newJob();
    const submitted = await submitOnWeb(await startOn(job), { allowance_total: '60' });
    const [claim] = await claimsOf(submitted.submission.id);

    expect(
      (await call(accountant, 'GET', `/v1/submissions/${submitted.submission.id}`)).statusCode,
    ).toBe(404);
    const viaClaim = await ok<SubmissionDetail>(
      accountant,
      'GET',
      `/v1/expenses/${claim!.id}/submission`,
    );
    expect(viaClaim.submission.id).toBe(submitted.submission.id);
    expect(viaClaim.can).toEqual({ edit: false, submit: false, reopen: false });

    const handEntered = await ok<Claim>(
      engineer,
      'POST',
      '/v1/expenses',
      {
        categoryId: (
          await ok<{ items: { id: string; name: string }[] }>(
            engineer,
            'GET',
            '/v1/expenses/categories',
          )
        ).items[0]!.id,
        spentOn: today,
        amount: '10',
        description: 'Parking',
      },
      201,
    );
    expect(
      (await call(accountant, 'GET', `/v1/expenses/${handEntered.id}/submission`)).statusCode,
    ).toBe(404);
  });
});

describe('a claim that cannot be made', () => {
  it('leaves the submission saved, says why, and is made once by Make it now', async () => {
    const categories = await ok<{ items: { id: string; name: string; version: number }[] }>(
      admin,
      'GET',
      '/v1/expenses/categories',
    );
    const allowance = categories.items.find((category) => category.name === 'Allowance')!;
    const archived = await ok<{ version: number }>(
      admin,
      'PATCH',
      `/v1/expenses/categories/${allowance.id}`,
      { expectedVersion: allowance.version, archived: true },
    );

    const job = await newJob();
    const submitted = await submitOnWeb(await startOn(job), { km: '4', allowance_total: '90' });
    expect(submitted.submission.status).toBe('submitted');
    const failed = submitted.formActions.results.find((result) => result.actionId === 'allowance');
    expect(failed).toMatchObject({ outcome: 'failed', reasonCode: 'category_missing' });
    expect((await claimsOf(submitted.submission.id)).map((claim) => claim.amount)).toEqual(['10']);

    expect(
      (await call(engineer, 'POST', `/v1/submissions/${submitted.submission.id}/actions/retry`))
        .statusCode,
    ).toBe(403);

    await ok(admin, 'PATCH', `/v1/expenses/categories/${allowance.id}`, {
      expectedVersion: archived.version,
      archived: false,
    });
    const retried = await ok<SubmissionDetail>(
      admin,
      'POST',
      `/v1/submissions/${submitted.submission.id}/actions/retry`,
    );
    expect(retried.formActions.results.map((result) => result.outcome)).toEqual([
      'made',
      'made',
      'skipped',
    ]);
    expect(retried.formActions.canRetry).toBe(false);
    await ok(admin, 'POST', `/v1/submissions/${submitted.submission.id}/actions/retry`);
    const claims = await claimsOf(submitted.submission.id);
    expect(claims.map((claim) => claim.amount).sort()).toEqual(['10', '90']);
    expect(claims.every((claim) => claim.claimant.id === engineer.userId)).toBe(true);
  });
});

describe('follow-up forms', () => {
  it('opens the next form for the same job when its condition holds, and links the two', async () => {
    const job = await newJob();
    const submitted = await submitOnWeb(await startOn(job), { needs_handover: 'yes' });
    expect(submitted.nextForms, JSON.stringify(submitted.formActions)).toEqual([
      expect.objectContaining({ formId: handoverFormId, required: true }),
    ]);
    const [next] = submitted.nextForms;
    const followUp = await ok<
      SubmissionDetail & { submission: { workOrder: { id: string } | null } }
    >(engineer, 'GET', `/v1/submissions/${next!.submissionId}`);
    expect(followUp.submission).toMatchObject({
      status: 'draft',
      workOrder: { id: job.workOrder.id },
    });
    expect(followUp.formActions.openedFrom).toEqual({
      submissionId: submitted.submission.id,
      formTitle: 'Trip and allowance',
    });
  });

  it('holds the job open while a required follow-up is a draft', async () => {
    const job = await newJob();
    const submitted = await submitOnWeb(await startOn(job), { needs_handover: 'yes' });
    let detail = await ok<WorkOrderDetail>(engineer, 'GET', `/v1/work-orders/${job.workOrder.id}`);
    for (const to of ['travelling', 'on_site', 'in_progress']) {
      detail = await ok<WorkOrderDetail>(
        engineer,
        'POST',
        `/v1/work-orders/${job.workOrder.id}/transitions`,
        { to, expectedRevision: detail.workOrder.revision },
      );
    }
    const blocked = await call(
      engineer,
      'POST',
      `/v1/work-orders/${job.workOrder.id}/transitions`,
      {
        to: 'complete',
        expectedRevision: detail.workOrder.revision,
      },
    );
    expect(blocked.statusCode).toBe(409);
    expect(code(blocked)).toBe('completion_blocked');
    expect(json<{ error: { message: string } }>(blocked).error.message).toContain(
      'submit Handover',
    );

    const followUp = await ok<SubmissionDetail>(
      engineer,
      'GET',
      `/v1/submissions/${submitted.nextForms[0]!.submissionId}`,
    );
    await submitOnWeb(followUp, { note: 'Keys with the porter' });
    const completed = await call(
      engineer,
      'POST',
      `/v1/work-orders/${job.workOrder.id}/transitions`,
      {
        to: 'complete',
        expectedRevision: detail.workOrder.revision,
      },
    );
    expect(completed.statusCode, completed.body).toBe(200);
  });
});
