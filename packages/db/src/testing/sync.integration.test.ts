import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../connection.js';
import type { SyncPageQuery } from '../repositories/sync.js';
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
 * The sync change log (migration 0011), against a real database.
 *
 * The claim that matters most is that a pull never skips a change. Transaction
 * ids are handed out when writing starts and commits land in any order, so the
 * suite holds a transaction open across a pull and checks its change still
 * arrives on the next one.
 */

const DISPATCHER = '00000000-0000-4000-8000-00000000d201';
const ENGINEER = '00000000-0000-4000-8000-00000000e201';
const OTHER_ENGINEER = '00000000-0000-4000-8000-00000000e202';

let northwind: TenantFixture;
let contoso: TenantFixture;
let owner: pg.Client;
let app: pg.Client;
let customerId: string;
let siteId: string;
let jobTypeId: string;
let formId: string;

const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(northwind.id, fn);
const LONG_AGO = new Date('2000-01-01T00:00:00Z');

async function publish(title: string, existingFormId?: string) {
  return inTenant(async (tx) => {
    const id = existingFormId ?? (await tx.forms.createForm({ title, createdBy: DISPATCHER })).id;
    const draft = await tx.forms.createDraft({
      formId: id,
      definition: {
        schemaVersion: 1,
        title: { en: title },
        pages: [
          {
            id: 'p',
            sections: [{ id: 's', fields: [{ id: 'note', type: 'text', label: { en: 'Note' } }] }],
          },
        ],
      },
      createdBy: DISPATCHER,
    });
    await tx.forms.publishDraft(draft.id, DISPATCHER);
    return id;
  });
}

const newJob = (crew: string[] = [ENGINEER]) =>
  inTenant((tx) =>
    tx.workOrders.create(
      { customerId, siteId, jobTypeId, crew: crew.map((userId) => ({ userId, lead: false })) },
      DISPATCHER,
    ),
  );

/** A pull as the API makes one: the horizon first, then the pages below it. */
async function pull(since: string | null, userId = ENGINEER, closedSince = LONG_AGO) {
  return inTenant(async (tx) => {
    const horizon = await tx.sync.horizon();
    const ids: string[] = [];
    let after: string | undefined;
    for (;;) {
      const query: SyncPageQuery = {
        userId,
        closedSince,
        since,
        horizon,
        limit: 2,
        ...(after === undefined ? {} : { after }),
      };
      const page = await tx.sync.changedWorkOrderIds(query);
      ids.push(...page.ids);
      if (!page.more) {
        break;
      }
      after = page.ids.at(-1);
    }
    const removed =
      since === null ? [] : await tx.sync.removedWorkOrderIds({ userId, since, horizon });
    return { horizon, ids, removed };
  });
}

async function touches(since: string) {
  const { rows } = await owner.query<{ entity_kind: string; entity_id: string }>(
    `select entity_kind, entity_id from sync_touches where tenant_id = $1 and xid >= $2::xid8 order by xid`,
    [northwind.id, since],
  );
  return rows.map((row) => `${row.entity_kind}:${row.entity_id}`);
}

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  northwind = await createTenant('northwind');
  contoso = await createTenant('contoso');
  owner = await connectAsOwner();
  app = await connectAsApp();
  for (const tenant of [northwind, contoso]) {
    await withTenant(tenant.id, async (tx) => {
      for (const userId of [DISPATCHER, ENGINEER, OTHER_ENGINEER]) {
        await tx.tenantUsers.create({
          userId,
          email: `${userId.slice(-4)}@${tenant.slug}.example`,
          displayName: userId.slice(-4),
          role: userId === DISPATCHER ? 'dispatcher' : 'engineer',
        });
      }
    });
  }
  formId = await publish('Gas safety record');
  await inTenant(async (tx) => {
    customerId = (await tx.customers.create({ name: 'Riverside Housing' }, DISPATCHER)).id;
    siteId = (
      await tx.sites.create(
        customerId,
        { name: 'Block A', address: { line1: '1 River Road' } },
        DISPATCHER,
      )
    ).id;
    jobTypeId = (
      await tx.jobTypes.create(
        {
          name: 'Boiler service',
          code: 'BOILER',
          checklist: [{ id: 'isolate', label: 'Isolate supply' }],
          forms: [{ formId, required: false }],
        },
        DISPATCHER,
      )
    ).id;
  });
});

afterAll(async () => {
  await owner.end();
  await app.end();
  await releaseTestDatabase();
});

describe('the change log', () => {
  it('logs a touch on the job for every change to it, its crew, checklist, notes, forms and submissions', async () => {
    const start = await inTenant((tx) => tx.sync.horizon());
    const job = await newJob();
    const expectJobTouched = async (change: () => Promise<unknown>) => {
      const before = await inTenant((tx) => tx.sync.horizon());
      await change();
      expect(await touches(before)).toContain(`work_order:${job.id}`);
    };

    expect(await touches(start)).toContain(`work_order:${job.id}`);
    await expectJobTouched(() =>
      inTenant(async (tx) => {
        const [item] = await tx.workOrders.listChecklist(job.id);
        await tx.workOrders.setChecklistItem(job.id, item!.id, true, ENGINEER);
      }),
    );
    await expectJobTouched(() =>
      inTenant((tx) =>
        tx.workOrders.addComment(
          job.id,
          { body: 'Gate code changed', visibility: 'internal' },
          ENGINEER,
        ),
      ),
    );
    await expectJobTouched(() =>
      inTenant((tx) =>
        tx.workOrders.setCrew(job.id, [{ userId: OTHER_ENGINEER, lead: true }], DISPATCHER),
      ),
    );
    await expectJobTouched(() =>
      inTenant(async (tx) => {
        const version = await tx.forms.findLatestPublished(formId);
        await tx.submissions.startDraft({
          formVersionId: version!.id,
          submittedBy: ENGINEER,
          workOrderId: job.id,
        });
      }),
    );
  });

  it('logs sites, customers (and their contacts) and forms under their own kinds', async () => {
    const before = await inTenant((tx) => tx.sync.horizon());
    await inTenant(async (tx) => {
      await tx.sites.update(siteId, { access: { gateCode: '9911#' } }, DISPATCHER);
      await tx.customers.addContact(customerId, { name: 'Pat Caretaker' });
    });
    await publish('Gas safety record', formId);
    expect(await touches(before)).toEqual(
      expect.arrayContaining([`site:${siteId}`, `customer:${customerId}`, `form:${formId}`]),
    );
  });

  it('cannot be written or pruned by the runtime role directly', async () => {
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(
          `insert into sync_touches (tenant_id, entity_kind, entity_id) values ($1, 'work_order', $1)`,
          [northwind.id],
        ),
      ),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      asTenant(app, northwind.id, () => app.query('delete from sync_touches')),
    ).rejects.toThrow(/permission denied/u);
  });
});

describe('a pull', () => {
  it('never skips a change committed after a later one, however the commits interleave', async () => {
    const early = await newJob();
    const late = await newJob();
    const { horizon: cursor } = await pull(null);

    // `slow` starts writing first and commits last.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow = inTenant(async (tx) => {
      await tx.workOrders.addComment(early.id, { body: 'Slow', visibility: 'internal' }, ENGINEER);
      started();
      await held;
    });
    await writing;
    await inTenant((tx) =>
      tx.workOrders.addComment(late.id, { body: 'Fast', visibility: 'internal' }, ENGINEER),
    );

    // The fast change has committed, but it is above a transaction still running.
    const first = await pull(cursor);
    expect(first.ids).toEqual([]);

    release();
    await slow;
    const second = await pull(first.horizon);
    expect(second.ids.sort()).toEqual([early.id, late.id].sort());

    // And the next pull, with nothing new, is empty.
    expect((await pull(second.horizon)).ids).toEqual([]);
  });

  it('is scoped to the person’s own jobs, including a change to their site, customer or form', async () => {
    const mine = await newJob([ENGINEER]);
    const theirs = await newJob([OTHER_ENGINEER]);
    const everything = await pull(null);
    expect(everything.ids).toContain(mine.id);
    expect(everything.ids).not.toContain(theirs.id);

    for (const change of [
      () =>
        inTenant((tx) => tx.sites.update(siteId, { access: { parking: 'Rear bays' } }, DISPATCHER)),
      () => inTenant((tx) => tx.customers.update(customerId, { phone: '0113 496 0000' })),
      () => publish('Gas safety record', formId),
    ]) {
      const { horizon } = await pull(null);
      await change();
      const next = await pull(horizon);
      expect(next.ids).toContain(mine.id);
      expect(next.ids).not.toContain(theirs.id);
    }
  });

  it('lists a job the person was taken off as removed, and never one they were not on', async () => {
    const leaving = await newJob([ENGINEER]);
    const never = await newJob([OTHER_ENGINEER]);
    const { horizon } = await pull(null);
    await inTenant(async (tx) => {
      await tx.workOrders.setCrew(leaving.id, [{ userId: OTHER_ENGINEER, lead: true }], DISPATCHER);
      await tx.workOrders.addComment(
        never.id,
        { body: 'Touched', visibility: 'internal' },
        DISPATCHER,
      );
    });
    const next = await pull(horizon);
    expect(next.removed).toContain(leaving.id);
    expect(next.removed).not.toContain(never.id);
    expect(next.ids).not.toContain(leaving.id);
  });

  it('includes closed jobs only within the retention window', async () => {
    const closing = await newJob([ENGINEER]);
    await inTenant((tx) =>
      tx.workOrders.transition(closing.id, closing.revision, 'cancelled', DISPATCHER, 'Duplicate'),
    );
    expect((await pull(null, ENGINEER, new Date(Date.now() - 60_000))).ids).toContain(closing.id);
    expect((await pull(null, ENGINEER, new Date(Date.now() + 60_000))).ids).not.toContain(
      closing.id,
    );
  });

  it('sees nothing of another company', async () => {
    const mine = await newJob([ENGINEER]);
    const other = await withTenant(contoso.id, async (tx) => {
      const customer = await tx.customers.create({ name: 'Elsewhere' }, DISPATCHER);
      const site = await tx.sites.create(
        customer.id,
        { name: 'X', address: { line1: '1 X Road' } },
        DISPATCHER,
      );
      const type = await tx.jobTypes.create({ name: 'X', code: 'X' }, DISPATCHER);
      return tx.workOrders.create(
        {
          customerId: customer.id,
          siteId: site.id,
          jobTypeId: type.id,
          crew: [{ userId: ENGINEER, lead: true }],
        },
        DISPATCHER,
      );
    });
    const ids = (await pull(null)).ids;
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(other.id);
  });
});

describe('pruning and reports', () => {
  it('prunes old touches and remembers the boundary, so an older cursor knows to start again', async () => {
    const job = await newJob();
    await owner.query(
      `update sync_touches set created_at = now() - interval '60 days' where tenant_id = $1`,
      [northwind.id],
    );
    const removed = await inTenant((tx) => tx.sync.prune(45));
    expect(removed).toBeGreaterThan(0);
    const mark = await inTenant((tx) => tx.sync.prunedBefore());
    expect(mark).toBeDefined();
    const left = await owner.query<{ n: number }>(
      `select count(*)::int as n from sync_touches where tenant_id = $1 and xid <= $2::xid8`,
      [northwind.id, mark],
    );
    expect(left.rows[0]?.n).toBe(0);
    // Pruning another company's log is refused.
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(`select prune_sync_touches($1::uuid, interval '1 day')`, [contoso.id]),
      ),
    ).rejects.toThrow(/current company/u);
    expect(job.id).toBeDefined();
  });

  it('stores a report once however often it is sent', async () => {
    const report = {
      reportId: '00000000-0000-4000-8000-0000000000aa',
      userId: ENGINEER,
      startedAt: new Date(),
      durationMs: 1200,
      trigger: 'reconnect' as const,
      outcome: 'complete' as const,
      pushed: 4,
      conflicts: 0,
      rejected: 0,
      retried: 1,
      pulled: 3,
      uploadsCompleted: 10,
      uploadsFailed: 0,
      uploadedBytes: 5_400_000,
      queueDepth: 0,
      pendingUploads: 0,
      networkType: 'cellular',
      clockOffsetMs: -3_600_000,
      appVersion: '0.1.0',
    };
    expect(await inTenant((tx) => tx.sync.recordReport(report))).toBe('recorded');
    expect(await inTenant((tx) => tx.sync.recordReport(report))).toBe('duplicate');
    expect(await inTenant((tx) => tx.sync.listReports({ userId: ENGINEER }))).toHaveLength(1);
  });
});
