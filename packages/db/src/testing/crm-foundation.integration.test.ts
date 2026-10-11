import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asTenant,
  connectAsApp,
  connectAsOwner,
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
} from './harness.js';

/**
 * Migration 0024, the CRM foundation (CRM/ERP plan, phase F1): the module
 * switch, the EGP currency default, and the rules `crm_leads` enforces itself
 * whatever the API does.
 */

const USER = '00000000-0000-4000-8000-00000000c301';

let owner: pg.Client;
let app: pg.Client;
let northwind: TenantFixture;
let southgate: TenantFixture;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  app = await connectAsApp();
  northwind = await createTenant('crm-northwind');
  southgate = await createTenant('crm-southgate');
});

afterAll(async () => {
  await app.end();
  await owner.end();
  await releaseTestDatabase();
});

async function customer(tenantId: string, name: string): Promise<string> {
  const result = await owner.query<{ id: string }>(
    `insert into customers (tenant_id, name, created_by) values ($1, $2, $3) returning id`,
    [tenantId, name, USER],
  );
  return result.rows[0]!.id;
}

async function lead(tenantId: string, name: string): Promise<string> {
  const result = await owner.query<{ id: string }>(
    `insert into crm_leads (tenant_id, display_name, created_by) values ($1, $2, $3) returning id`,
    [tenantId, name, USER],
  );
  return result.rows[0]!.id;
}

describe('the module switch and the currency', () => {
  it('declares the crm flag, off unless Integr8 switches it on', async () => {
    const result = await owner.query<{ default_enabled: boolean }>(
      `select default_enabled from feature_flags where key = 'crm'`,
    );
    expect(result.rows).toEqual([{ default_enabled: false }]);
  });

  it('starts a new company in EGP', async () => {
    const tenant = await createTenant('crm-currency');
    const result = await owner.query<{ currency: string }>(
      `insert into tenant_settings (tenant_id) values ($1) returning currency`,
      [tenant.id],
    );
    expect(result.rows[0]?.currency).toBe('EGP');
  });
});

describe('crm_leads', () => {
  it('shows a company its own leads and no one else’s', async () => {
    const mine = await lead(northwind.id, 'Ada Prospect');
    await lead(southgate.id, 'Other Company Prospect');

    const seen = await asTenant(app, northwind.id, async () =>
      (await app.query<{ id: string }>('select id from crm_leads')).rows.map((row) => row.id),
    );
    expect(seen).toEqual([mine]);
  });

  it('refuses to convert a lead into another company’s customer', async () => {
    const id = await lead(northwind.id, 'Cross Tenant');
    const theirs = await customer(southgate.id, 'Southgate Customer');
    await expect(
      owner.query(
        `update crm_leads
            set status = 'converted', converted_customer_id = $2,
                converted_at = now(), converted_by = $3
          where id = $1`,
        [id, theirs, USER],
      ),
    ).rejects.toThrow(/crm_leads_customer_fk/u);
  });

  it('refuses converted without the customer it became', async () => {
    const id = await lead(northwind.id, 'Half Converted');
    await expect(
      owner.query(`update crm_leads set status = 'converted' where id = $1`, [id]),
    ).rejects.toThrow(/crm_leads_converted_pairing/u);
  });

  it('keeps a converted lead converted', async () => {
    const id = await lead(northwind.id, 'Converted Once');
    const target = await customer(northwind.id, 'Converted Customer');
    await owner.query(
      `update crm_leads
          set status = 'converted', converted_customer_id = $2,
              converted_at = now(), converted_by = $3
        where id = $1`,
      [id, target, USER],
    );

    await expect(
      owner.query(`update crm_leads set status = 'qualified' where id = $1`, [id]),
    ).rejects.toThrow(/crm_leads_conversion_final|A converted lead keeps its conversion/u);

    const other = await customer(northwind.id, 'Somebody Else');
    await expect(
      owner.query(`update crm_leads set converted_customer_id = $2 where id = $1`, [id, other]),
    ).rejects.toThrow(/A converted lead keeps its conversion/u);

    // Notes and archiving stay possible: the record is history, not frozen.
    await owner.query(`update crm_leads set notes = 'Signed in March' where id = $1`, [id]);
  });

  it('refuses a value without a currency, and a negative one', async () => {
    const id = await lead(northwind.id, 'Money');
    await expect(
      owner.query(`update crm_leads set estimated_value = 100 where id = $1`, [id]),
    ).rejects.toThrow(/crm_leads_value_has_currency/u);
    await expect(
      owner.query(
        `update crm_leads set estimated_value = -1, currency_code = 'EGP' where id = $1`,
        [id],
      ),
    ).rejects.toThrow(/crm_leads_value_not_negative/u);
  });
});
