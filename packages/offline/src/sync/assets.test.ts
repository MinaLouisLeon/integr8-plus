import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyPulledAssets,
  assetByScan,
  assetsAtSite,
  assetsOfJob,
  type AssetSync,
  localAsset,
  markWarrantyAlerted,
  warrantyAlertsDue,
} from '../assets.js';
import { evict } from '../eviction.js';
import { applySnapshot } from '../snapshot.js';
import { customerDetail, me, workOrderDetail } from '../testing/fixtures.js';
import { openTestDatabase } from '../testing/node-driver.js';
import {
  type ChangeContext,
  discardChange,
  recordAssetCondition,
  recordAssetLink,
  recordAssetRegistered,
  selectBatch,
} from './outbox.js';

/**
 * Assets on the phone (CRM/ERP plan, phase E3; ADR-0008): a pulled site's
 * assets replace what was held, a tag or a serial opens one with no signal,
 * and what the engineer registers, records or links shows at once, queues in
 * order, and survives the next pull until the server has it.
 */

const NOW = new Date('2026-10-11T12:00:00.000Z');
const random = (length: number) => new Uint8Array(randomBytes(length));
const ASSET = '00000000-0000-4000-8000-00000000a501';
const OTHER = '00000000-0000-4000-8000-00000000a502';

async function phone() {
  const { db } = await openTestDatabase();
  const customer = customerDetail();
  const job = workOrderDetail(customer, { state: 'in_progress' });
  await db.write(['work_orders'], async (sql) => {
    await applySnapshot(
      sql,
      { me: me(), workOrders: [job], customers: [customer], forms: [] },
      NOW,
    );
  });
  const clock = { current: NOW, now: () => clock.current };
  const context: ChangeContext = { db, clock, random };
  return { db, context, job, siteId: job.site.id, customerId: customer.customer.id };
}

function synced(
  id: string,
  at: { siteId: string; customerId: string },
  overrides: Partial<AssetSync['asset']> = {},
  workOrderIds: string[] = [],
): AssetSync {
  return {
    asset: {
      id,
      reference: 'AS-000012',
      name: 'Boiler',
      make: 'Vaillant',
      model: null,
      serialNumber: 'SN-4471',
      status: 'active',
      condition: 'fair',
      customer: { id: at.customerId, name: 'Riverside' },
      site: { id: at.siteId, name: 'Block A' },
      locationNote: null,
      warrantyExpiresOn: null,
      warranty: 'none',
      tagCode: '7K2M9P4QX8ZT',
      tagLink: 'https://app.example.com/a/7K2M9P4QX8ZT',
      version: 2,
      item: null,
      installDate: null,
      notes: null,
      conditionRecordedAt: '2026-10-01T09:00:00.000Z',
      conditionRecordedBy: { id: 'u', name: 'Office' },
      createdBy: { id: 'u', name: 'Office' },
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-01T09:00:00.000Z',
      retiredAt: null,
      retiredBy: null,
      ...overrides,
    },
    workOrders: workOrderIds.map((jobId) => ({ id: jobId }) as AssetSync['workOrders'][number]),
    can: { edit: false, record: true, attach: true },
    timeline: [],
  };
}

describe('assets on the phone', () => {
  it('opens by a scanned link, a typed code or a serial, with no signal', async () => {
    const { db, siteId, customerId, job } = await phone();
    await db.write(['assets', 'asset_links'], (sql) =>
      applyPulledAssets(
        sql,
        {
          assetSiteIds: [siteId],
          assets: [synced(ASSET, { siteId, customerId }, {}, [job.workOrder.id])],
        },
        NOW.toISOString(),
      ),
    );
    for (const scanned of ['https://acme.example/a/7K2M9P4QX8ZT', '7k2m-9p4q-x8zt', ' sn-4471 ']) {
      expect((await db.read((sql) => assetByScan(sql, scanned)))?.data.asset.id, scanned).toBe(
        ASSET,
      );
    }
    expect(await db.read((sql) => assetByScan(sql, 'nothing here'))).toBeUndefined();
    expect(
      (await db.read((sql) => assetsOfJob(sql, job.workOrder.id))).map(
        (asset) => asset.data.asset.id,
      ),
    ).toEqual([ASSET]);
  });

  it('replaces a site’s assets as a set, and drops them when the site goes', async () => {
    const { db, siteId, customerId } = await phone();
    const write = (assets: AssetSync[]) =>
      db.write(['assets', 'asset_links'], (sql) =>
        applyPulledAssets(sql, { assetSiteIds: [siteId], assets }, NOW.toISOString()),
      );
    await write([
      synced(ASSET, { siteId, customerId }),
      synced(OTHER, { siteId, customerId }, { tagCode: 'ABCDEFGHJKMN', serialNumber: null }),
    ]);
    expect(await db.read((sql) => assetsAtSite(sql, siteId))).toHaveLength(2);
    // Moved away: the next pull of the site does not carry it.
    await write([synced(ASSET, { siteId, customerId })]);
    expect(
      (await db.read((sql) => assetsAtSite(sql, siteId))).map((asset) => asset.data.asset.id),
    ).toEqual([ASSET]);
    // The site leaves the phone; its assets go with it.
    await db.write(['work_orders', 'customers', 'sites', 'assets', 'asset_links'], async (sql) => {
      await sql.run('delete from work_orders');
      await evict(sql, NOW);
    });
    expect(await db.read((sql) => assetsAtSite(sql, siteId))).toEqual([]);
  });

  it('registers an asset on the job, which survives a pull until the server confirms it', async () => {
    const { db, context, job, siteId } = await phone();
    const assetId = await recordAssetRegistered(context, {
      workOrderId: job.workOrder.id,
      name: 'Found pump',
      serialNumber: 'P-77',
      condition: 'poor',
    });
    const local = await db.read((sql) => localAsset(sql, assetId));
    expect(local).toMatchObject({
      local: true,
      workOrderIds: [job.workOrder.id],
      data: {
        asset: { name: 'Found pump', condition: 'poor', site: { id: siteId }, reference: '' },
      },
    });
    const { rows } = await db.read((sql) => selectBatch(sql, NOW));
    expect(rows.map((row) => [row.kind, row.entityKey])).toEqual([
      ['asset.register', `asset:${assetId}`],
    ]);
    expect(rows[0]?.payload).toEqual({
      workOrderId: job.workOrder.id,
      name: 'Found pump',
      serialNumber: 'P-77',
      condition: 'poor',
    });
    // A pull of the site that does not know it yet keeps it.
    await db.write(['assets', 'asset_links'], (sql) =>
      applyPulledAssets(sql, { assetSiteIds: [siteId], assets: [] }, NOW.toISOString()),
    );
    expect(await db.read((sql) => localAsset(sql, assetId))).toBeDefined();
    // Dropping the registration takes it off the phone.
    await discardChange(context, rows[0]!.id);
    expect(await db.read((sql) => localAsset(sql, assetId))).toBeUndefined();
  });

  it('shows a recorded condition at once, keeps it over a pull, and links in order', async () => {
    const { db, context, job, siteId, customerId } = await phone();
    await db.write(['assets', 'asset_links'], (sql) =>
      applyPulledAssets(
        sql,
        { assetSiteIds: [siteId], assets: [synced(ASSET, { siteId, customerId })] },
        NOW.toISOString(),
      ),
    );
    const conditionId = await recordAssetCondition(context, {
      assetId: ASSET,
      condition: 'unusable',
      note: 'Cracked heat exchanger',
      workOrderId: job.workOrder.id,
    });
    const shown = await db.read((sql) => localAsset(sql, ASSET));
    expect(shown?.data.asset.condition).toBe('unusable');
    expect(shown?.data.timeline[0]).toMatchObject({
      id: conditionId,
      event: { kind: 'condition_recorded', condition: 'unusable', note: 'Cracked heat exchanger' },
    });
    // The server has not had it yet: the pull's copy gets it back on top.
    await db.write(['assets', 'asset_links'], (sql) =>
      applyPulledAssets(
        sql,
        { assetSiteIds: [siteId], assets: [synced(ASSET, { siteId, customerId })] },
        NOW.toISOString(),
      ),
    );
    expect((await db.read((sql) => localAsset(sql, ASSET)))?.data.asset.condition).toBe('unusable');

    await recordAssetLink(context, { workOrderId: job.workOrder.id, assetId: ASSET });
    expect(
      (await db.read((sql) => assetsOfJob(sql, job.workOrder.id))).map(
        (asset) => asset.data.asset.id,
      ),
    ).toEqual([ASSET]);

    // Dropping the condition puts back what the server said.
    await discardChange(context, conditionId);
    expect((await db.read((sql) => localAsset(sql, ASSET)))?.data.asset.condition).toBe('fair');
    expect((await db.read((sql) => localAsset(sql, ASSET)))?.data.timeline).toEqual([]);
  });

  it('refuses a condition for a retired asset and a link to another site’s asset', async () => {
    const { db, context, job, customerId } = await phone();
    const elsewhere = '00000000-0000-4000-8000-00000000c999';
    await db.write(['assets', 'asset_links'], (sql) =>
      applyPulledAssets(
        sql,
        {
          assetSiteIds: [elsewhere, job.site.id],
          assets: [
            synced(ASSET, { siteId: job.site.id, customerId }, { status: 'retired' }),
            synced(
              OTHER,
              { siteId: elsewhere, customerId },
              { tagCode: 'ABCDEFGHJKMN', serialNumber: null },
            ),
          ],
        },
        NOW.toISOString(),
      ),
    );
    await expect(
      recordAssetCondition(context, { assetId: ASSET, condition: 'good' }),
    ).rejects.toMatchObject({ code: 'asset_retired' });
    await expect(
      recordAssetLink(context, { workOrderId: job.workOrder.id, assetId: OTHER }),
    ).rejects.toMatchObject({ code: 'asset_not_at_site' });
  });

  it('announces a warranty ending soon once per asset and expiry date', async () => {
    const { db, siteId, customerId } = await phone();
    const pull = (expiresOn: string, warranty: AssetSync['asset']['warranty']) =>
      db.write(['assets', 'asset_links'], (sql) =>
        applyPulledAssets(
          sql,
          {
            assetSiteIds: [siteId],
            assets: [
              synced(ASSET, { siteId, customerId }, { warrantyExpiresOn: expiresOn, warranty }),
              synced(
                OTHER,
                { siteId, customerId },
                { tagCode: 'ABCDEFGHJKMN', serialNumber: null, warranty: 'covered' },
              ),
            ],
          },
          NOW.toISOString(),
        ),
      );
    const due = () => db.read((sql) => warrantyAlertsDue(sql));
    const mark = (alerts: Awaited<ReturnType<typeof due>>) =>
      db.write(['meta'], (sql) => markWarrantyAlerted(sql, alerts, '2026-10-11'));

    await pull('2026-11-20', 'expiring');
    const first = await due();
    expect(first).toEqual([
      {
        assetId: ASSET,
        reference: 'AS-000012',
        name: 'Boiler',
        siteName: 'Block A',
        warrantyExpiresOn: '2026-11-20',
      },
    ]);
    await mark(first);
    expect(await due()).toEqual([]);
    // The next pull says the same: still nothing to say.
    await pull('2026-11-20', 'expiring');
    expect(await due()).toEqual([]);
    // The warranty was extended, then comes round again: a new date, a new alert.
    await pull('2027-11-20', 'covered');
    expect(await due()).toEqual([]);
    await pull('2026-12-01', 'expiring');
    expect((await due()).map((alert) => alert.warrantyExpiresOn)).toEqual(['2026-12-01']);
    // Keys for dates already past are dropped as new ones are recorded.
    await db.write(['meta'], (sql) =>
      markWarrantyAlerted(sql, [{ assetId: OTHER, warrantyExpiresOn: '2026-12-31' }], '2026-11-25'),
    );
    const kept = await db.read((sql) =>
      sql.get<{ value: string }>(`select value from meta where key = 'warranty_alerted'`),
    );
    expect(JSON.parse(kept?.value ?? '[]')).toEqual([`${OTHER}:2026-12-31`]);
  });
});
