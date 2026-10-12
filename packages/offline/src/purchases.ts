import type { SqlConnection } from './sql.js';
import type { OutboxState } from './sync/outbox.js';

/**
 * Parts bought from a merchant for a job, as recorded on this phone (eighth
 * round; ADR-0012). There is no copy of them anywhere else on the phone: they
 * are read straight from the outbox, so what is shown cannot drift from what
 * will be sent. Once a purchase and all its receipts have arrived, it is the
 * server's list that shows it.
 */

export interface LocalPurchase {
  /** The id chosen on the phone; the server knows the purchase by it too. */
  purchaseId: string;
  /** The purchase's change in the outbox, to retry or discard it. */
  mutationId: string;
  workOrderId: string;
  description: string;
  merchant: string | null;
  quantity: string;
  unitPrice: string;
  note: string | null;
  recordedAt: string;
  /**
   * `pending` waits to be sent, `failed` was refused and needs the engineer,
   * `sent` has arrived and only receipts are still on their way.
   */
  state: 'pending' | 'failed' | 'sent';
  lastError: { code: string; message: string } | null;
  receipts: { total: number; unsent: number; failed: number };
}

/** The job's purchases made on this phone that the server does not fully have yet, oldest first. */
export async function unsentPurchases(
  sql: SqlConnection,
  workOrderId: string,
): Promise<LocalPurchase[]> {
  const rows = await sql.all<{
    id: string;
    payload: string;
    recorded_at: string;
    state: OutboxState;
    last_error: string | null;
  }>(
    `select id, payload, recorded_at, state, last_error from outbox as purchase
     where kind = 'work_order.purchase' and work_order_id = ?
       and json_extract(coalesce(last_error, '{}'), '$.code') is not 'discarded'
       and (state <> 'done'
            or exists (select 1 from outbox as receipt
                       where receipt.kind = 'work_order.purchase_receipt'
                         and receipt.entity_key = 'purchase:' || json_extract(purchase.payload, '$.id')
                         and receipt.state <> 'done'))
     order by seq`,
    [workOrderId],
  );
  const purchases: LocalPurchase[] = [];
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as {
      id: string;
      description: string;
      merchant?: string;
      quantity: string;
      unitPrice: string;
      note?: string;
    };
    const receipts = await sql.get<{ total: number; unsent: number; failed: number }>(
      `select count(*) as total,
              coalesce(sum(case when state <> 'done' then 1 else 0 end), 0) as unsent,
              coalesce(sum(case when state in ('failed', 'conflict') then 1 else 0 end), 0) as failed
       from outbox where kind = 'work_order.purchase_receipt' and entity_key = ?
         and json_extract(coalesce(last_error, '{}'), '$.code') is not 'discarded'`,
      [`purchase:${payload.id}`],
    );
    purchases.push({
      purchaseId: payload.id,
      mutationId: row.id,
      workOrderId,
      description: payload.description,
      merchant: payload.merchant ?? null,
      quantity: payload.quantity,
      unitPrice: payload.unitPrice,
      note: payload.note ?? null,
      recordedAt: row.recorded_at,
      state:
        row.state === 'done'
          ? 'sent'
          : row.state === 'failed' || row.state === 'conflict'
            ? 'failed'
            : 'pending',
      lastError:
        row.state === 'done' || row.last_error === null
          ? null
          : (JSON.parse(row.last_error) as { code: string; message: string }),
      receipts: {
        total: receipts?.total ?? 0,
        unsent: receipts?.unsent ?? 0,
        failed: receipts?.failed ?? 0,
      },
    });
  }
  return purchases;
}
