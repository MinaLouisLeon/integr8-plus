import { randomUUID } from 'node:crypto';
import { newTagCode, toTenantId } from '@integr8/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetListQuery } from '../repositories/assets.js';
import {
  asTenant,
  connectAsApp,
  connectAsOwner,
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
  withUnprotectedRepositories,
} from './harness.js';

/**
 * Migration 0031 (CRM/ERP plan, phase E3; ADR-0008): the asset register —
 * numbers per company, a serial and a tag never shared, every change an
 * immutable event, a condition that a late phone never overwrites, links to
 * jobs, an engineer's scope, and a company with assets that can still be
 * purged.
 */

const USER = '00000000-0000-4000-8000-00000000f701';
const ENGINEER = '00000000-0000-4000-8000-00000000f702';

let owner: pg.Client;
let northwind: TenantFixture;
let southgate: TenantFixture;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  northwind = await createTenant('asset-northwind');
  southgate = await createTenant('asset-southgate');
  await repos(northwind, (tx) =>
    tx.tenantUsers.create({
      userId: ENGINEER,
      email: 'engineer@asset-northwind.example',
      displayName: 'Engineer',
      role: 'engineer',
    }),
  );
});

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

const repos = <T>(
  tenant: TenantFixture,
  fn: Parameters<typeof withUnprotectedRepositories<T>>[1],
) => withUnprotectedRepositories(toTenantId(tenant.id), fn);

async function place(tenant: TenantFixture, name: string) {
  const customer = await repos(tenant, (tx) => tx.customers.create({ name }, USER));
  const site = await repos(tenant, (tx) =>
    tx.sites.create(
      customer.id,
      { name: `${name} plant room`, address: { line1: '1 River Road' } },
      USER,
    ),
  );
  return { customer, site };
}

async function register(
  tenant: TenantFixture,
  at: { customer: { id: string }; site: { id: string } },
  extra: Record<string, unknown> = {},
) {
  const result = await repos(tenant, (tx) =>
    tx.assets.register(
      {
        name: 'Boiler',
        customerId: at.customer.id,
        siteId: at.site.id,
        tagCode: newTagCode(),
        ...extra,
      },
      USER,
    ),
  );
  if (typeof result === 'string') {
    throw new Error(result);
  }
  return result.asset;
}

async function job(tenant: TenantFixture, at: { customer: { id: string }; site: { id: string } }) {
  const type = await repos(tenant, (tx) =>
    tx.jobTypes.create(
      { name: `Type ${randomUUID().slice(0, 6)}`, code: randomUUID().slice(0, 8) },
      USER,
    ),
  );
  return repos(tenant, (tx) =>
    tx.workOrders.create(
      { customerId: at.customer.id, siteId: at.site.id, jobTypeId: type.id, title: 'Service' },
      USER,
    ),
  );
}

describe('the register', () => {
  it('numbers assets per company and records their registration', async () => {
    const here = await place(northwind, 'Numbered Ltd');
    const first = await register(northwind, here, { condition: 'good', serialNumber: ' SN-1 ' });
    const second = await register(northwind, here);
    const elsewhere = await register(southgate, await place(southgate, 'Other Co'));
    expect(second.reference).toBe(first.reference + 1);
    expect(elsewhere.reference).toBe(1);
    expect(first).toMatchObject({
      status: 'active',
      condition: 'good',
      serialNumber: 'SN-1',
      conditionRecordedBy: USER,
    });
    const events = await repos(northwind, (tx) => tx.assets.events(first.id));
    expect(events.map((event) => event.kind).sort()).toEqual(['condition_recorded', 'registered']);
    // Another company sees nothing of it.
    expect(await repos(southgate, (tx) => tx.assets.find(first.id))).toBeUndefined();
  });

  it('never shares a serial within a company, whatever its case or spacing', async () => {
    const here = await place(northwind, 'Serial Ltd');
    await register(northwind, here, { serialNumber: 'ABC-77' });
    expect(
      await repos(northwind, (tx) =>
        tx.assets.register(
          {
            name: 'Twin',
            customerId: here.customer.id,
            siteId: here.site.id,
            tagCode: newTagCode(),
            serialNumber: ' abc-77',
          },
          USER,
        ),
      ),
    ).toBe('serial_taken');
    // Another company may have the same serial.
    await register(southgate, await place(southgate, 'Serial Co'), { serialNumber: 'ABC-77' });
    expect(await repos(northwind, (tx) => tx.assets.findBySerial('abc-77'))).toMatchObject({
      serialNumber: 'ABC-77',
    });
  });

  it('is registered once from the phone however often it retries', async () => {
    const here = await place(northwind, 'Retry Ltd');
    const action = randomUUID();
    const input = {
      name: 'Chiller',
      customerId: here.customer.id,
      siteId: here.site.id,
      tagCode: newTagCode(),
    };
    const first = await repos(northwind, (tx) =>
      tx.assets.register(input, ENGINEER, { clientActionId: action }),
    );
    const again = await repos(northwind, (tx) =>
      tx.assets.register({ ...input, tagCode: newTagCode() }, ENGINEER, { clientActionId: action }),
    );
    expect(first).toMatchObject({ created: true });
    expect(again).toMatchObject({ created: false });
    expect(typeof again !== 'string' && typeof first !== 'string' && again.asset.id).toBe(
      typeof first !== 'string' && first.asset.id,
    );
  });

  it('opens by tag code as typed, and only for its own company', async () => {
    const here = await place(northwind, 'Tagged Ltd');
    const asset = await register(northwind, here);
    const typed = `${asset.tagCode.slice(0, 4).toLowerCase()}-${asset.tagCode.slice(4)}`;
    expect(await repos(northwind, (tx) => tx.assets.findByTag(typed))).toMatchObject({
      id: asset.id,
    });
    expect(await repos(southgate, (tx) => tx.assets.findByTag(asset.tagCode))).toBeUndefined();
    const reissued = await repos(northwind, (tx) =>
      tx.assets.reissueTag(asset.id, asset.version, newTagCode(), USER),
    );
    if (typeof reissued === 'string') {
      throw new Error(reissued);
    }
    expect(await repos(northwind, (tx) => tx.assets.findByTag(asset.tagCode))).toBeUndefined();
    expect(await repos(northwind, (tx) => tx.assets.findByTag(reissued.tagCode))).toMatchObject({
      id: asset.id,
    });
  });
});

describe('changes', () => {
  it('records each edit with what changed, and refuses a stale version', async () => {
    const here = await place(northwind, 'Edited Ltd');
    const asset = await register(northwind, here, { make: 'Vaillant' });
    const edited = await repos(northwind, (tx) =>
      tx.assets.update(
        asset.id,
        asset.version,
        { make: 'Vaillant', model: 'ecoTEC', warrantyExpiresOn: '2027-03-31' },
        USER,
      ),
    );
    expect(edited).toMatchObject({ model: 'ecoTEC', warrantyExpiresOn: '2027-03-31', version: 2 });
    expect(
      await repos(northwind, (tx) =>
        tx.assets.update(asset.id, asset.version, { model: 'x' }, USER),
      ),
    ).toBe('version_conflict');
    const [latest] = await repos(northwind, (tx) => tx.assets.events(asset.id));
    expect(latest).toMatchObject({
      kind: 'updated',
      changes: { model: [null, 'ecoTEC'], warrantyExpiresOn: [null, '2027-03-31'] },
    });
  });

  it('moves an asset to another site with an event naming where it was', async () => {
    const from = await place(northwind, 'Moved From Ltd');
    const to = await place(northwind, 'Moved To Ltd');
    const asset = await register(northwind, from);
    const moved = await repos(northwind, (tx) =>
      tx.assets.relocate(
        asset.id,
        asset.version,
        { customerId: to.customer.id, siteId: to.site.id },
        USER,
        { note: 'Sold with the building' },
      ),
    );
    expect(moved).toMatchObject({ customerId: to.customer.id, siteId: to.site.id });
    const [latest] = await repos(northwind, (tx) => tx.assets.events(asset.id));
    expect(latest).toMatchObject({
      kind: 'relocated',
      fromCustomerId: from.customer.id,
      fromSiteId: from.site.id,
      note: 'Sold with the building',
    });
    // A site of another customer must be named with that customer.
    await expect(
      repos(northwind, (tx) =>
        tx.assets.relocate(asset.id, 2, { customerId: to.customer.id, siteId: from.site.id }, USER),
      ),
    ).rejects.toMatchObject({ constraint: 'erp_assets_site_fk' });
  });

  it('retires and reinstates, keeping who retired it', async () => {
    const asset = await register(northwind, await place(northwind, 'Retired Ltd'));
    const retired = await repos(northwind, (tx) =>
      tx.assets.setStatus(asset.id, asset.version, 'retired', USER),
    );
    expect(retired).toMatchObject({ status: 'retired', retiredBy: USER });
    expect(await repos(northwind, (tx) => tx.assets.setStatus(asset.id, 2, 'retired', USER))).toBe(
      'same_status',
    );
    const back = await repos(northwind, (tx) => tx.assets.setStatus(asset.id, 2, 'active', USER));
    expect(back).toMatchObject({ status: 'active', retiredAt: null, retiredBy: null });
  });

  it('shows the latest condition by when it happened, and records each once', async () => {
    const asset = await register(northwind, await place(northwind, 'Condition Ltd'));
    const action = randomUUID();
    await repos(northwind, (tx) =>
      tx.assets.recordCondition(asset.id, 'poor', ENGINEER, {
        occurredAt: new Date('2026-10-10T09:00:00Z'),
      }),
    );
    // A phone syncing late with an older reading adds history, not the current state.
    const late = await repos(northwind, (tx) =>
      tx.assets.recordCondition(asset.id, 'good', ENGINEER, {
        occurredAt: new Date('2026-10-01T09:00:00Z'),
        clientActionId: action,
      }),
    );
    expect(late?.asset.condition).toBe('poor');
    const again = await repos(northwind, (tx) =>
      tx.assets.recordCondition(asset.id, 'good', ENGINEER, { clientActionId: action }),
    );
    expect(again?.created).toBe(false);
    const recorded = (await repos(northwind, (tx) => tx.assets.events(asset.id))).filter(
      (event) => event.kind === 'condition_recorded',
    );
    expect(recorded.map((event) => event.condition)).toEqual(['poor', 'good']);
  });

  it('keeps events and assets for good: the application may not change or delete them', async () => {
    const asset = await register(northwind, await place(northwind, 'Immutable Ltd'));
    const app = await connectAsApp();
    try {
      await expect(
        asTenant(app, northwind.id, () =>
          app.query(`update erp_asset_events set note = 'edited' where asset_id = $1`, [asset.id]),
        ),
      ).rejects.toThrow(/permission denied/u);
      await expect(
        asTenant(app, northwind.id, () =>
          app.query(`delete from erp_asset_events where asset_id = $1`, [asset.id]),
        ),
      ).rejects.toThrow(/permission denied/u);
      await expect(
        asTenant(app, northwind.id, () =>
          app.query(`delete from erp_assets where id = $1`, [asset.id]),
        ),
      ).rejects.toThrow(/permission denied/u);
      await expect(
        asTenant(app, northwind.id, () =>
          app.query(`update erp_assets set reference = 999 where id = $1`, [asset.id]),
        ),
      ).rejects.toMatchObject({ constraint: 'erp_assets_reference_fixed' });
    } finally {
      await app.end();
    }
  });
});

describe('jobs and finding', () => {
  it('links assets to jobs once, and knows a job whose only asset it is', async () => {
    const here = await place(northwind, 'Linked Ltd');
    const boiler = await register(northwind, here);
    const pump = await register(northwind, here, { name: 'Pump' });
    const service = await job(northwind, here);
    expect(await repos(northwind, (tx) => tx.assets.link(service.id, boiler.id, USER))).toBe(true);
    expect(await repos(northwind, (tx) => tx.assets.link(service.id, boiler.id, USER))).toBe(false);
    expect(await repos(northwind, (tx) => tx.assets.soleAssetOf(service.id))).toBe(boiler.id);
    await repos(northwind, (tx) => tx.assets.link(service.id, pump.id, USER));
    expect(await repos(northwind, (tx) => tx.assets.soleAssetOf(service.id))).toBeUndefined();
    expect(
      (await repos(northwind, (tx) => tx.assets.linksOfWorkOrders([service.id]))).map(
        (link) => link.assetId,
      ),
    ).toEqual([boiler.id, pump.id]);
    expect(await repos(northwind, (tx) => tx.assets.unlink(service.id, pump.id))).toBe(true);
    expect(await repos(northwind, (tx) => tx.assets.unlink(service.id, pump.id))).toBe(false);
    expect(await repos(northwind, (tx) => tx.assets.linksOfAsset(boiler.id))).toEqual([
      expect.objectContaining({ workOrderId: service.id, linkedBy: USER }),
    ]);
  });

  it('finds by reference, tag, words, warranty window and an engineer’s sites', async () => {
    const here = await place(northwind, 'Findable Housing');
    const away = await place(northwind, 'Elsewhere Ltd');
    const boiler = await register(northwind, here, {
      name: 'Rooftop condenser',
      serialNumber: 'XR-5521',
      warrantyExpiresOn: '2026-11-30',
    });
    const other = await register(northwind, away, { warrantyExpiresOn: '2026-10-01' });
    const ids = async (query: AssetListQuery) =>
      (await repos(northwind, (tx) => tx.assets.list(query))).items.map((asset) => asset.id);
    expect(await ids({ text: `AS-${String(boiler.reference).padStart(6, '0')}` })).toEqual([
      boiler.id,
    ]);
    expect(await ids({ text: boiler.tagCode.toLowerCase() })).toEqual([boiler.id]);
    expect(await ids({ text: 'condens' })).toEqual([boiler.id]);
    expect(await ids({ text: 'xr-55' })).toEqual([boiler.id]);
    expect(await ids({ text: 'findable' })).toEqual([boiler.id]);
    expect(await ids({ siteId: away.site.id })).toEqual([other.id]);
    expect(
      await ids({
        warrantyEndsBy: '2026-12-10',
        warrantyEndsFrom: '2026-10-11',
        customerId: here.customer.id,
      }),
    ).toEqual([boiler.id]);
    // An engineer sees only the assets of sites where they are on a job.
    expect(await ids({ visibleTo: ENGINEER, customerId: here.customer.id })).toEqual([]);
    const service = await job(northwind, here);
    await repos(northwind, (tx) =>
      tx.workOrders.setCrew(service.id, [{ userId: ENGINEER, lead: true }], USER),
    );
    expect(await ids({ visibleTo: ENGINEER, customerId: here.customer.id })).toEqual([boiler.id]);
    expect(await repos(northwind, (tx) => tx.assets.personHasSite(ENGINEER, here.site.id))).toBe(
      true,
    );
    expect(await repos(northwind, (tx) => tx.assets.personHasSite(ENGINEER, away.site.id))).toBe(
      false,
    );
    // Paged, newest first.
    const page = await repos(northwind, (tx) => tx.assets.list({ limit: 1 }));
    expect(page.items).toHaveLength(1);
    expect(page.next).toBe(page.items[0]!.reference);
  });

  it('keeps a file on an asset, shows the files of jobs whose only asset it is, and one owner per file', async () => {
    const here = await place(northwind, 'Photo Ltd');
    const asset = await register(northwind, here);
    const service = await job(northwind, here);
    await repos(northwind, (tx) => tx.assets.link(service.id, asset.id, USER));
    const fileFor = async () => {
      const id = randomUUID();
      await owner.query(
        `insert into files (id, tenant_id, bucket, storage_key, byte_size, content_type, category, uploaded_by)
         values ($1, $2, 'test', $3, 10, 'image/jpeg', 'image', $4)`,
        [id, northwind.id, `k/${id}`, USER],
      );
      return id;
    };
    const plate = await repos(northwind, async (tx) =>
      tx.attachments.add(
        { assetId: asset.id },
        { fileId: await fileFor(), title: 'Rating plate', kind: 'photo' },
        USER,
      ),
    );
    expect(plate.owner).toEqual({ assetId: asset.id });
    const onJob = await repos(northwind, async (tx) =>
      tx.attachments.add(
        { workOrderId: service.id },
        { fileId: await fileFor(), title: 'After', kind: 'photo' },
        USER,
      ),
    );
    expect(
      (await repos(northwind, (tx) => tx.assets.attachmentsOf(asset.id)))
        .map((file) => file.id)
        .sort(),
    ).toEqual([plate.id, onJob.id].sort());
    // A second asset on the job makes its files the job's, not this asset's.
    const second = await register(northwind, here);
    await repos(northwind, (tx) => tx.assets.link(service.id, second.id, USER));
    expect(
      (await repos(northwind, (tx) => tx.assets.attachmentsOf(asset.id))).map((file) => file.id),
    ).toEqual([plate.id]);
    await expect(
      owner.query(
        `insert into attachments (tenant_id, file_id, asset_id, site_id, title, added_by)
         values ($1, gen_random_uuid(), $2, $3, 'x', $4)`,
        [northwind.id, asset.id, here.site.id, USER],
      ),
    ).rejects.toMatchObject({ constraint: 'attachments_one_owner' });
  });
});

describe('settings and purge', () => {
  it('saves the warranty window once per company', async () => {
    expect(await repos(northwind, (tx) => tx.assets.settings())).toEqual({
      warrantyAlertDays: 60,
      version: 0,
    });
    expect(await repos(northwind, (tx) => tx.assets.saveSettings(0, 30, USER))).toEqual({
      warrantyAlertDays: 30,
      version: 1,
    });
    expect(await repos(northwind, (tx) => tx.assets.saveSettings(0, 90, USER))).toBe(
      'version_conflict',
    );
    expect(await repos(southgate, (tx) => tx.assets.settings())).toMatchObject({ version: 0 });
  });

  it('takes a company’s assets and their history with it', async () => {
    const tenant = await createTenant('asset-purge');
    const here = await place(tenant, 'Purged Ltd');
    const asset = await register(tenant, here, { condition: 'fair' });
    const service = await job(tenant, here);
    await repos(tenant, (tx) => tx.assets.link(service.id, asset.id, USER));
    const exported = await owner.query<{ id: string }>(
      `insert into tenant_exports (tenant_id, tenant_slug, status, object_key)
       values ($1, 'asset-purge', 'ready', 'exports/asset-purge.zip') returning id`,
      [tenant.id],
    );
    await owner.query(
      `insert into tenant_deletions (tenant_id, tenant_slug, export_id, reason, purge_after)
       values ($1, 'asset-purge', $2, 'Integration test of the purge', now() - interval '1 minute')`,
      [tenant.id, exported.rows[0]!.id],
    );
    await owner.query(`select purge_tenant($1)`, [tenant.id]);
    for (const table of [
      'erp_assets',
      'erp_asset_events',
      'erp_work_order_assets',
      'asset_reference_counters',
    ]) {
      const left = await owner.query(
        `select count(*)::int as n from ${table} where tenant_id = $1`,
        [tenant.id],
      );
      expect(left.rows[0], table).toEqual({ n: 0 });
    }
  });
});
