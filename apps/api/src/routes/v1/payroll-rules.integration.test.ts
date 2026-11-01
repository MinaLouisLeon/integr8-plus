import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, startApi } from '../../testing/api-harness.js';

/**
 * Which payroll rule set a run uses (ADR-0010, 2026-10-31 addendum): the
 * latest set in force for the month, confirmed and from the month's own year,
 * or none. A run used to fall back to an older confirmed set while a newer one
 * waited for the owner, and in January took last year's figures.
 *
 * A company of its own, so its rule sets can be dated freely in past years.
 */

let api: ApiHarness;
let ownerToken: string;
let payrollerToken: string;

interface RuleSet {
  id: string;
  version: number;
}

interface Refusal {
  error: { code: string; details?: { params?: Record<string, string> }[] };
}

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

async function post(token: string, url: string, payload: Record<string, unknown>) {
  return api.call(token, {
    method: 'POST',
    url,
    payload,
    headers: { 'idempotency-key': randomUUID() },
  });
}

async function confirmSet(set: RuleSet): Promise<RuleSet> {
  const confirmed = await post(ownerToken, `/v1/payroll/rule-sets/${set.id}/confirm`, {
    expectedVersion: set.version,
    note: 'Checked by our accountant',
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return json<RuleSet>(confirmed);
}

async function ruleSet(effectiveFrom: string, confirm: boolean): Promise<RuleSet> {
  const created = await post(payrollerToken, '/v1/payroll/rule-sets', {
    name: `Rules from ${effectiveFrom}`,
    effectiveFrom,
  });
  expect(created.statusCode, created.body).toBe(201);
  const set = json<RuleSet>(created);
  return confirm ? confirmSet(set) : set;
}

beforeAll(async () => {
  api = await startApi();
  const staff = await api.platformAdmin('rules-staff');
  for (const key of ['hr', 'payroll']) {
    const response = await api.call(staff.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${api.tenantId}/flags/${key}`,
      payload: { enabled: true },
    });
    expect(response.statusCode, response.body).toBe(200);
  }
  ownerToken = await api.signIn(await api.member('owner', 'rules-owner'));
  payrollerToken = await api.signIn(await api.member('hr_manager', 'rules-payroller'));
});

afterAll(async () => {
  await api.close();
});

describe('the rule set a run uses', () => {
  it('is never last year’s: January needs a set from its own year', async () => {
    const lastYear = await ruleSet('2024-01-01', true);
    const january = await post(payrollerToken, '/v1/payroll/runs', { month: '2025-01' });
    expect(january.statusCode, january.body).toBe(422);
    const refusal = json<Refusal>(january);
    expect(refusal.error.code).toBe('rules_from_another_year');
    expect(refusal.error.details?.[0]?.params).toMatchObject({
      ruleSetId: lastYear.id,
      effectiveFrom: '2024-01-01',
      year: '2025',
    });
    // Its own year's runs are untouched.
    const december = await post(payrollerToken, '/v1/payroll/runs', { month: '2024-12' });
    expect(december.statusCode, december.body).toBe(201);
  });

  it('is never an older set while a newer one waits for the owner', async () => {
    // 2024's set is confirmed; 2025's is not yet. The run used to take 2024's.
    const waiting = await ruleSet('2025-01-01', false);
    const refused = await post(payrollerToken, '/v1/payroll/runs', { month: '2025-02' });
    expect(refused.statusCode, refused.body).toBe(422);
    const refusal = json<Refusal>(refused);
    expect(refusal.error.code).toBe('rules_not_confirmed');
    expect(refusal.error.details?.[0]?.params).toMatchObject({ ruleSetId: waiting.id });

    const confirmed = await confirmSet(waiting);
    const prepared = await post(payrollerToken, '/v1/payroll/runs', { month: '2025-02' });
    expect(prepared.statusCode, prepared.body).toBe(201);
    expect(json<{ ruleSet: { id: string } }>(prepared).ruleSet.id).toBe(confirmed.id);
  });

  it('is chosen the same way when a draft is recalculated', async () => {
    const prepared = await post(payrollerToken, '/v1/payroll/runs', { month: '2025-04' });
    expect(prepared.statusCode, prepared.body).toBe(201);
    const draft = json<{ id: string; version: number }>(prepared);

    const correction = await ruleSet('2025-04-01', false);
    const refused = await post(payrollerToken, `/v1/payroll/runs/${draft.id}/recalculate`, {
      expectedVersion: draft.version,
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(json<Refusal>(refused).error.code).toBe('rules_not_confirmed');

    await confirmSet(correction);
    const recalculated = await post(payrollerToken, `/v1/payroll/runs/${draft.id}/recalculate`, {
      expectedVersion: draft.version,
    });
    expect(recalculated.statusCode, recalculated.body).toBe(200);
    expect(json<{ ruleSet: { id: string } }>(recalculated).ruleSet.id).toBe(correction.id);
  });
});
