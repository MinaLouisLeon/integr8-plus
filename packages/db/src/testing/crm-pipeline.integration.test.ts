import { toTenantId } from '@integr8/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * Migration 0025 (CRM/ERP plan, phase C3): pipelines and stages, opportunities
 * and their history, activities and their links — the rules the database keeps
 * whatever the API does.
 */

const USER = '00000000-0000-4000-8000-00000000c401';

let owner: pg.Client;
let app: pg.Client;
let northwind: TenantFixture;
let southgate: TenantFixture;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  app = await connectAsApp();
  northwind = await createTenant('crm3-northwind');
  southgate = await createTenant('crm3-southgate');
});

afterAll(async () => {
  await app.end();
  await owner.end();
  await releaseTestDatabase();
});

const repos = <T>(
  tenant: TenantFixture,
  fn: Parameters<typeof withUnprotectedRepositories<T>>[1],
) => withUnprotectedRepositories(toTenantId(tenant.id), fn);

async function customer(tenantId: string, name: string): Promise<string> {
  const result = await owner.query<{ id: string }>(
    `insert into customers (tenant_id, name, created_by) values ($1, $2, $3) returning id`,
    [tenantId, name, USER],
  );
  return result.rows[0]!.id;
}

async function lead(tenantId: string, name: string): Promise<string> {
  const result = await owner.query<{ id: string }>(
    `insert into crm_leads (tenant_id, display_name, created_by) values ($1, $2, $3) returning id`,
    [tenantId, name, USER],
  );
  return result.rows[0]!.id;
}

describe('pipelines', () => {
  it('makes one default pipeline with the standard stages, however often it is asked', async () => {
    const tenant = await createTenant('crm3-default');
    const [first, second] = await Promise.all([
      repos(tenant, (tx) => tx.crmPipelines.ensureDefault()),
      repos(tenant, (tx) => tx.crmPipelines.ensureDefault()),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.stages.map((stage) => stage.key)).toEqual([
      'new',
      'qualified',
      'proposal',
      'negotiation',
      'won',
      'lost',
    ]);
    const count = await owner.query<{ n: string }>(
      `select count(*) as n from crm_pipelines where tenant_id = $1`,
      [tenant.id],
    );
    expect(count.rows[0]?.n).toBe('1');
  });

  it('keeps stage keys and positions unique within a pipeline', async () => {
    const pipeline = await repos(northwind, (tx) => tx.crmPipelines.ensureDefault());
    await expect(
      owner.query(
        `insert into crm_pipeline_stages (tenant_id, pipeline_id, key, label, position, probability_bp, outcome)
         values ($1, $2, 'won', 'Won again', 99, 10000, 'won')`,
        [northwind.id, pipeline.id],
      ),
    ).rejects.toThrow(/crm_pipeline_stages_key_unique/u);
  });
});

describe('opportunities', () => {
  it('needs a customer or a lead', async () => {
    const pipeline = await repos(northwind, (tx) => tx.crmPipelines.ensureDefault());
    const stage = pipeline.stages[0]!;
    await expect(
      owner.query(
        `insert into crm_opportunities (tenant_id, title, pipeline_id, stage_id, currency_code, probability_bp, created_by)
         values ($1, 'Detached', $2, $3, 'EGP', 1000, $4)`,
        [northwind.id, pipeline.id, stage.id, USER],
      ),
    ).rejects.toThrow(/crm_opportunities_has_party/u);
  });

  it('refuses another company’s customer, lead or stage', async () => {
    const ours = await repos(northwind, (tx) => tx.crmPipelines.ensureDefault());
    const theirs = await repos(southgate, (tx) => tx.crmPipelines.ensureDefault());
    const theirCustomer = await customer(southgate.id, 'Southgate Buyer');
    const theirLead = await lead(southgate.id, 'Southgate Prospect');
    const ourCustomer = await customer(northwind.id, 'Northwind Buyer');

    const insert = (
      customerId: string | null,
      leadId: string | null,
      pipelineId: string,
      stageId: string,
    ) =>
      owner.query(
        `insert into crm_opportunities (tenant_id, title, customer_id, lead_id, pipeline_id, stage_id, currency_code, probability_bp, created_by)
         values ($1, 'Cross', $2, $3, $4, $5, 'EGP', 1000, $6)`,
        [northwind.id, customerId, leadId, pipelineId, stageId, USER],
      );

    await expect(insert(theirCustomer, null, ours.id, ours.stages[0]!.id)).rejects.toThrow(
      /crm_opportunities_customer_fk/u,
    );
    await expect(insert(null, theirLead, ours.id, ours.stages[0]!.id)).rejects.toThrow(
      /crm_opportunities_lead_fk/u,
    );
    await expect(insert(ourCustomer, null, theirs.id, theirs.stages[0]!.id)).rejects.toMatchObject({
      constraint: 'crm_opportunities_stage_fk',
    });
  });

  it('keeps the status equal to the stage’s outcome', async () => {
    const pipeline = await repos(northwind, (tx) => tx.crmPipelines.ensureDefault());
    const open = pipeline.stages.find((stage) => stage.key === 'new')!;
    const id = await customer(northwind.id, 'Status Check');
    await expect(
      owner.query(
        `insert into crm_opportunities (tenant_id, title, customer_id, pipeline_id, stage_id, currency_code, probability_bp, status, closed_at, created_by)
         values ($1, 'Mismatch', $2, $3, $4, 'EGP', 1000, 'won', now(), $5)`,
        [northwind.id, id, pipeline.id, open.id, USER],
      ),
    ).rejects.toThrow(/status must be its stage/u);
  });

  it('moves between stages, writes the history, and refuses a stale move', async () => {
    const pipeline = await repos(northwind, (tx) => tx.crmPipelines.ensureDefault());
    const [first, , proposal, , won, lost] = pipeline.stages;
    const customerId = await customer(northwind.id, 'Mover Ltd');
    const created = await repos(northwind, (tx) =>
      tx.crmOpportunities.create(
        { title: 'Annual maintenance', customerId, amount: '125000.5', currencyCode: 'EGP' },
        first!,
        USER,
      ),
    );
    expect(created).toMatchObject({ status: 'open', probabilityBp: 1000, amount: '125000.5' });

    const moved = await repos(northwind, (tx) =>
      tx.crmOpportunities.move(created.id, created.version, {
        from: first!,
        to: proposal!,
        kind: 'stage_changed',
        lostReason: null,
        actorId: USER,
      }),
    );
    expect(moved).toMatchObject({ stageId: proposal!.id, probabilityBp: 5000, version: 2 });

    const stale = await repos(northwind, (tx) =>
      tx.crmOpportunities.move(created.id, created.version, {
        from: first!,
        to: won!,
        kind: 'won',
        lostReason: null,
        actorId: USER,
      }),
    );
    expect(stale).toBe('version_conflict');

    const lostIt = await repos(northwind, (tx) =>
      tx.crmOpportunities.move(created.id, 2, {
        from: proposal!,
        to: lost!,
        kind: 'lost',
        lostReason: 'Went with a cheaper quote',
        actorId: USER,
      }),
    );
    expect(lostIt).toMatchObject({ status: 'lost', lostReason: 'Went with a cheaper quote' });
    expect(typeof lostIt === 'object' && lostIt.closedAt).toBeInstanceOf(Date);

    const history = await repos(northwind, (tx) => tx.crmOpportunities.events(created.id));
    expect(history.map((event) => event.kind)).toEqual(['lost', 'stage_changed', 'created']);
  });

  it('keeps history append-only for the application', async () => {
    await expect(
      asTenant(app, northwind.id, () =>
        app.query('update crm_opportunity_events set reason = null'),
      ),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      asTenant(app, northwind.id, () => app.query('delete from crm_opportunity_events')),
    ).rejects.toThrow(/permission denied/u);
  });

  it('reads the close date as the calendar date it is', async () => {
    const pipeline = await repos(northwind, (tx) => tx.crmPipelines.ensureDefault());
    const customerId = await customer(northwind.id, 'Dated Ltd');
    const created = await repos(northwind, (tx) =>
      tx.crmOpportunities.create(
        { title: 'Dated', customerId, currencyCode: 'EGP', expectedCloseDate: '2026-12-31' },
        pipeline.stages[0]!,
        USER,
      ),
    );
    expect(created.expectedCloseDate).toBe('2026-12-31');
  });

  it('shows a company only its own opportunities', async () => {
    const seen = await asTenant(
      app,
      southgate.id,
      async () =>
        (await app.query<{ tenant_id: string }>('select tenant_id from crm_opportunities')).rows,
    );
    expect(seen.every((row) => row.tenant_id === southgate.id)).toBe(true);
    const page = await repos(southgate, (tx) =>
      tx.crmOpportunities.list({ includeArchived: true }),
    );
    expect(page.items.every((item) => item.tenantId === southgate.id)).toBe(true);
  });
});

describe('activities', () => {
  it('links only to the same company’s records', async () => {
    const theirLead = await lead(southgate.id, 'Not Yours');
    await expect(
      repos(northwind, (tx) =>
        tx.crmActivities.create(
          { kind: 'call', subject: 'Cross call', done: false },
          { leadIds: [theirLead], customerIds: [], opportunityIds: [] },
          USER,
        ),
      ),
    ).rejects.toThrow(/crm_activity_leads_lead_fk/u);
  });

  it('records done with who and when, and nothing else', async () => {
    await expect(
      owner.query(
        `insert into crm_activities (tenant_id, kind, subject, status, created_by)
         values ($1, 'call', 'Half done', 'done', $2)`,
        [northwind.id, USER],
      ),
    ).rejects.toThrow(/crm_activities_done_pairing/u);
  });

  it('lists the to-do list soonest first, undated last, and pages without skipping', async () => {
    const tenant = await createTenant('crm3-activities');
    const leadId = await lead(tenant.id, 'Busy Prospect');
    const links = { leadIds: [leadId], customerIds: [], opportunityIds: [] };
    const due = (days: number | null) =>
      days === null ? null : new Date(Date.now() + days * 86_400_000);
    for (const [subject, days] of [
      ['later', 5],
      ['undated A', null],
      ['overdue', -3],
      ['undated B', null],
      ['soon', 1],
    ] as const) {
      await repos(tenant, (tx) =>
        tx.crmActivities.create(
          { kind: 'follow_up', subject, dueAt: due(days), done: false },
          links,
          USER,
        ),
      );
    }

    const subjects: string[] = [];
    let after: { at: Date | null; id: string } | undefined;
    do {
      const page = await repos(tenant, (tx) =>
        tx.crmActivities.list({
          timeZone: 'Africa/Cairo',
          leadId,
          limit: 2,
          ...(after === undefined ? {} : { after }),
        }),
      );
      subjects.push(...page.items.map((item) => item.subject));
      after = page.next;
    } while (after !== undefined);
    expect(subjects.slice(0, 3)).toEqual(['overdue', 'soon', 'later']);
    expect(subjects.slice(3).sort()).toEqual(['undated A', 'undated B']);

    const overdue = await repos(tenant, (tx) =>
      tx.crmActivities.list({ timeZone: 'Africa/Cairo', due: 'overdue' }),
    );
    expect(overdue.items.map((item) => item.subject)).toEqual(['overdue']);
    const counts = await repos(tenant, (tx) => tx.crmActivities.counts('Africa/Cairo', USER));
    expect(counts.overdue).toBe(1);
  });
});

describe('the dashboard', () => {
  it('sums amounts exactly, per currency, and weights them by their chance', async () => {
    const tenant = await createTenant('crm3-dashboard');
    const pipeline = await repos(tenant, (tx) => tx.crmPipelines.ensureDefault());
    const customerId = await customer(tenant.id, 'Sums Ltd');
    const proposal = pipeline.stages.find((stage) => stage.key === 'proposal')!;
    for (const amount of ['0.1', '0.2', '9999999999999999.9999']) {
      await repos(tenant, (tx) =>
        tx.crmOpportunities.create(
          { title: `Deal ${amount}`, customerId, amount, currencyCode: 'EGP' },
          proposal,
          USER,
        ),
      );
    }
    await repos(tenant, (tx) =>
      tx.crmOpportunities.create(
        { title: 'Dollars', customerId, amount: '10', currencyCode: 'USD' },
        proposal,
        USER,
      ),
    );

    const dashboard = await repos(tenant, (tx) => tx.crmReports.dashboard(new Date(0)));
    expect(dashboard.openTotals).toEqual([
      {
        currencyCode: 'EGP',
        total: '10000000000000000.2999',
        weighted: '5000000000000000.15',
        count: 3,
      },
      { currencyCode: 'USD', total: '10', weighted: '5', count: 1 },
    ]);
    expect(dashboard.openByStage).toHaveLength(1);
    expect(dashboard.openByStage[0]).toMatchObject({ stageId: proposal.id, count: 4 });
  });
});
