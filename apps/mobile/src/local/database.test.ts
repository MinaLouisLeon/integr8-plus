import { describe, expect, it } from 'vitest';
import { LocalDatabaseClosedError } from './database';
import { openTestDatabase } from './testing/node-driver';
import { watchQuery, type QueryState } from './watch';

const countDrafts = async (sql: { get<T>(q: string): Promise<T | undefined> }) =>
  (await sql.get<{ n: number }>('select count(*) as n from drafts'))?.n ?? 0;

const insertDraft = (id: string) => ({
  sql: `insert into drafts (id, form_id, form_version_id, work_order_id, answers, created_at, updated_at)
        values ('${id}', 'f', 'v', null, '{}', 'now', 'now')`,
});

describe('writes', () => {
  it('commits a whole change, or none of it', async () => {
    const { db } = await openTestDatabase();
    await expect(
      db.write(['drafts'], async (sql) => {
        await sql.exec(insertDraft('a').sql);
        throw new Error('signal lost half-way');
      }),
    ).rejects.toThrow('signal lost half-way');
    expect(await db.read(countDrafts)).toBe(0);

    await db.write(['drafts'], (sql) => sql.exec(insertDraft('b').sql));
    expect(await db.read(countDrafts)).toBe(1);
  });

  it('runs one operation at a time, so concurrent writes do not become one transaction', async () => {
    const { db } = await openTestDatabase();
    const order: string[] = [];
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        db.write(['drafts'], async (sql) => {
          order.push(`start ${id}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          await sql.exec(insertDraft(id).sql);
          order.push(`end ${id}`);
        }),
      ),
    );
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(await db.read(countDrafts)).toBe(3);
  });

  it('tells only the watchers of the tables a committed write changed', async () => {
    const { db } = await openTestDatabase();
    const heard: string[] = [];
    db.subscribe(['drafts'], () => heard.push('drafts'));
    const stop = db.subscribe(['work_orders', 'sites'], () => heard.push('jobs'));

    await db.write(['drafts'], (sql) => sql.exec(insertDraft('a').sql));
    await db.write(['sites'], () => Promise.resolve());
    await db
      .write(['drafts'], () => Promise.reject(new Error('rolled back')))
      .catch(() => undefined);
    stop();
    await db.write(['work_orders'], () => Promise.resolve());

    expect(heard).toEqual(['drafts', 'jobs']);
  });

  it('refuses work once closed, rather than reopening a database that is being wiped', async () => {
    const { db } = await openTestDatabase();
    const pending = db.read(countDrafts);
    const closing = db.close();
    await expect(pending).resolves.toBe(0);
    await closing;
    await expect(db.read(countDrafts)).rejects.toBeInstanceOf(LocalDatabaseClosedError);
  });
});

describe('watched queries', () => {
  it('shows the data, then the data again after each committed change', async () => {
    const { db } = await openTestDatabase();
    const states: QueryState<number>[] = [];
    const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

    const stop = watchQuery(db, ['drafts'], countDrafts, (state) => states.push(state));
    await settled();
    await db.write(['drafts'], (sql) => sql.exec(insertDraft('a').sql));
    await settled();
    await db.write(['work_orders'], () => Promise.resolve());
    await settled();
    stop();
    await db.write(['drafts'], (sql) => sql.exec(insertDraft('b').sql));
    await settled();

    expect(states).toEqual([
      { status: 'ready', data: 0 },
      { status: 'ready', data: 1 },
    ]);
  });

  it('reads once more, not once per change, when changes arrive during a read', async () => {
    const { db } = await openTestDatabase();
    let reads = 0;
    const states: number[] = [];
    const stop = watchQuery(
      db,
      ['drafts'],
      async (sql) => {
        reads += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return countDrafts(sql);
      },
      (state) => {
        if (state.status === 'ready') {
          states.push(state.data);
        }
      },
    );
    // Four writes queued while the first read is still running.
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((id) =>
        db.write(['drafts'], (sql) => sql.exec(insertDraft(id).sql)),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    stop();

    expect(states.at(-1)).toBe(4);
    expect(reads).toBeLessThanOrEqual(3);
  });
});
