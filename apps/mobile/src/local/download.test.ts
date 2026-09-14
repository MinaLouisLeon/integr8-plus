import { describe, expect, it } from 'vitest';
import { downloadWork, IdentityChangedError } from './download';
import {
  customer,
  identity,
  job,
  openJobs,
  recentlyClosedJobs,
  site,
  storageSummary,
} from './queries';
import {
  clientFor,
  customerDetail,
  ENGINEER,
  fakeServer,
  formDetail,
  insertDraft,
  insertFile,
  me,
  serve,
  workOrderDetail,
} from './testing/fixtures';
import { openTestDatabase } from './testing/node-driver';

const NOW = new Date('2026-09-14T12:00:00.000Z');

describe('downloading an engineer’s work', () => {
  it('stores open jobs, recently closed jobs, their customers, sites and forms', async () => {
    const server = fakeServer();
    const riverside = customerDetail();
    const gas = formDetail();
    const open = workOrderDetail(riverside, { formIds: [gas.form.id] });
    const closed = workOrderDetail(riverside, {
      state: 'complete',
      completedAt: '2026-09-01T15:00:00.000Z',
    });
    serve(server, { customer: riverside, workOrder: open, forms: [gas] });
    serve(server, { customer: riverside, workOrder: closed });

    const { db } = await openTestDatabase();
    const outcome = await downloadWork(clientFor(server), db, { now: NOW });

    expect(outcome).toMatchObject({ workOrders: 2, customers: 1, forms: 1, removedWorkOrders: 0 });
    expect((await db.read(openJobs)).map((item) => item.id)).toEqual([open.workOrder.id]);
    expect((await db.read(openJobs))[0]).toMatchObject({
      customerName: 'Riverside Housing',
      siteName: 'Block A',
      siteAddress: '1 River Road, Leeds, LS1 1AA',
      hazards: true,
    });
    expect((await db.read((sql) => recentlyClosedJobs(sql))).map((item) => item.id)).toEqual([
      closed.workOrder.id,
    ]);

    const stored = await db.read((sql) => job(sql, open.workOrder.id));
    expect(stored?.detail.site.access.gateCode).toBe('4471#');
    const localSite = await db.read((sql) => site(sql, riverside.sites[0]!.id));
    expect(localSite).toMatchObject({
      customer: { name: 'Riverside Housing' },
      contact: { name: 'Pat Caretaker' },
    });
    expect((await db.read((sql) => customer(sql, riverside.customer.id)))?.jobs).toHaveLength(2);
    expect(await db.read(identity)).toMatchObject({
      userId: ENGINEER,
      displayName: 'Ed Engineer',
      lastDownloadAt: NOW.toISOString(),
    });
    expect(await db.read((sql) => sql.all('select id, form_id from form_versions'))).toEqual([
      { id: gas.live!.id, form_id: gas.form.id },
    ]);
  });

  it('asks for only this person’s jobs, and closed ones from the last 30 days', async () => {
    const server = fakeServer();
    const { db } = await openTestDatabase();
    await downloadWork(clientFor(server), db, { now: NOW });

    const lists = server.requests.filter((url) => url.pathname === '/v1/work-orders');
    expect(lists).toHaveLength(2);
    expect(lists.every((url) => url.searchParams.get('assigneeId') === 'me')).toBe(true);
    expect(lists[0]!.searchParams.getAll('state')).toEqual([
      'scheduled',
      'dispatched',
      'travelling',
      'on_site',
      'in_progress',
      'awaiting_parts',
    ]);
    expect(lists[1]!.searchParams.get('closedSince')).toBe('2026-08-15T12:00:00.000Z');
  });

  it('follows every page of a long list', async () => {
    const server = fakeServer();
    server.pageSize = 2;
    const riverside = customerDetail();
    for (let index = 0; index < 5; index += 1) {
      serve(server, { customer: riverside, workOrder: workOrderDetail(riverside) });
    }
    const { db } = await openTestDatabase();
    expect((await downloadWork(clientFor(server), db, { now: NOW })).workOrders).toBe(5);
  });

  it('writes nothing when the connection fails part-way', async () => {
    const server = fakeServer();
    const riverside = customerDetail();
    serve(server, { customer: riverside, workOrder: workOrderDetail(riverside) });
    const { db } = await openTestDatabase();
    await downloadWork(clientFor(server), db, { now: NOW });

    const moved = workOrderDetail(riverside, { title: 'Renamed' });
    serve(server, { customer: riverside, workOrder: moved });
    server.failures.set('/v1/customers', 503);
    await expect(downloadWork(clientFor(server), db, { now: NOW })).rejects.toMatchObject({
      status: 503,
    });
    expect(await db.read(openJobs)).toHaveLength(1);
  });

  it('skips a job that disappears between the list and its detail', async () => {
    const server = fakeServer();
    const riverside = customerDetail();
    const kept = workOrderDetail(riverside);
    serve(server, { customer: riverside, workOrder: kept });
    const client = clientFor(server);
    const gone = workOrderDetail(riverside);
    serve(server, { customer: riverside, workOrder: gone });
    server.failures.set(`/v1/work-orders/${gone.workOrder.id}`, 404);

    const { db } = await openTestDatabase();
    await downloadWork(client, db, { now: NOW });
    expect((await db.read(openJobs)).map((item) => item.id)).toEqual([kept.workOrder.id]);
  });
});

describe('a later download', () => {
  it('drops a job the engineer was taken off, unless unsent work points at it', async () => {
    const server = fakeServer();
    const riverside = customerDetail();
    const gas = formDetail();
    const first = workOrderDetail(riverside, { formIds: [gas.form.id] });
    const second = workOrderDetail(riverside);
    const third = workOrderDetail(riverside);
    serve(server, { customer: riverside, workOrder: first, forms: [gas] });
    serve(server, { customer: riverside, workOrder: second });
    serve(server, { customer: riverside, workOrder: third });

    const { db } = await openTestDatabase();
    await downloadWork(clientFor(server), db, { now: NOW });
    await db.write(['drafts', 'files'], async (sql) => {
      await insertDraft(sql, {
        formId: gas.form.id,
        formVersionId: gas.live!.id,
        workOrderId: first.workOrder.id,
      });
      await insertFile(sql, {
        ownerKind: 'work_order',
        ownerId: second.workOrder.id,
        state: 'pending_upload',
        byteSize: 1000,
      });
    });

    // Reassigned: the server lists none of them now.
    server.workOrders.clear();
    const outcome = await downloadWork(clientFor(server), db, { now: NOW });

    expect(outcome.removedWorkOrders).toBe(1);
    expect((await db.read(openJobs)).map((item) => item.id).sort()).toEqual(
      [first.workOrder.id, second.workOrder.id].sort(),
    );
    // What the kept jobs need stays with them: the customer, the site, the draft's form version.
    expect(await db.read((sql) => customer(sql, riverside.customer.id))).toBeDefined();
    expect(await db.read(storageSummary)).toMatchObject({ unsentDrafts: 1, pendingUploads: 1 });
    expect(await db.read((sql) => sql.all('select id from form_versions'))).toEqual([
      { id: gas.live!.id },
    ]);
  });

  it('refuses to mix another person’s work into the phone', async () => {
    const server = fakeServer();
    const { db } = await openTestDatabase();
    await downloadWork(clientFor(server), db, { now: NOW });

    server.me = me({ userId: '0b6a9a4e-0000-4000-8000-0000000000e2', displayName: 'Someone Else' });
    await expect(downloadWork(clientFor(server), db, { now: NOW })).rejects.toBeInstanceOf(
      IdentityChangedError,
    );
    expect(await db.read(identity)).toMatchObject({ userId: ENGINEER });
  });
});
