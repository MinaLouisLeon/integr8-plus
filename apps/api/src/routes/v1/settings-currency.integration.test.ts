import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * The company currency is the unit of its books (CRM/ERP plan, invariants).
 *
 * Stock costs and journals carry no currency of their own and the ledger reads
 * the company's live, so changing it after the first money record would
 * relabel pounds as dollars without converting anything. It is chosen freely
 * until then, and refused with 409 afterwards.
 */

let api: ApiHarness;
let admin: PlatformAdmin;
let owner: Member;
let ownerToken: string;

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin('currency-staff');
  owner = await api.member('owner', 'currency-owner');
  ownerToken = await api.signIn(owner);
});

afterAll(async () => {
  await api.close();
});

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

interface ErrorBody {
  error: { code: string; details?: { field: string; message: string }[] };
}

async function patchSettings(payload: Record<string, unknown>) {
  return api.call(ownerToken, { method: 'PATCH', url: '/v1/settings', payload });
}

async function setFlag(key: string, enabled: boolean) {
  const response = await api.call(admin.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/${key}`,
    payload: { enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

describe('the company currency', () => {
  it('changes freely while the company has no money records', async () => {
    const dollars = await patchSettings({ currency: 'usd' });
    expect(dollars.statusCode, dollars.body).toBe(200);
    expect(json<{ currency: string }>(dollars).currency).toBe('USD');

    const pounds = await patchSettings({ currency: 'EGP' });
    expect(pounds.statusCode, pounds.body).toBe(200);
    expect(json<{ currency: string }>(pounds).currency).toBe('EGP');
  });

  it('stays once a money record exists, and still takes its own name', async () => {
    await setFlag('inventory', true);
    await setFlag('purchasing', true);
    const supplier = await api.call(ownerToken, {
      method: 'POST',
      url: '/v1/purchasing/suppliers',
      payload: { name: 'Delta Supplies' },
    });
    expect(supplier.statusCode, supplier.body).toBe(201);
    const order = await api.call(ownerToken, {
      method: 'POST',
      url: '/v1/purchasing/orders',
      payload: { supplierId: json<{ id: string }>(supplier).id },
    });
    expect(order.statusCode, order.body).toBe(201);

    const refused = await patchSettings({ currency: 'USD' });
    expect(refused.statusCode, refused.body).toBe(409);
    const body = json<ErrorBody>(refused);
    expect(body.error.code).toBe('currency_in_use');
    expect(body.error.details?.[0]?.field).toBe('body.currency');
    expect(body.error.details?.[0]?.message).toContain('purchase_order');

    // Sending the currency it already has is not a change, in any case.
    const same = await patchSettings({ currency: 'egp', timezone: 'Africa/Cairo' });
    expect(same.statusCode, same.body).toBe(200);
    expect(json<{ currency: string }>(same).currency).toBe('EGP');

    // And nothing else about the working day is held back by it.
    const hours = await patchSettings({ workDayStarts: 9 * 60 });
    expect(hours.statusCode, hours.body).toBe(200);
  });
});
