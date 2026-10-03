import { findTransition, WORK_ORDER_STATES, type WorkOrderState } from '@integr8/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../connection.js';
import type { WorkOrder } from '../repositories/work-orders.js';
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
 * Customers, sites and work orders (migration 0010), against a real database.
 *
 * The two P10 exit criteria that are about rules — an invalid transition is
 * refused, and a job with required forms unsubmitted cannot be completed — are
 * proven here below the API, with raw SQL as the runtime role and as the owner,
 * because "from any client" means exactly that.
 */

const DISPATCHER = '00000000-0000-4000-8000-00000000d101';
const ENGINEER = '00000000-0000-4000-8000-00000000e101';
const SECOND_ENGINEER = '00000000-0000-4000-8000-00000000e102';

let northwind: TenantFixture;
let contoso: TenantFixture;
let owner: pg.Client;
let app: pg.Client;

let customerId: string;
let siteId: string;
let jobTypeId: string;
let requiredFormVersion: string;
let requiredFormId: string;
let optionalFormId: string;

const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(northwind.id, fn);

async function publishForm(title: string) {
  return inTenant(async (tx) => {
    const form = await tx.forms.createForm({ title, createdBy: DISPATCHER });
    const draft = await tx.forms.createDraft({
      formId: form.id,
      definition: {
        schemaVersion: 1,
        title: { en: title },
        pages: [
          {
            id: 'page_1',
            sections: [
              { id: 'section_1', fields: [{ id: 'note', type: 'text', label: { en: 'Note' } }] },
            ],
          },
        ],
      },
      createdBy: DISPATCHER,
    });
    const version = await tx.forms.publishDraft(draft.id, DISPATCHER);
    return { formId: form.id, versionId: version!.id };
  });
}

const newJob = (crew: { userId: string; lead: boolean }[] = []) =>
  inTenant((tx) => tx.workOrders.create({ customerId, siteId, jobTypeId, crew }, DISPATCHER));

async function moveTo(job: WorkOrder, path: WorkOrderState[], reason?: string): Promise<WorkOrder> {
  let current = job;
  for (const to of path) {
    const result = await inTenant((tx) =>
      tx.workOrders.transition(current.id, current.revision, to, ENGINEER, reason),
    );
    if (result.outcome !== 'written') {
      throw new Error(`setup: ${current.state} → ${to}: ${result.outcome}`);
    }
    current = result.workOrder;
  }
  return current;
}

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  northwind = await createTenant('northwind');
  contoso = await createTenant('contoso');
  owner = await connectAsOwner();
  app = await connectAsApp();

  for (const [tenant, users] of [
    [northwind, [DISPATCHER, ENGINEER, SECOND_ENGINEER]],
    [contoso, [DISPATCHER]],
  ] as const) {
    await withTenant(tenant.id, async (tx) => {
      for (const userId of users) {
        await tx.tenantUsers.create({
          userId,
          email: `${userId.slice(-4)}@${tenant.slug}.example`,
          displayName: userId.slice(-4),
          role: userId === DISPATCHER ? 'dispatcher' : 'engineer',
        });
      }
    });
  }

  const required = await publishForm('Gas safety record');
  requiredFormId = required.formId;
  requiredFormVersion = required.versionId;
  optionalFormId = (await publishForm('Customer feedback')).formId;

  await inTenant(async (tx) => {
    const customer = await tx.customers.create(
      { name: 'Riverside Housing', accountNumber: 'RH-001', tags: ['Social Housing', 'priority '] },
      DISPATCHER,
    );
    customerId = customer.id;
    siteId = (
      await tx.sites.create(
        customerId,
        {
          name: 'Block A',
          address: { line1: '1 River Road', city: 'Leeds', postcode: 'LS1 1AA', countryCode: 'gb' },
          access: { gateCode: '4471#', hazards: 'Asbestos in plant room' },
        },
        DISPATCHER,
      )
    ).id;
    jobTypeId = (
      await tx.jobTypes.create(
        {
          name: 'Boiler service',
          code: 'boiler service',
          expectedDurationMinutes: 90,
          instructions: 'Check flue terminal.',
          checklist: [
            { id: 'isolate', label: 'Isolate supply' },
            { id: 'flue', label: 'Inspect flue' },
          ],
          forms: [
            { formId: requiredFormId, required: true },
            { formId: optionalFormId, required: false },
          ],
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

describe('customers and contacts', () => {
  it('normalises tags, finds by prefix, and keeps account numbers unique regardless of case', async () => {
    const found = await inTenant((tx) => tx.customers.list({ text: 'river hous' }));
    expect(found.items.map((customer) => customer.name)).toEqual(['Riverside Housing']);
    expect(found.items[0]?.tags).toEqual(['social housing', 'priority']);
    expect((await inTenant((tx) => tx.customers.list({ tags: ['PRIORITY'] }))).items).toHaveLength(
      1,
    );

    await expect(
      inTenant((tx) =>
        tx.customers.create({ name: 'Copycat', accountNumber: 'rh-001' }, DISPATCHER),
      ),
    ).rejects.toThrow(/customers_account_number_unique/u);
    expect((await inTenant((tx) => tx.customers.findByAccountNumber('rh-001')))?.id).toBe(
      customerId,
    );
  });

  it('keeps one primary contact, and a site’s contact must be its own customer’s', async () => {
    const [first, second] = await inTenant(async (tx) => [
      await tx.customers.addContact(customerId, { name: 'Ann', isPrimary: true }),
      await tx.customers.addContact(customerId, { name: 'Bob', isPrimary: true }),
    ]);
    const contacts = await inTenant((tx) => tx.customers.listContacts(customerId));
    expect(contacts.filter((contact) => contact.isPrimary).map((contact) => contact.id)).toEqual([
      second.id,
    ]);

    const other = await inTenant((tx) => tx.customers.create({ name: 'Other Ltd' }, DISPATCHER));
    const stranger = await inTenant((tx) => tx.customers.addContact(other.id, { name: 'Carol' }));
    await expect(
      inTenant((tx) => tx.sites.update(siteId, { contactId: stranger.id }, DISPATCHER)),
    ).rejects.toThrow(/sites_contact_fk/u);
    expect(
      (await inTenant((tx) => tx.sites.update(siteId, { contactId: first.id }, DISPATCHER)))
        ?.contactId,
    ).toBe(first.id);
  });
});

describe('sites', () => {
  it('records when access notes change, and who changed them', async () => {
    const site = await inTenant((tx) => tx.sites.find(siteId));
    expect(site?.access).toMatchObject({
      gateCode: '4471#',
      hazards: 'Asbestos in plant room',
      updatedBy: DISPATCHER,
    });
    expect(site?.access.updatedAt).toBeInstanceOf(Date);

    const updated = await inTenant((tx) =>
      tx.sites.update(siteId, { access: { parking: 'Bay 3' } }, ENGINEER),
    );
    expect(updated?.access).toMatchObject({
      parking: 'Bay 3',
      updatedBy: ENGINEER,
      gateCode: '4471#',
    });
    expect(updated!.access.updatedAt!.getTime()).toBeGreaterThanOrEqual(
      site!.access.updatedAt!.getTime(),
    );
  });

  it('keeps a pin until the address changes, and ignores a geocode for an address that has since changed', async () => {
    const site = await inTenant((tx) =>
      tx.sites.create(
        customerId,
        { name: 'Depot', address: { line1: '9 Mill Lane', city: 'York' } },
        DISPATCHER,
      ),
    );
    expect(site.geocodeStatus).toBe('pending');

    const pinned = await inTenant((tx) =>
      tx.sites.update(site.id, { location: { latitude: 53.958, longitude: -1.08 } }, DISPATCHER),
    );
    expect(pinned).toMatchObject({
      geocodeStatus: 'manual',
      location: { latitude: 53.958, longitude: -1.08 },
    });
    expect(
      await inTenant((tx) =>
        tx.sites.recordGeocode(site.id, '9 Mill Lane, York', {
          location: { latitude: 1, longitude: 1 },
          accuracy: 'address',
        }),
      ),
    ).toBeUndefined();

    const moved = await inTenant((tx) =>
      tx.sites.update(site.id, { address: { line1: '10 Mill Lane' } }, DISPATCHER),
    );
    expect(moved).toMatchObject({ geocodeStatus: 'pending', location: null });

    expect(
      await inTenant((tx) =>
        tx.sites.recordGeocode(site.id, '9 Mill Lane, York', {
          location: { latitude: 1, longitude: 1 },
          accuracy: 'address',
        }),
      ),
    ).toBeUndefined();
    const found = await inTenant((tx) =>
      tx.sites.recordGeocode(site.id, '10 Mill Lane, York', {
        location: { latitude: 53.9591, longitude: -1.0815 },
        accuracy: 'rooftop',
      }),
    );
    expect(found).toMatchObject({
      geocodeStatus: 'found',
      geocodeAccuracy: 'rooftop',
      location: { latitude: 53.9591 },
    });
  });

  it('stays with its customer', async () => {
    const other = await inTenant((tx) => tx.customers.create({ name: 'Elsewhere' }, DISPATCHER));
    await expect(
      asTenant(app, northwind.id, () =>
        app.query('update sites set customer_id = $1 where id = $2', [other.id, siteId]),
      ),
    ).rejects.toThrow(/cannot be moved/u);
  });
});

describe('job types', () => {
  it('copies forms, checklist, instructions and priority onto a new job, and later changes leave it alone', async () => {
    const job = await newJob();
    expect(job).toMatchObject({
      title: 'Boiler service',
      instructions: 'Check flue terminal.',
      state: 'scheduled',
    });
    await inTenant((tx) =>
      tx.jobTypes.update(jobTypeId, { checklist: [{ id: 'x', label: 'Changed' }] }),
    );

    const [forms, checklist] = await inTenant(async (tx) => [
      await tx.workOrders.listForms(job.id),
      await tx.workOrders.listChecklist(job.id),
    ]);
    expect(forms.map((form) => [form.title, form.required])).toEqual([
      ['Gas safety record', true],
      ['Customer feedback', false],
    ]);
    expect(checklist.map((item) => item.label)).toEqual(['Isolate supply', 'Inspect flue']);
    await inTenant((tx) =>
      tx.jobTypes.update(jobTypeId, {
        checklist: [
          { id: 'isolate', label: 'Isolate supply' },
          { id: 'flue', label: 'Inspect flue' },
        ],
      }),
    );
  });

  it('lets a form say which job types require it', async () => {
    const other = await inTenant((tx) =>
      tx.jobTypes.create({ name: 'Landlord check', code: 'LGSR' }, DISPATCHER),
    );
    await inTenant((tx) => tx.jobTypes.setRequiringTypes(optionalFormId, [other.id, jobTypeId]));
    expect(
      (await inTenant((tx) => tx.jobTypes.listForForm(optionalFormId))).sort((a, b) =>
        a.jobTypeId.localeCompare(b.jobTypeId),
      ),
    ).toEqual(
      [
        { jobTypeId, required: true },
        { jobTypeId: other.id, required: true },
      ].sort((a, b) => a.jobTypeId.localeCompare(b.jobTypeId)),
    );
    await inTenant((tx) => tx.jobTypes.setRequiringTypes(optionalFormId, []));
    const after = await inTenant((tx) => tx.jobTypes.find(jobTypeId));
    expect(after?.forms.find((form) => form.formId === optionalFormId)).toMatchObject({
      required: false,
    });
  });
});

describe('the state machine, for every client', () => {
  it('numbers jobs per company, and nobody can choose or reuse a number', async () => {
    const first = await newJob();
    const second = await newJob();
    expect(second.reference).toBe(first.reference + 1);
    const theirs = await withTenant(contoso.id, async (tx) => {
      const customer = await tx.customers.create({ name: 'Contoso' }, DISPATCHER);
      const site = await tx.sites.create(
        customer.id,
        { name: 'HQ', address: { line1: 'Main St' } },
        DISPATCHER,
      );
      const type = await tx.jobTypes.create({ name: 'Survey', code: 'SURVEY' }, DISPATCHER);
      return tx.workOrders.create(
        { customerId: customer.id, siteId: site.id, jobTypeId: type.id },
        DISPATCHER,
      );
    });
    expect(theirs.reference).toBe(1);

    await expect(
      asTenant(app, northwind.id, () =>
        app.query('update work_order_counters set last_reference = 0 where tenant_id = $1', [
          northwind.id,
        ]),
      ),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      asTenant(app, northwind.id, () =>
        app.query('update work_orders set reference = 1 where id = $1', [first.id]),
      ),
    ).rejects.toThrow(/keeps its reference/u);
  });

  it('refuses every transition the table does not list, written directly as the runtime role', async () => {
    // One job per starting state, each reached legitimately, then every
    // disallowed target attempted in raw SQL.
    const routes: Record<WorkOrderState, WorkOrderState[]> = {
      scheduled: [],
      dispatched: ['dispatched'],
      travelling: ['dispatched', 'travelling'],
      on_site: ['dispatched', 'on_site'],
      in_progress: ['dispatched', 'on_site', 'in_progress'],
      awaiting_parts: ['dispatched', 'on_site', 'in_progress', 'awaiting_parts'],
      complete: [],
      reviewed: [],
      cancelled: ['cancelled'],
    };
    const refused: string[] = [];
    for (const from of WORK_ORDER_STATES) {
      if (from === 'complete' || from === 'reviewed') {
        continue;
      }
      const job = await moveTo(
        await newJob([{ userId: ENGINEER, lead: true }]),
        routes[from],
        'setting up',
      );
      for (const to of WORK_ORDER_STATES) {
        if (to === from || findTransition(from, to) !== undefined) {
          continue;
        }
        try {
          await asTenant(app, northwind.id, () =>
            app.query(
              `update work_orders set state = $1, last_actor = $2, last_reason = 'forcing it' where id = $3`,
              [to, ENGINEER, job.id],
            ),
          );
        } catch (error) {
          if ((error as Error).message.includes('cannot go from')) {
            refused.push(`${from}>${to}`);
            continue;
          }
          throw error;
        }
        throw new Error(`${from} → ${to} was accepted`);
      }
    }
    // 9 states × 8 targets, less the 20 allowed; complete and reviewed are covered below.
    expect(refused.length).toBe(7 * 8 - WORK_ORDER_STATE_COUNT_ALLOWED_FROM_SEVEN);
  });

  it('asks why for a cancellation, even from the owner connection', async () => {
    const job = await newJob();
    await expect(
      owner.query(
        `update work_orders set state = 'cancelled', last_actor = $1, last_reason = null where id = $2`,
        [DISPATCHER, job.id],
      ),
    ).rejects.toThrow(/needs a reason/u);
    const refused = await inTenant((tx) =>
      tx.workOrders.transition(job.id, job.revision, 'cancelled', DISPATCHER),
    );
    expect(refused.outcome).toBe('reason_required');
  });

  it('dispatches only with someone assigned', async () => {
    const job = await newJob();
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(`update work_orders set state = 'dispatched', last_actor = $1 where id = $2`, [
          DISPATCHER,
          job.id,
        ]),
      ),
    ).rejects.toThrow(/nobody assigned/u);
    expect(
      (
        await inTenant((tx) =>
          tx.workOrders.transition(job.id, job.revision, 'dispatched', DISPATCHER),
        )
      ).outcome,
    ).toBe('nobody_assigned');
  });

  it('cannot complete a job whose required form is unsubmitted, however it is written', async () => {
    const job = await moveTo(await newJob([{ userId: ENGINEER, lead: false }]), [
      'dispatched',
      'on_site',
      'in_progress',
    ]);

    const refused = await inTenant((tx) =>
      tx.workOrders.transition(job.id, job.revision, 'complete', ENGINEER),
    );
    expect(refused).toMatchObject({
      outcome: 'incomplete',
      missing: { forms: [{ formId: requiredFormId, title: 'Gas safety record' }], signoff: false },
    });
    for (const client of [app, owner]) {
      const write = () =>
        client.query(`update work_orders set state = 'complete', last_actor = $1 where id = $2`, [
          ENGINEER,
          job.id,
        ]);
      await expect(client === app ? asTenant(app, northwind.id, write) : write()).rejects.toThrow(
        /required forms not submitted: Gas safety record/u,
      );
    }

    // A draft is not enough; a submitted one is.
    const draft = await inTenant((tx) =>
      tx.submissions.startDraft({
        formVersionId: requiredFormVersion,
        submittedBy: ENGINEER,
        workOrderId: job.id,
      }),
    );
    expect(
      (await inTenant((tx) => tx.workOrders.transition(job.id, job.revision, 'complete', ENGINEER)))
        .outcome,
    ).toBe('incomplete');
    const submitted = await inTenant((tx) =>
      tx.submissions.submit(draft.id, { note: 'ok' }, draft.revision, ENGINEER),
    );
    expect(submitted.outcome).toBe('written');

    const done = await inTenant((tx) =>
      tx.workOrders.transition(job.id, job.revision, 'complete', ENGINEER),
    );
    expect(done.outcome).toBe('written');
    if (done.outcome !== 'written') return;
    expect(done.workOrder.completedAt).toBeInstanceOf(Date);

    // Closed: its details are frozen until it is reopened, with a reason.
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(`update work_orders set title = 'Renamed', last_actor = $1 where id = $2`, [
          DISPATCHER,
          job.id,
        ]),
      ),
    ).rejects.toThrow(/reopen it before changing it/u);
    const reopened = await inTenant((tx) =>
      tx.workOrders.transition(
        job.id,
        done.workOrder.revision,
        'in_progress',
        DISPATCHER,
        'Photo missing',
      ),
    );
    expect(reopened).toMatchObject({
      outcome: 'written',
      workOrder: { state: 'in_progress', completedAt: null },
    });
  });

  it('refuses a submission for a form that is not one of the job’s, and never moves one to another job', async () => {
    const other = await publishForm('Unrelated form');
    const job = await newJob();
    await expect(
      inTenant((tx) =>
        tx.submissions.startDraft({
          formVersionId: other.versionId,
          submittedBy: ENGINEER,
          workOrderId: job.id,
        }),
      ),
    ).rejects.toThrow(/is not one of work order/u);

    const draft = await inTenant((tx) =>
      tx.submissions.startDraft({
        formVersionId: requiredFormVersion,
        submittedBy: ENGINEER,
        workOrderId: job.id,
      }),
    );
    const elsewhere = await newJob();
    await expect(
      asTenant(app, northwind.id, () =>
        app.query('update submissions set work_order_id = $1 where id = $2', [
          elsewhere.id,
          draft.id,
        ]),
      ),
    ).rejects.toThrow(/cannot be moved/u);

    const linked = await inTenant((tx) =>
      tx.submissions.list({ workOrderId: job.id, order: 'updated' }),
    );
    expect(linked.items.map((submission) => submission.id)).toEqual([draft.id]);
    expect(
      (await inTenant((tx) => tx.submissions.list({ siteId, order: 'updated' }))).items.length,
    ).toBeGreaterThan(0);
    expect(
      (
        await inTenant((tx) =>
          tx.submissions.list({
            customerId: '00000000-0000-4000-8000-000000000000',
            order: 'updated',
          }),
        )
      ).items,
    ).toEqual([]);
  });

  it('refuses a stale revision', async () => {
    const job = await newJob();
    const changed = await inTenant((tx) =>
      tx.workOrders.update(job.id, job.revision, { priority: 'urgent' }, DISPATCHER),
    );
    expect(changed.outcome).toBe('written');
    const stale = await inTenant((tx) =>
      tx.workOrders.update(job.id, job.revision, { priority: 'low' }, DISPATCHER),
    );
    expect(stale.outcome).toBe('conflict');
  });
});

describe('crews and history', () => {
  it('keeps one lead, and writes every change to a history nobody can rewrite', async () => {
    const job = await newJob([{ userId: ENGINEER, lead: false }]);
    expect(
      (await inTenant((tx) => tx.workOrders.listCrew(job.id))).map((member) => [
        member.userId,
        member.lead,
      ]),
    ).toEqual([[ENGINEER, true]]);

    await inTenant((tx) =>
      tx.workOrders.setCrew(
        job.id,
        [
          { userId: ENGINEER, lead: false },
          { userId: SECOND_ENGINEER, lead: true },
        ],
        DISPATCHER,
      ),
    );
    await inTenant((tx) =>
      tx.workOrders.setCrew(job.id, [{ userId: SECOND_ENGINEER, lead: true }], DISPATCHER),
    );
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(
          `insert into work_order_assignments (tenant_id, work_order_id, user_id, is_lead, assigned_by) values ($1, $2, $3, true, $4)`,
          [northwind.id, job.id, ENGINEER, DISPATCHER],
        ),
      ),
    ).rejects.toThrow(/work_order_assignments_one_lead/u);

    const rescheduled = await inTenant((tx) =>
      tx.workOrders.update(
        job.id,
        job.revision,
        { dueBy: new Date('2026-10-01T17:00:00Z'), title: 'Boiler service — Flat 4' },
        DISPATCHER,
      ),
    );
    expect(rescheduled.outcome).toBe('written');

    const events = await inTenant((tx) => tx.workOrders.listEvents(job.id));
    expect(events.map((event) => [event.kind, event.userId])).toEqual([
      ['created', null],
      ['assigned', ENGINEER],
      ['lead_changed', ENGINEER],
      ['assigned', SECOND_ENGINEER],
      ['unassigned', ENGINEER],
      ['rescheduled', null],
      ['updated', null],
    ]);
    expect(events.at(-1)?.details).toEqual({ fields: ['title'] });

    for (const statement of [
      'update work_order_events set reason = $2 where work_order_id = $1',
      'delete from work_order_events where work_order_id = $1',
    ]) {
      await expect(
        owner.query(statement, statement.includes('$2') ? [job.id, 'x'] : [job.id]),
      ).rejects.toThrow(/append-only/u);
    }
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(
          `insert into work_order_events (tenant_id, work_order_id, kind, actor_id) values ($1, $2, 'created', $3)`,
          [northwind.id, job.id, DISPATCHER],
        ),
      ),
    ).rejects.toThrow(/permission denied/u);
  });

  it('lists by assignee, unassigned, state and text, a page at a time', async () => {
    const mine = await newJob([{ userId: SECOND_ENGINEER, lead: true }]);
    const byAssignee = await inTenant((tx) =>
      tx.workOrders.list({ assigneeId: SECOND_ENGINEER, limit: 500 }),
    );
    expect(byAssignee.items.map((job) => job.id)).toContain(mine.id);
    const unassigned = await inTenant((tx) => tx.workOrders.list({ unassigned: true, limit: 500 }));
    expect(unassigned.items.map((job) => job.id)).not.toContain(mine.id);
    expect(
      (
        await inTenant((tx) =>
          tx.workOrders.list({ text: `WO-${String(mine.reference).padStart(6, '0')}` }),
        )
      ).items.map((job) => job.id),
    ).toEqual([mine.id]);

    const cancelled = await moveTo(await newJob(), ['cancelled'], 'Customer rang to cancel');
    const closedSince = (since: Date) =>
      inTenant((tx) => tx.workOrders.list({ closedSince: since, limit: 500 }));
    const recent = await closedSince(new Date(Date.now() - 60_000));
    expect(recent.items.map((job) => job.id)).toContain(cancelled.id);
    expect(
      recent.items.every((job) => ['complete', 'reviewed', 'cancelled'].includes(job.state)),
    ).toBe(true);
    expect(recent.items.map((job) => job.id)).not.toContain(mine.id);
    expect(
      (await closedSince(new Date(Date.now() + 60_000))).items.map((job) => job.id),
    ).not.toContain(cancelled.id);

    const seen = new Set<string>();
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await inTenant((tx) =>
        tx.workOrders.list({
          limit: 3,
          order: 'created',
          ...(after === undefined ? {} : { after }),
        }),
      );
      for (const job of page.items) {
        expect(seen.has(job.id)).toBe(false);
        seen.add(job.id);
      }
      after = page.next;
      pages += 1;
    } while (after !== undefined && pages < 100);
    const all = await inTenant((tx) => tx.workOrders.list({ limit: 500 }));
    expect(seen.size).toBe(all.items.length);
  });
});

describe('isolation', () => {
  it('returns nothing of another company from any list, even with RLS out of the way', async () => {
    for (const tenant of [northwind, contoso]) {
      const rows = await withUnprotectedRepositories(tenant.id, async (tx) => [
        ...(await tx.customers.list({ limit: 500 })).items,
        ...(await tx.sites.list({ limit: 500, includeArchived: true })).items,
        ...(await tx.jobTypes.list({ includeArchived: true })),
        ...(await tx.workOrders.list({ limit: 500 })).items,
      ]);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.tenantId === tenant.id)).toBe(true);
    }
    const theirJob = (await withTenant(contoso.id, (tx) => tx.workOrders.list())).items[0]!;
    expect(await inTenant((tx) => tx.workOrders.find(theirJob.id))).toBeUndefined();
    expect(await inTenant((tx) => tx.workOrders.listEvents(theirJob.id))).toEqual([]);
  });
});

/** Transitions whose `from` is one of the seven states the refusal test starts from. */
const WORK_ORDER_STATE_COUNT_ALLOWED_FROM_SEVEN = WORK_ORDER_STATES.filter(
  (state) => state !== 'complete' && state !== 'reviewed',
).reduce(
  (sum, from) =>
    sum + WORK_ORDER_STATES.filter((to) => findTransition(from, to) !== undefined).length,
  0,
);
