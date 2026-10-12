import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { access, allows } from '../access.js';
import type { PullPage } from '../api-types.js';
import { van, vanStock } from '../queries.js';
import { applySnapshot } from '../snapshot.js';
import { customerDetail, me, workOrderDetail } from '../testing/fixtures.js';
import { openTestDatabase } from '../testing/node-driver.js';
import { fetchItemImage, itemImagePath, itemImagesToFetch } from './downloads.js';
import { type ChangeContext, recordMaterial } from './outbox.js';
import { pullChanges } from './pull.js';
import type { ByteTransport, SyncApi } from './transport.js';

/**
 * The van's stock on the phone (ADR-0012): what is reserved for sales orders
 * and what is available beside what is on hand, and each item's main image
 * kept on the phone for a basement — downloaded once, dropped when nothing on
 * the van shows it any more.
 */

const NOW = new Date('2026-10-12T09:00:00.000Z');
const VAN = { id: '00000000-0000-4000-8000-00000000f102', name: 'Van 7' };
const VALVE = '00000000-0000-4000-8000-00000000f001';
const TAPE = '00000000-0000-4000-8000-00000000f002';
const VALVE_IMAGE = '00000000-0000-4000-8000-00000000a001';
const NEW_VALVE_IMAGE = '00000000-0000-4000-8000-00000000a002';

const item = (id: string, name: string) => ({
  id,
  sku: name.slice(0, 3).toUpperCase(),
  name,
  kind: 'stock_item' as const,
  unit: 'each' as const,
});

const page = (cursor: string, vanStock: PullPage['vanStock']): PullPage => ({
  reset: false,
  cursor,
  page: null,
  serverTime: NOW.toISOString(),
  workOrders: [],
  removedWorkOrderIds: [],
  customers: [],
  forms: [],
  submissions: [],
  shifts: [],
  vanStock,
  assetSiteIds: [],
  assets: [],
  expenseCategories: null,
});

const policy = { closedJobDays: 30, downloadedFileBytes: 500 * 1024 * 1024 };
const clock = { now: () => NOW };

function serving(...pages: PullPage[]) {
  return {
    me: () =>
      Promise.resolve(
        me({
          permissions: ['inventory.consume', 'purchasing.manage'],
          features: { inventory: true, purchasing: true },
        }),
      ),
    pull: () => Promise.resolve(pages.shift()!),
    mediaLink: (fileId: string) => Promise.resolve({ url: `https://files/${fileId}` }),
  } as unknown as SyncApi;
}

describe('the van’s stock on the phone', () => {
  it('shows reserved and available beside on hand, and keeps each main image for offline', async () => {
    const { db } = await openTestDatabase();
    await pullChanges(
      db,
      serving(
        page('v1.1', {
          location: VAN,
          items: [
            {
              item: item(VALVE, 'Ball valve'),
              onHand: '5',
              reserved: '2',
              available: '3',
              mainImageFileId: VALVE_IMAGE,
            },
            {
              item: item(TAPE, 'PTFE tape'),
              onHand: '10.5',
              reserved: '0',
              available: '10.5',
              mainImageFileId: null,
            },
          ],
        }),
      ),
      clock,
      policy,
    );
    expect(await db.read(van)).toEqual(VAN);
    expect(await db.read(vanStock)).toMatchObject([
      {
        item: { id: VALVE, name: 'Ball valve' },
        onHand: '5',
        reserved: '2',
        available: '3',
        availableForecast: '3',
        mainImageFileId: VALVE_IMAGE,
        imagePath: null,
      },
      {
        item: { id: TAPE },
        onHand: '10.5',
        reserved: '0',
        available: '10.5',
        mainImageFileId: null,
        imagePath: null,
      },
    ]);

    // The image downloads once, under its file id.
    expect(await itemImagesToFetch(db)).toEqual([VALVE_IMAGE]);
    const fetched: string[] = [];
    const transport: ByteTransport = {
      put: () => Promise.resolve({ status: 200 }),
      download: (url, path) => {
        fetched.push(`${url} -> ${path}`);
        return Promise.resolve({ status: 200 });
      },
    };
    expect(await fetchItemImage(db, serving(), transport, VALVE_IMAGE, NOW)).toBe(true);
    expect(fetched).toEqual([`https://files/${VALVE_IMAGE} -> ${itemImagePath(VALVE_IMAGE)}`]);
    expect(await itemImagesToFetch(db)).toEqual([]);
    expect((await db.read(vanStock))[0]?.imagePath).toBe(itemImagePath(VALVE_IMAGE));

    // A part used on the phone comes off both what is left and what is available.
    const customer = customerDetail();
    const job = workOrderDetail(customer, { state: 'in_progress' });
    await db.write(['work_orders'], (sql) =>
      applySnapshot(sql, { me: me(), workOrders: [job], customers: [customer], forms: [] }, NOW),
    );
    const context: ChangeContext = {
      db,
      clock,
      random: (length) => new Uint8Array(randomBytes(length)),
    };
    await recordMaterial(context, { workOrderId: job.workOrder.id, itemId: VALVE, quantity: '1' });
    expect((await db.read(vanStock))[0]).toMatchObject({
      onHand: '5',
      forecast: '4',
      available: '3',
      availableForecast: '2',
    });
  });

  it('drops an image nothing on the van shows any more, and fetches the new one', async () => {
    const { db } = await openTestDatabase();
    const stocked = (imageId: string | null) =>
      page('v1.1', {
        location: VAN,
        items: [
          {
            item: item(VALVE, 'Ball valve'),
            onHand: '5',
            reserved: '0',
            available: '5',
            mainImageFileId: imageId,
          },
        ],
      });
    await pullChanges(db, serving(stocked(VALVE_IMAGE)), clock, policy);
    const transport: ByteTransport = {
      put: () => Promise.resolve({ status: 200 }),
      download: () => Promise.resolve({ status: 200 }),
    };
    await fetchItemImage(db, serving(), transport, VALVE_IMAGE, NOW);

    // The item was given another main image: the old file goes, the new one is wanted.
    const outcome = await pullChanges(db, serving(stocked(NEW_VALVE_IMAGE)), clock, policy);
    expect(outcome.evicted.filePaths).toEqual([itemImagePath(VALVE_IMAGE)]);
    expect(await itemImagesToFetch(db)).toEqual([NEW_VALVE_IMAGE]);

    // Taken off the van: nothing left, and the phone knows there is no van.
    await fetchItemImage(db, serving(), transport, NEW_VALVE_IMAGE, NOW);
    const gone = await pullChanges(
      db,
      serving(page('v1.2', { location: null, items: [] })),
      clock,
      policy,
    );
    expect(gone.evicted.filePaths).toEqual([itemImagePath(NEW_VALVE_IMAGE)]);
    expect(await db.read(vanStock)).toEqual([]);
    expect(await db.read(van)).toBeNull();
  });

  it('keeps what the person may do, from the first pull', async () => {
    const { db } = await openTestDatabase();
    await pullChanges(db, serving(page('v1.1', null)), clock, policy);
    const granted = await db.read(access);
    expect(allows(granted, 'purchasing.manage', 'purchasing')).toBe(true);
    expect(allows(granted, 'inventory.consume', 'inventory')).toBe(true);
    expect(allows(granted, 'inventory.move', 'inventory')).toBe(false);
    expect(allows(granted, 'purchasing.manage', 'payroll')).toBe(false);
  });
});
