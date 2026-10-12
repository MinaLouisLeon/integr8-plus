import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Staff expense claims over HTTP (seventh round; ADR-0010): any member claims
 * with receipts — a viewer too, from the office, and an engineer from the
 * phone's outbox, once — somebody else approves or rejects, and paying back
 * directly or through payroll; approving and paying back post to the ledger.
 */

let api: ApiHarness;
let staff: PlatformAdmin;
let owner: Member;
let admin: Member;
let payroller: Member;
let engineer: Member;
let viewer: Member;
const tokens = new Map<Member, string>();

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
  who: Member,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) {
  return api.call(await token(who), {
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
}

async function flag(key: string, enabled: boolean) {
  const response = await api.call(staff.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/${key}`,
    payload: { enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function upload(who: Member) {
  const created = await call(who, 'POST', '/v1/media', {
    contentType: 'image/jpeg',
    byteSize: 1_000,
  });
  expect(created.statusCode, created.body).toBe(201);
  const body = json<{
    media: { id: string };
    upload: { url: string; headers: Record<string, string> };
  }>(created);
  const target = new URL(body.upload.url);
  const put = await api.app.inject({
    remoteAddress: api.remoteAddress,
    method: 'PUT',
    url: target.pathname + target.search,
    headers: body.upload.headers,
    payload: randomBytes(1_000),
  });
  expect(put.statusCode, put.body).toBe(200);
  expect((await call(who, 'POST', `/v1/media/${body.media.id}/complete`)).statusCode).toBe(200);
  return body.media.id;
}

interface Claim {
  id: string;
  reference: string;
  status: string;
  amount: string;
  currency: string;
  settleVia: string | null;
  paidVia: string | null;
  version: number;
  receipts: { id: string }[];
  can: { attach: boolean; withdraw: boolean; decide: boolean; pay: boolean };
}

const today = new Date().toISOString().slice(0, 10);
let fuelId: string;

async function submit(who: Member, amount = '120.5', extra: Record<string, unknown> = {}) {
  const response = await call(who, 'POST', '/v1/expenses', {
    categoryId: fuelId,
    spentOn: today,
    amount,
    description: 'Fuel for the van',
    ...extra,
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<Claim>(response);
}

beforeAll(async () => {
  api = await startApi();
  staff = await api.platformAdmin('ex-staff');
  owner = await api.member('owner', 'ex-owner');
  admin = await api.member('admin', 'ex-admin');
  payroller = await api.member('hr_manager', 'ex-payroller');
  engineer = await api.member('engineer', 'ex-engineer');
  viewer = await api.member('viewer', 'ex-viewer');
});

afterAll(async () => {
  await api.close();
});

describe('categories', () => {
  it('are kept by approvers, and need the hr module', async () => {
    expect(code(await call(engineer, 'GET', '/v1/expenses/categories'))).toBe('feature_disabled');
    await flag('hr', true);
    expect(
      (await call(engineer, 'POST', '/v1/expenses/categories', { name: 'Fuel' })).statusCode,
    ).toBe(403);
    const created = await call(admin, 'POST', '/v1/expenses/categories', { name: 'Fuel' });
    expect(created.statusCode, created.body).toBe(201);
    fuelId = json<{ id: string }>(created).id;
    expect(code(await call(payroller, 'POST', '/v1/expenses/categories', { name: 'fuel' }))).toBe(
      'name_taken',
    );
    const listed = json<{ items: { name: string }[] }>(
      await call(viewer, 'GET', '/v1/expenses/categories'),
    );
    expect(listed.items.map((category) => category.name)).toEqual(['Fuel']);
  });
});

describe('claims', () => {
  it('are made by any member, with receipts, in the company currency, and numbered', async () => {
    const claim = await submit(viewer, '45');
    expect(claim).toMatchObject({ status: 'submitted', amount: '45', currency: 'EGP' });
    expect(claim.reference).toMatch(/^EX-\d{6}$/u);
    expect(claim.can).toEqual({ attach: true, withdraw: true, decide: false, pay: false });
    // A viewer fills no forms, and still uploads a receipt for a claim.
    const fileId = await upload(viewer);
    const attached = await call(viewer, 'POST', '/v1/attachments', {
      owner: { expenseClaimId: claim.id },
      fileId,
      title: 'Receipt',
      kind: 'photo',
    });
    expect(attached.statusCode, attached.body).toBe(201);
    const read = json<Claim>(await call(viewer, 'GET', `/v1/expenses/${claim.id}`));
    expect(read.receipts).toHaveLength(1);
    // Nobody else's but an approver's.
    expect((await call(engineer, 'GET', `/v1/expenses/${claim.id}`)).statusCode).toBe(404);
    expect(
      (
        await call(engineer, 'POST', '/v1/attachments', {
          owner: { expenseClaimId: claim.id },
          fileId,
          title: 'Not mine',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      code(
        await call(viewer, 'POST', '/v1/expenses', {
          categoryId: fuelId,
          spentOn: '2999-01-01',
          amount: '1',
          description: 'Later',
        }),
      ),
    ).toBe('spent_in_future');
    // Engineers still attach nothing to a customer: that stays the office's.
    const mine = json<{ items: Claim[] }>(await call(viewer, 'GET', '/v1/expenses'));
    expect(mine.items.map((item) => item.id)).toContain(claim.id);
    expect((await call(viewer, 'GET', '/v1/expenses?scope=all')).statusCode).toBe(403);
  });

  it('are decided by somebody else, and withdrawn only while they wait', async () => {
    const claim = await submit(admin, '80');
    expect(
      code(
        await call(admin, 'POST', `/v1/expenses/${claim.id}/approve`, {
          expectedVersion: claim.version,
        }),
      ),
    ).toBe('self_approval');
    const rejected = await call(payroller, 'POST', `/v1/expenses/${claim.id}/reject`, {
      expectedVersion: claim.version,
      reason: 'No receipt',
    });
    expect(json<Claim>(rejected)).toMatchObject({ status: 'rejected' });
    expect(
      code(
        await call(admin, 'POST', `/v1/expenses/${claim.id}/withdraw`, {
          expectedVersion: claim.version + 1,
        }),
      ),
    ).toBe('not_waiting');
    const another = await submit(engineer, '10');
    const withdrawn = await call(engineer, 'POST', `/v1/expenses/${another.id}/withdraw`, {
      expectedVersion: another.version,
    });
    expect(json<Claim>(withdrawn).status).toBe('withdrawn');
    const all = json<{ waiting: number }>(await call(payroller, 'GET', '/v1/expenses?scope=all'));
    expect(all.waiting).toBeGreaterThanOrEqual(1);
  });

  it('are paid back directly, or through payroll once it is switched on, and post to the ledger', async () => {
    await flag('ledger', true);
    const setUp = await call(owner, 'POST', '/v1/ledger/setup', {
      startDate: `${today.slice(0, 7)}-01`,
    });
    expect(setUp.statusCode, setUp.body).toBe(201);

    const claim = await submit(engineer, '250');
    const approved = json<Claim>(
      await call(admin, 'POST', `/v1/expenses/${claim.id}/approve`, {
        expectedVersion: claim.version,
        settleVia: 'direct',
      }),
    );
    expect(approved).toMatchObject({ status: 'approved', settleVia: 'direct', can: { pay: true } });
    const paid = await call(admin, 'POST', `/v1/expenses/${claim.id}/pay`, {
      expectedVersion: approved.version,
      via: 'bank_transfer',
      reference: 'TRF-1',
    });
    expect(json<Claim>(paid)).toMatchObject({ status: 'paid', paidVia: 'bank_transfer' });
    const posted = json<{ items: { source: { kind: string; id: string }; status: string }[] }>(
      await call(owner, 'GET', '/v1/ledger/postings?status=posted&limit=200'),
    ).items.filter((item) => item.source.id === claim.id);
    expect(posted.map((item) => item.source.kind).sort()).toEqual([
      'expense_claim',
      'expense_payment',
    ]);

    const later = await submit(engineer, '30');
    expect(
      code(
        await call(admin, 'POST', `/v1/expenses/${later.id}/approve`, {
          expectedVersion: later.version,
          settleVia: 'payroll',
        }),
      ),
    ).toBe('payroll_off');
    await flag('payroll', true);
    const throughPayroll = json<Claim>(
      await call(admin, 'POST', `/v1/expenses/${later.id}/approve`, {
        expectedVersion: later.version,
        settleVia: 'payroll',
      }),
    );
    expect(throughPayroll.can.pay).toBe(false);
    expect(
      code(
        await call(admin, 'POST', `/v1/expenses/${later.id}/pay`, {
          expectedVersion: throughPayroll.version,
          via: 'cash',
        }),
      ),
    ).toBe('settles_through_payroll');
  });

  it('are submitted from the phone once, with their receipts', async () => {
    // The phone learns the categories with its first page of changes.
    const pulled = json<{ expenseCategories: { name: string }[] | null }>(
      await call(engineer, 'GET', '/v1/sync/pull'),
    );
    expect(pulled.expenseCategories?.map((category) => category.name)).toContain('Fuel');
    const claimId = randomUUID();
    const push = (mutations: Record<string, unknown>[]) =>
      call(engineer, 'POST', '/v1/sync/push', { sentAt: new Date().toISOString(), mutations });
    const submitted = {
      id: randomUUID(),
      entityId: claimId,
      recordedAt: new Date().toISOString(),
      kind: 'expense.submit',
      payload: { categoryId: fuelId, spentOn: today, amount: '15', description: 'Parking' },
    };
    const mediaId = await upload(engineer);
    const receipt = {
      id: randomUUID(),
      entityId: claimId,
      recordedAt: new Date().toISOString(),
      kind: 'expense.receipt',
      payload: { attachmentId: randomUUID(), mediaId, title: 'Parking ticket' },
    };
    const first = json<{ results: { outcome: string; alreadyApplied: boolean }[] }>(
      await push([submitted, receipt]),
    );
    expect(first.results.map((result) => result.outcome)).toEqual(['applied', 'applied']);
    const again = json<{ results: { outcome: string; alreadyApplied: boolean }[] }>(
      await push([
        { ...submitted, id: randomUUID() },
        { ...receipt, id: randomUUID() },
      ]),
    );
    expect(again.results.every((result) => result.alreadyApplied)).toBe(true);
    const mine = json<{ items: Claim[] }>(await call(engineer, 'GET', '/v1/expenses?limit=200'));
    const parking = mine.items.filter((item) => item.amount === '15');
    expect(parking).toHaveLength(1);
    const detail = json<Claim>(await call(engineer, 'GET', `/v1/expenses/${parking[0]!.id}`));
    expect(detail.receipts).toHaveLength(1);
  });
});
