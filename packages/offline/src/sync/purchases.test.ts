import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PushResult } from '../api-types.js';
import { unsentPurchases } from '../purchases.js';
import { applySnapshot } from '../snapshot.js';
import { customerDetail, me, workOrderDetail } from '../testing/fixtures.js';
import { openTestDatabase } from '../testing/node-driver.js';
import {
  applyPushResults,
  type ChangeContext,
  discardChange,
  jobSyncState,
  LocalChangeError,
  recordPurchase,
  recordPurchaseReceipt,
  recordTransition,
  selectBatch,
} from './outbox.js';

/**
 * Parts bought from a merchant for a job, recorded on the phone (eighth
 * round; ADR-0012): the purchase goes with the job's changes under the
 * phone's own id for it, and each receipt photo follows only once the
 * purchase has arrived and the photo has uploaded — the server answers
 * `retry` (`purchase_not_ready`) to a receipt that overtakes its purchase.
 */

const NOW = new Date('2026-10-12T09:00:00.000Z');
const random = (length: number) => new Uint8Array(randomBytes(length));

const photo = (name: string) => ({
  file: { localPath: `captures/${name}.jpg`, contentType: 'image/jpeg', byteSize: 4096 },
  title: `Receipt ${name}`,
});

async function phone() {
  const { db } = await openTestDatabase();
  const customer = customerDetail();
  const job = workOrderDetail(customer, { state: 'in_progress' });
  await db.write(['work_orders'], (sql) =>
    applySnapshot(sql, { me: me(), workOrders: [job], customers: [customer], forms: [] }, NOW),
  );
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
  const uploads = () =>
    db.read((sql) =>
      sql.all<{ media_id: string; work_order_id: string | null; local_path: string }>(
        'select media_id, work_order_id, local_path from uploads order by local_path',
      ),
    );
  return { db, context, job, clock, batch, answer, uploaded, uploads };
}

const applied = (id: string): PushResult => ({
  id,
  outcome: 'applied',
  replayed: false,
  alreadyApplied: false,
  revision: null,
  answers: null,
});

const bought = {
  description: '  15mm compression elbow  ',
  merchant: ' City Plumbing ',
  quantity: '2',
  unitPrice: '42.50',
  note: '',
};

describe('a part bought from a merchant', () => {
  it('sends the purchase under the phone’s id with the job, and each receipt after it and its photo', async () => {
    const { context, job, batch, answer, uploaded, uploads } = await phone();
    const jobId = job.workOrder.id;
    const { purchaseId, mutationId } = await recordPurchase(context, {
      workOrderId: jobId,
      ...bought,
      receipts: [photo('till'), photo('card')],
    });

    // The purchase goes first, alone, under the job: its receipts wait for it.
    const first = await batch();
    expect(first.mutations).toEqual([
      {
        id: mutationId,
        kind: 'work_order.purchase',
        entityId: jobId,
        recordedAt: NOW.toISOString(),
        payload: {
          id: purchaseId,
          description: '15mm compression elbow',
          merchant: 'City Plumbing',
          quantity: '2',
          unitPrice: '42.50',
        },
      },
    ]);
    expect(first.rows[0]).toMatchObject({ entityKey: `work_order:${jobId}`, workOrderId: jobId });
    // The photos are filed under the job, so they stay while it does.
    const files = await uploads();
    expect(files.map((file) => [file.local_path, file.work_order_id])).toEqual([
      ['captures/card.jpg', jobId],
      ['captures/till.jpg', jobId],
    ]);

    // The photos upload before the purchase is answered: the receipts still wait for it.
    for (const file of files) {
      await uploaded(file.media_id);
    }
    expect((await batch()).mutations.map((mutation) => mutation.kind)).toEqual([
      'work_order.purchase',
    ]);

    // The purchase arrives; now the receipts go, naming it.
    await answer([applied(mutationId)]);
    const receipts = (await batch()).mutations;
    expect(receipts.map((mutation) => [mutation.kind, mutation.entityId])).toEqual([
      ['work_order.purchase_receipt', purchaseId],
      ['work_order.purchase_receipt', purchaseId],
    ]);
    expect(receipts.map((mutation) => mutation.payload)).toEqual([
      {
        attachmentId: expect.any(String) as string,
        mediaId: files[1]!.media_id,
        title: 'Receipt till',
      },
      {
        attachmentId: expect.any(String) as string,
        mediaId: files[0]!.media_id,
        title: 'Receipt card',
      },
    ]);
  });

  it('waits for the photo even once the purchase has arrived', async () => {
    const { context, job, batch, answer, uploaded, uploads } = await phone();
    const { mutationId } = await recordPurchase(context, {
      workOrderId: job.workOrder.id,
      ...bought,
      receipts: [photo('till')],
    });
    await answer([applied(mutationId)]);
    expect((await batch()).mutations).toEqual([]);
    await uploaded((await uploads())[0]!.media_id);
    expect((await batch()).mutations.map((mutation) => mutation.kind)).toEqual([
      'work_order.purchase_receipt',
    ]);
  });

  it('keeps a receipt the server is not ready for, and sends it again later', async () => {
    const { context, job, clock, batch, answer, uploaded, uploads } = await phone();
    const { mutationId } = await recordPurchase(context, {
      workOrderId: job.workOrder.id,
      ...bought,
      receipts: [photo('till')],
    });
    await answer([applied(mutationId)]);
    await uploaded((await uploads())[0]!.media_id);
    const receipt = (await batch()).rows[0]!;
    await answer([
      {
        id: receipt.id,
        outcome: 'retry',
        code: 'purchase_not_ready',
        message: 'The purchase this receipt belongs to has not arrived yet.',
        retryAfterSeconds: 30,
      },
    ]);
    // Not now: it waits the 30 seconds the server asked for, and is not refused.
    expect((await batch()).mutations).toEqual([]);
    clock.current = new Date(NOW.getTime() + 31_000);
    expect((await batch()).rows.map((row) => [row.id, row.state])).toEqual([
      [receipt.id, 'pending'],
    ]);
  });

  it('goes in the job’s order: a change to the job recorded after it waits for it', async () => {
    const { context, job, batch } = await phone();
    const { mutationId } = await recordPurchase(context, {
      workOrderId: job.workOrder.id,
      ...bought,
    });
    await recordTransition(context, { workOrderId: job.workOrder.id, to: 'awaiting_parts' });
    const kinds = (await batch()).mutations.map((mutation) => mutation.kind);
    expect(kinds).toEqual(['work_order.purchase', 'work_order.transition']);
    expect((await batch()).rows[0]?.id).toBe(mutationId);
  });

  it('adds a receipt to a purchase already sent, waiting only for its photo', async () => {
    const { context, job, batch, answer, uploaded } = await phone();
    const { purchaseId, mutationId } = await recordPurchase(context, {
      workOrderId: job.workOrder.id,
      ...bought,
    });
    await answer([applied(mutationId)]);
    expect(await context.db.read((sql) => unsentPurchases(sql, job.workOrder.id))).toEqual([]);

    const { mediaId } = await recordPurchaseReceipt(context, {
      purchaseId,
      file: photo('late').file,
      title: 'Receipt',
    });
    expect(await context.db.read((sql) => unsentPurchases(sql, job.workOrder.id))).toMatchObject([
      { purchaseId, state: 'sent', receipts: { total: 1, unsent: 1 } },
    ]);
    expect((await batch()).mutations).toEqual([]);
    await uploaded(mediaId);
    expect((await batch()).mutations.map((mutation) => mutation.kind)).toEqual([
      'work_order.purchase_receipt',
    ]);

    await expect(
      recordPurchaseReceipt(context, {
        purchaseId: '00000000-0000-4000-8000-0000000000fd',
        file: photo('stray').file,
        title: 'Receipt',
      }),
    ).rejects.toMatchObject({ code: 'purchase_not_on_phone' });
  });

  it('shows on the job until it and its receipts have arrived, and holds the job as unsent', async () => {
    const { db, context, job, batch, answer, uploaded, uploads } = await phone();
    const jobId = job.workOrder.id;
    const { purchaseId, mutationId } = await recordPurchase(context, {
      workOrderId: jobId,
      ...bought,
      note: 'Merchant had no 22mm',
      receipts: [photo('till')],
    });
    expect(await db.read((sql) => unsentPurchases(sql, jobId))).toEqual([
      {
        purchaseId,
        mutationId,
        workOrderId: jobId,
        description: '15mm compression elbow',
        merchant: 'City Plumbing',
        quantity: '2',
        unitPrice: '42.50',
        note: 'Merchant had no 22mm',
        recordedAt: NOW.toISOString(),
        state: 'pending',
        lastError: null,
        receipts: { total: 1, unsent: 1, failed: 0 },
      },
    ]);
    expect(await db.read((sql) => jobSyncState(sql, jobId))).toMatchObject({
      safeToLeave: false,
      pendingChanges: 2,
      pendingUploads: 1,
    });

    await answer([applied(mutationId)]);
    expect(await db.read((sql) => unsentPurchases(sql, jobId))).toMatchObject([{ state: 'sent' }]);
    await uploaded((await uploads())[0]!.media_id);
    await answer([applied((await batch()).rows[0]!.id)]);
    expect(await db.read((sql) => unsentPurchases(sql, jobId))).toEqual([]);
    expect((await db.read((sql) => jobSyncState(sql, jobId))).safeToLeave).toBe(true);
  });

  it('drops its receipts and their photos with it when a refused purchase is discarded', async () => {
    const { db, context, job, answer } = await phone();
    const { mutationId } = await recordPurchase(context, {
      workOrderId: job.workOrder.id,
      ...bought,
      receipts: [photo('till')],
    });
    await answer([
      {
        id: mutationId,
        outcome: 'rejected',
        replayed: false,
        code: 'work_order_closed',
        message: 'This job is closed.',
        details: [],
      },
    ]);
    expect(await db.read((sql) => unsentPurchases(sql, job.workOrder.id))).toMatchObject([
      { state: 'failed', lastError: { code: 'work_order_closed' } },
    ]);

    await discardChange(context, mutationId);
    expect(await db.read((sql) => unsentPurchases(sql, job.workOrder.id))).toEqual([]);
    expect(
      await db.read((sql) =>
        sql.get<{ changes: number; uploads: number }>(
          `select (select count(*) from outbox where state <> 'done') as changes,
                  (select count(*) from uploads) as uploads`,
        ),
      ),
    ).toEqual({ changes: 0, uploads: 0 });
  });

  it('refuses what the server would: no description, no quantity, a price that is not one', async () => {
    const { context, job } = await phone();
    const input = { workOrderId: job.workOrder.id, ...bought };
    await expect(recordPurchase(context, { ...input, description: '  ' })).rejects.toMatchObject({
      code: 'part_description_required',
    });
    await expect(recordPurchase(context, { ...input, quantity: '0' })).rejects.toMatchObject({
      code: 'quantity_invalid',
    });
    await expect(recordPurchase(context, { ...input, unitPrice: '12,50' })).rejects.toMatchObject({
      code: 'unit_price_invalid',
    });
    await expect(
      recordPurchase(context, { ...input, unitPrice: '1.23456' }),
    ).rejects.toBeInstanceOf(LocalChangeError);
    await expect(
      recordPurchase(context, { ...input, workOrderId: '00000000-0000-4000-8000-0000000000fe' }),
    ).rejects.toMatchObject({ code: 'work_order_not_on_phone' });
    // Nothing was queued by any of them; a free part is a price of zero.
    expect((await context.db.read((sql) => selectBatch(sql, NOW))).rows).toEqual([]);
    await expect(recordPurchase(context, { ...input, unitPrice: '0' })).resolves.toBeDefined();
  });
});
