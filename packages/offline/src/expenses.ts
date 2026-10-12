import type { LocalDatabase } from './database.js';
import type { SqlConnection } from './sql.js';
import type { OutboxState } from './sync/outbox.js';
import type { SyncApi } from './sync/transport.js';

/**
 * Staff expense claims on the phone (seventh round; ADR-0010).
 *
 * A claim is made with or without signal: the phone keeps the categories the
 * server last said are in use, so the form works in a basement, and the claim
 * waits in the outbox — with its receipts behind it — until it can be sent.
 * Until then the phone's own unsent claims are read straight from the outbox:
 * there is no copy of them anywhere else to drift.
 */

export interface LocalExpenseCategory {
  id: string;
  name: string;
}

/** Whether this person claims expenses: the company has HR, and they may. As last heard. */
export async function expensesEnabled(sql: SqlConnection): Promise<boolean> {
  const row = await sql.get<{ value: string }>(
    `select value from meta where key = 'expenses_enabled'`,
  );
  return row?.value === '1';
}

/** The categories in use, as the server last said, by name. */
export async function expenseCategories(sql: SqlConnection): Promise<LocalExpenseCategory[]> {
  const row = await sql.get<{ value: string }>(
    `select value from meta where key = 'expense_categories'`,
  );
  if (row === undefined) {
    return [];
  }
  return [...(JSON.parse(row.value) as LocalExpenseCategory[])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * Keeps what the server said: the categories in use, or `null` when this
 * person does not claim expenses here (the module is off, or they may not).
 */
export async function saveExpenseCategories(
  sql: SqlConnection,
  categories: readonly LocalExpenseCategory[] | null,
  at: string,
): Promise<void> {
  for (const [key, value] of Object.entries({
    expenses_enabled: categories === null ? '0' : '1',
    expense_categories: JSON.stringify(
      (categories ?? []).map((category) => ({ id: category.id, name: category.name })),
    ),
    expense_categories_at: at,
  })) {
    await sql.run(
      `insert into meta (key, value) values (?, ?)
       on conflict (key) do update set value = excluded.value`,
      [key, value],
    );
  }
}

/**
 * Asks the server for the categories, when it can. A refusal (the module off,
 * the seat not allowed) is remembered as "no expenses here"; any other
 * failure keeps what the phone had, for the next run to try again.
 */
export async function refreshExpenseCategories(
  db: LocalDatabase,
  api: SyncApi,
  now: Date,
): Promise<boolean> {
  if (api.expenseCategories === undefined) {
    return false;
  }
  let categories: readonly LocalExpenseCategory[] | undefined;
  try {
    categories = await api.expenseCategories();
  } catch {
    return false;
  }
  await db.write(['meta'], (sql) =>
    saveExpenseCategories(sql, categories ?? null, now.toISOString()),
  );
  return true;
}

/** A claim made on this phone that the server does not fully have yet. */
export interface LocalExpenseClaim {
  /** The id chosen on the phone; the server knows the claim by it too. */
  claimId: string;
  /** The submit's change in the outbox, to retry or discard it. */
  mutationId: string;
  categoryId: string;
  /** As the phone last knew it; empty when the category is no longer in use. */
  categoryName: string;
  spentOn: string;
  amount: string;
  description: string;
  workOrderId: string | null;
  recordedAt: string;
  /**
   * Where the claim itself is: `pending` waits to be sent, `failed` was
   * refused and needs the person, `sent` has arrived and only receipts are
   * still on their way.
   */
  state: 'pending' | 'failed' | 'sent';
  lastError: { code: string; message: string } | null;
  receipts: { total: number; unsent: number; failed: number };
}

/**
 * The phone's own claims still on their way, newest first: the claim not yet
 * sent, or a receipt of it not yet arrived. Once all of it is on the server,
 * it is the server's list that shows it.
 */
export async function unsentExpenseClaims(sql: SqlConnection): Promise<LocalExpenseClaim[]> {
  const rows = await sql.all<{
    id: string;
    entity_id: string;
    payload: string;
    recorded_at: string;
    state: OutboxState;
    last_error: string | null;
  }>(
    `select id, entity_id, payload, recorded_at, state, last_error from outbox as submit
     where kind = 'expense.submit'
       and json_extract(coalesce(last_error, '{}'), '$.code') is not 'discarded'
       and (state <> 'done'
            or exists (select 1 from outbox as receipt
                       where receipt.kind = 'expense.receipt'
                         and receipt.entity_key = submit.entity_key
                         and receipt.state <> 'done'))
     order by seq desc`,
  );
  if (rows.length === 0) {
    return [];
  }
  const names = new Map((await expenseCategories(sql)).map((row) => [row.id, row.name]));
  const claims: LocalExpenseClaim[] = [];
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as {
      categoryId: string;
      spentOn: string;
      amount: string;
      description: string;
      workOrderId?: string;
    };
    const receipts = await sql.get<{ total: number; unsent: number; failed: number }>(
      `select count(*) as total,
              coalesce(sum(case when state <> 'done' then 1 else 0 end), 0) as unsent,
              coalesce(sum(case when state in ('failed', 'conflict') then 1 else 0 end), 0) as failed
       from outbox where kind = 'expense.receipt' and entity_key = ?
         and json_extract(coalesce(last_error, '{}'), '$.code') is not 'discarded'`,
      [`expense:${row.entity_id}`],
    );
    const error =
      row.last_error === null
        ? null
        : (JSON.parse(row.last_error) as { code: string; message: string });
    claims.push({
      claimId: row.entity_id,
      mutationId: row.id,
      categoryId: payload.categoryId,
      categoryName: names.get(payload.categoryId) ?? '',
      spentOn: payload.spentOn,
      amount: payload.amount,
      description: payload.description,
      workOrderId: payload.workOrderId ?? null,
      recordedAt: row.recorded_at,
      state:
        row.state === 'done'
          ? 'sent'
          : row.state === 'failed' || row.state === 'conflict'
            ? 'failed'
            : 'pending',
      lastError: row.state === 'done' ? null : error,
      receipts: {
        total: receipts?.total ?? 0,
        unsent: receipts?.unsent ?? 0,
        failed: receipts?.failed ?? 0,
      },
    });
  }
  return claims;
}
