import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PullPage, PushResult } from '../api-types.js';
import {
  expenseCategories,
  expensesEnabled,
  saveExpenseCategories,
  unsentExpenseClaims,
} from '../expenses.js';
import { applySnapshot } from '../snapshot.js';
import { customerDetail, me, workOrderDetail } from '../testing/fixtures.js';
import { openTestDatabase } from '../testing/node-driver.js';
import {
  applyPushResults,
  type ChangeContext,
  changesNeedingAttention,
  discardChange,
  LocalChangeError,
  recordExpenseClaim,
  recordExpenseReceipt,
  selectBatch,
} from './outbox.js';
import { pullChanges } from './pull.js';
import type { SyncApi } from './transport.js';

/**
 * Expense claims made on the phone (seventh round; ADR-0010): checked here as
 * the server checks them, queued under the phone's own id for the claim, and
 * each receipt sent after its claim and its photo — so a claim made in a
 * basement arrives once, with its receipts, when the signal returns.
 */

const NOW = new Date('2026-10-11T12:00:00.000Z');
const random = (length: number) => new Uint8Array(randomBytes(length));
const FUEL = '00000000-0000-4000-8000-00000000ca01';
const MEALS = '00000000-0000-4000-8000-00000000ca02';

const photo = (name: string) => ({
  file: { localPath: `captures/${name}.jpg`, contentType: 'image/jpeg', byteSize: 2048 },
  title: `Receipt ${name}`,
});

async function phone(
  categories: { id: string; name: string }[] | null = [
    { id: MEALS, name: 'Meals' },
    { id: FUEL, name: 'Fuel' },
  ],
) {
  const { db } = await openTestDatabase();
  const customer = customerDetail();
  const job = workOrderDetail(customer, { state: 'in_progress' });
  await db.write(['work_orders', 'meta'], async (sql) => {
    await applySnapshot(
      sql,
      { me: me(), workOrders: [job], customers: [customer], forms: [] },
      NOW,
    );
    await saveExpenseCategories(sql, categories, NOW.toISOString());
  });
  const clock = { current: NOW, now: () => clock.current };
  const context: ChangeContext = { db, clock, random };
  const batch = () => db.read((sql) => selectBatch(sql, clock.current));
  const answer = (results: PushResult[]) =>
    db.write(['outbox', 'submissions', 'meta', 'work_orders'], async (sql) => {
      const { rows } = await selectBatch(sql, clock.current);
      return applyPushResults(sql, rows, results, clock.current);
    });
  const uploaded = (mediaId: string) =>
    db.write(['uploads'], (sql) =>
      sql.run(`update uploads set state = 'confirmed' where media_id = ?`, [mediaId]),
    );
  return { db, context, job, batch, answer, uploaded };
}

const applied = (id: string): PushResult => ({
  id,
  outcome: 'applied',
  replayed: false,
  alreadyApplied: false,
  revision: null,
  answers: null,
});

describe('claiming an expense on the phone', () => {
  it('sends the claim under the phone’s id, and each receipt after it and after its photo', async () => {
    const { db, context, job, batch, answer, uploaded } = await phone();
    const { claimId, mutationId } = await recordExpenseClaim(context, {
      categoryId: FUEL,
      spentOn: '2026-10-11',
      amount: '350.75',
      description: '  Diesel for the van  ',
      workOrderId: job.workOrder.id,
      receipts: [photo('pump'), photo('toll')],
    });

    // The claim goes first, alone: its receipts wait for it and for their photos.
    const first = await batch();
    expect(first.mutations).toEqual([
      {
        id: mutationId,
        kind: 'expense.submit',
        entityId: claimId,
        recordedAt: NOW.toISOString(),
        payload: {
          categoryId: FUEL,
          spentOn: '2026-10-11',
          amount: '350.75',
          description: 'Diesel for the van',
          workOrderId: job.workOrder.id,
        },
      },
    ]);
    // Not the job's work: the claim does not hold the job on the phone.
    expect(first.rows[0]?.workOrderId).toBeNull();
    const uploads = await db.read((sql) =>
      sql.all<{ media_id: string; work_order_id: string | null; local_path: string }>(
        'select media_id, work_order_id, local_path from uploads order by local_path',
      ),
    );
    expect(uploads.map((upload) => [upload.local_path, upload.work_order_id])).toEqual([
      ['captures/pump.jpg', null],
      ['captures/toll.jpg', null],
    ]);

    // The claim arrives; the receipts still wait for their photos.
    await answer([applied(mutationId)]);
    expect((await batch()).mutations).toEqual([]);

    for (const upload of uploads) {
      await uploaded(upload.media_id);
    }
    const receipts = (await batch()).mutations;
    expect(receipts.map((mutation) => [mutation.kind, mutation.entityId])).toEqual([
      ['expense.receipt', claimId],
      ['expense.receipt', claimId],
    ]);
    expect(receipts.map((mutation) => mutation.payload)).toEqual([
      {
        attachmentId: expect.any(String) as string,
        mediaId: uploads[0]!.media_id,
        title: 'Receipt pump',
      },
      {
        attachmentId: expect.any(String) as string,
        mediaId: uploads[1]!.media_id,
        title: 'Receipt toll',
      },
    ]);
  });

  it('refuses what the server would: a category not in use, a day ahead, no amount, no description', async () => {
    const { context } = await phone();
    const claim = {
      categoryId: FUEL,
      spentOn: '2026-10-11',
      amount: '10',
      description: 'Parking',
    };
    await expect(
      recordExpenseClaim(context, { ...claim, categoryId: '00000000-0000-4000-8000-0000000000ff' }),
    ).rejects.toMatchObject({ code: 'category_unknown' });
    await expect(
      recordExpenseClaim(context, { ...claim, spentOn: '2026-10-13' }),
    ).rejects.toMatchObject({ code: 'spent_in_future' });
    await expect(recordExpenseClaim(context, { ...claim, amount: '0' })).rejects.toMatchObject({
      code: 'amount_invalid',
    });
    await expect(
      recordExpenseClaim(context, { ...claim, amount: '1.23456' }),
    ).rejects.toBeInstanceOf(LocalChangeError);
    await expect(
      recordExpenseClaim(context, { ...claim, description: '   ' }),
    ).rejects.toMatchObject({ code: 'description_required' });
    await expect(
      recordExpenseClaim(context, {
        ...claim,
        workOrderId: '00000000-0000-4000-8000-0000000000fe',
      }),
    ).rejects.toMatchObject({ code: 'work_order_not_on_phone' });
    // Nothing was queued by any of them.
    expect(await context.db.read(unsentExpenseClaims)).toEqual([]);
  });

  it('offers nothing to claim for until the server has said what is in use', async () => {
    const { context } = await phone(null);
    expect(await context.db.read(expensesEnabled)).toBe(false);
    await expect(
      recordExpenseClaim(context, {
        categoryId: FUEL,
        spentOn: '2026-10-11',
        amount: '10',
        description: 'Parking',
      }),
    ).rejects.toMatchObject({ code: 'category_unknown' });
  });
});

describe('the phone’s own unsent claims', () => {
  it('shows a claim until it and every receipt have arrived', async () => {
    const { db, context, batch, answer, uploaded } = await phone();
    const { claimId, mutationId } = await recordExpenseClaim(context, {
      categoryId: MEALS,
      spentOn: '2026-10-10',
      amount: '120.50',
      description: 'Lunch for the crew',
      receipts: [photo('lunch')],
    });

    expect(await db.read(unsentExpenseClaims)).toEqual([
      {
        claimId,
        mutationId,
        categoryId: MEALS,
        categoryName: 'Meals',
        spentOn: '2026-10-10',
        amount: '120.50',
        description: 'Lunch for the crew',
        workOrderId: null,
        recordedAt: NOW.toISOString(),
        state: 'pending',
        lastError: null,
        receipts: { total: 1, unsent: 1, failed: 0 },
      },
    ]);

    await answer([applied(mutationId)]);
    expect(await db.read(unsentExpenseClaims)).toMatchObject([
      { claimId, state: 'sent', receipts: { total: 1, unsent: 1 } },
    ]);

    const [upload] = await db.read((sql) =>
      sql.all<{ media_id: string }>('select media_id from uploads'),
    );
    await uploaded(upload!.media_id);
    const receipt = (await batch()).rows[0]!;
    await answer([applied(receipt.id)]);
    expect(await db.read(unsentExpenseClaims)).toEqual([]);
  });

  it('shows a refused claim for the person to drop, and dropping it drops its receipts', async () => {
    const { db, context, answer } = await phone();
    const { mutationId } = await recordExpenseClaim(context, {
      categoryId: FUEL,
      spentOn: '2026-10-11',
      amount: '50',
      description: 'Fuel',
      receipts: [photo('pump')],
    });
    await answer([
      {
        id: mutationId,
        outcome: 'rejected',
        replayed: false,
        code: 'category_not_usable',
        message: 'Choose a category in use.',
        details: [],
      },
    ]);
    expect(await db.read(unsentExpenseClaims)).toMatchObject([
      {
        state: 'failed',
        lastError: { code: 'category_not_usable', message: 'Choose a category in use.' },
      },
    ]);
    expect((await db.read(changesNeedingAttention)).map((row) => row.kind)).toEqual([
      'expense.submit',
    ]);

    await discardChange(context, mutationId);
    expect(await db.read(unsentExpenseClaims)).toEqual([]);
    const left = await db.read((sql) =>
      sql.get<{ changes: number; uploads: number }>(
        `select (select count(*) from outbox where state <> 'done') as changes,
                (select count(*) from uploads) as uploads`,
      ),
    );
    expect(left).toEqual({ changes: 0, uploads: 0 });
  });

  it('adds a receipt to a claim already sent, waiting only for its photo', async () => {
    const { db, context, batch, answer, uploaded } = await phone();
    const { claimId, mutationId } = await recordExpenseClaim(context, {
      categoryId: FUEL,
      spentOn: '2026-10-11',
      amount: '50',
      description: 'Fuel',
    });
    await answer([applied(mutationId)]);
    expect(await db.read(unsentExpenseClaims)).toEqual([]);

    const { mediaId } = await recordExpenseReceipt(context, {
      claimId,
      file: photo('late').file,
      title: 'Receipt',
    });
    expect(await db.read(unsentExpenseClaims)).toMatchObject([
      { claimId, state: 'sent', receipts: { total: 1, unsent: 1 } },
    ]);
    await uploaded(mediaId);
    expect((await batch()).mutations.map((mutation) => mutation.kind)).toEqual(['expense.receipt']);

    await expect(
      recordExpenseReceipt(context, {
        claimId: '00000000-0000-4000-8000-0000000000fd',
        file: photo('stray').file,
        title: 'Receipt',
      }),
    ).rejects.toMatchObject({ code: 'claim_not_on_phone' });
  });
});

describe('the categories the phone keeps', () => {
  const page = (overrides: Partial<PullPage>): PullPage => ({
    reset: false,
    cursor: 'v1.1',
    page: null,
    serverTime: NOW.toISOString(),
    workOrders: [],
    removedWorkOrderIds: [],
    customers: [],
    forms: [],
    submissions: [],
    shifts: [],
    vanStock: null,
    assetSiteIds: [],
    assets: [],
    expenseCategories: null,
    ...overrides,
  });
  const pulling = (...pages: PullPage[]) => {
    const asked: { cursor?: string; page?: string }[] = [];
    const api = {
      me: () => Promise.resolve(me()),
      pull: (query: { cursor?: string; page?: string }) => {
        asked.push(query);
        const next = pages.shift();
        return next === undefined
          ? Promise.reject(new TypeError('offline'))
          : Promise.resolve(next);
      },
    } as unknown as SyncApi;
    return { api, asked };
  };
  const clock = { now: () => NOW };
  const policy = { closedJobDays: 30, downloadedFileBytes: 500 * 1024 * 1024 };

  it('come with the first page of a pull, with no request of their own', async () => {
    const { db } = await phone(null);
    expect(await db.read(expensesEnabled)).toBe(false);

    // The first page carries them; a later page says nothing and changes nothing.
    const first = pulling(
      page({
        cursor: null,
        page: 'page-2',
        expenseCategories: [
          { id: MEALS, name: 'Meals' },
          { id: FUEL, name: 'Fuel' },
        ],
      }),
      page({ cursor: 'v1.2', expenseCategories: null }),
    );
    await pullChanges(db, first.api, clock, policy);
    expect(first.asked).toHaveLength(2);
    expect(await db.read(expensesEnabled)).toBe(true);
    expect(await db.read(expenseCategories)).toEqual([
      { id: FUEL, name: 'Fuel' },
      { id: MEALS, name: 'Meals' },
    ]);
    // Claiming works from them straight away, offline.
    const context: ChangeContext = { db, clock, random };
    await expect(
      recordExpenseClaim(context, {
        categoryId: FUEL,
        spentOn: '2026-10-11',
        amount: '10',
        description: 'Parking',
      }),
    ).resolves.toMatchObject({ claimId: expect.any(String) as string });

    // The next pull's first page says again: a category gone is gone.
    const second = pulling(
      page({ cursor: 'v1.3', expenseCategories: [{ id: FUEL, name: 'Fuel' }] }),
    );
    await pullChanges(db, second.api, clock, policy);
    expect(second.asked[0]).toMatchObject({ cursor: 'v1.2' });
    expect(await db.read(expenseCategories)).toEqual([{ id: FUEL, name: 'Fuel' }]);

    // No signal: what the phone had stays.
    await expect(pullChanges(db, pulling().api, clock, policy)).rejects.toBeInstanceOf(TypeError);
    expect(await db.read(expenseCategories)).toEqual([{ id: FUEL, name: 'Fuel' }]);

    // The module switched off, or the seat no longer allowed: null on a first page.
    await pullChanges(
      db,
      pulling(page({ cursor: 'v1.4', expenseCategories: null })).api,
      clock,
      policy,
    );
    expect(await db.read(expensesEnabled)).toBe(false);
    expect(await db.read(expenseCategories)).toEqual([]);
  });

  it('are left alone by a server that does not send them', async () => {
    const { db } = await phone();
    const { expenseCategories: _omitted, ...older } = page({ cursor: 'v1.5' });
    await pullChanges(db, pulling(older as PullPage).api, clock, policy);
    expect(await db.read(expensesEnabled)).toBe(true);
    expect(await db.read(expenseCategories)).toHaveLength(2);
  });
});
