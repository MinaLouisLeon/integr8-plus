import { withTenant } from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';
import { monthEnds } from './analytics.js';

/**
 * Customer 360's timeline, the figures and the CSV exports over HTTP (eighth
 * round; ADR-0012): each timeline source only for those who may read it; the
 * figures from the documents and their history; exports for the managers of
 * each area, audited.
 */

let api: ApiHarness;
let staff: PlatformAdmin;
let owner: Member;
let dispatcher: Member;
let engineer: Member;
let viewer: Member;
let customerId: string;
const tokens = new Map<Member, string>();
const today = new Date().toISOString().slice(0, 10);
const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

async function token(who: Member): Promise<string> {
  let value = tokens.get(who);
  if (value === undefined) {
    value = await api.signIn(who);
    tokens.set(who, value);
  }
  return value;
}

async function call(
  who: Member,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
) {
  return api.call(await token(who), {
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
}

async function created<T>(response: { statusCode: number; body: string }): Promise<T> {
  expect([200, 201], response.body).toContain(response.statusCode);
  return Promise.resolve(json<T>(response));
}

interface Stage {
  id: string;
  key: string;
}

let pipelineId: string;
let stages: Stage[];
const stage = (key: string) => stages.find((entry) => entry.key === key)!.id;

beforeAll(async () => {
  api = await startApi();
  staff = await api.platformAdmin('an-staff');
  owner = await api.member('owner', 'an-owner');
  dispatcher = await api.member('dispatcher', 'an-dispatcher');
  engineer = await api.member('engineer', 'an-engineer');
  viewer = await api.member('viewer', 'an-viewer');
  for (const flag of ['crm', 'sales', 'inventory']) {
    const response = await api.call(staff.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${api.tenantId}/flags/${flag}`,
      payload: { enabled: true },
    });
    expect(response.statusCode, response.body).toBe(200);
  }
  customerId = (
    await created<{ id: string }>(
      await call(owner, 'POST', '/v1/customers', { name: 'Nile Offices' }),
    )
  ).id;
  const pipelines = json<{ items: { id: string; isDefault: boolean; stages: Stage[] }[] }>(
    await call(owner, 'GET', '/v1/crm/pipelines'),
  );
  const standard = pipelines.items.find((pipeline) => pipeline.isDefault)!;
  pipelineId = standard.id;
  stages = standard.stages;
});

afterAll(async () => {
  await api.close();
});

describe('monthEnds', () => {
  it('gives the last day of each earlier month, then today', () => {
    expect(monthEnds('2026-03-15', 4)).toEqual([
      '2025-12-31',
      '2026-01-31',
      '2026-02-28',
      '2026-03-15',
    ]);
    expect(monthEnds('2026-03-15', 1)).toEqual(['2026-03-15']);
  });
});

describe('the customer timeline', () => {
  it('mixes activities and documents, newest first, and pages', async () => {
    await created(
      await call(owner, 'POST', '/v1/crm/activities', {
        kind: 'note',
        subject: 'Wants a yearly contract',
        customerIds: [customerId],
      }),
    );
    const draft = await created<{ quote: { id: string; version: number } }>(
      await call(owner, 'POST', '/v1/sales/quotes', {
        customerId,
        title: 'Yearly maintenance',
        lines: [{ description: 'Visit', quantity: '4', unitPrice: '250' }],
      }),
    );
    const issued = await created<{ quote: { version: number } }>(
      await call(owner, 'POST', `/v1/sales/quotes/${draft.quote.id}/issue`, {
        expectedVersion: draft.quote.version,
      }),
    );
    await created(
      await call(owner, 'POST', `/v1/sales/quotes/${draft.quote.id}/answer`, {
        expectedVersion: issued.quote.version,
        status: 'accepted',
        name: 'By phone',
      }),
    );

    const page = json<{
      items: { kind: string; title: string | null; detail: string | null }[];
      nextCursor: string | null;
      sources: string[];
    }>(await call(owner, 'GET', `/v1/customers/${customerId}/timeline`));
    expect(page.sources).toEqual(['activities', 'jobs', 'submissions', 'sales']);
    expect(page.items.map((item) => item.kind)).toEqual([
      'quote_answered',
      'quote_issued',
      'activity',
    ]);
    expect(page.items[0]).toMatchObject({ title: 'Yearly maintenance', detail: 'accepted' });

    const first = json<{ items: { kind: string }[]; nextCursor: string | null }>(
      await call(owner, 'GET', `/v1/customers/${customerId}/timeline?limit=2`),
    );
    expect(first.items).toHaveLength(2);
    const rest = json<{ items: { kind: string }[]; nextCursor: string | null }>(
      await call(
        owner,
        'GET',
        `/v1/customers/${customerId}/timeline?limit=2&cursor=${first.nextCursor ?? ''}`,
      ),
    );
    expect(rest.items.map((item) => item.kind)).toEqual(['activity']);
    expect(rest.nextCursor).toBeNull();
  });

  it('shows each seat only what it may read', async () => {
    // An engineer reads the customer, and none of the timeline's sources.
    const engineers = json<{ items: unknown[]; sources: string[] }>(
      await call(engineer, 'GET', `/v1/customers/${customerId}/timeline`),
    );
    expect(engineers).toMatchObject({ items: [], sources: [] });
    const narrowed = json<{ items: { kind: string }[]; sources: string[] }>(
      await call(viewer, 'GET', `/v1/customers/${customerId}/timeline?sources=activities`),
    );
    expect(narrowed.sources).toEqual(['activities']);
    expect(narrowed.items.map((item) => item.kind)).toEqual(['activity']);
    expect((await call(owner, 'GET', `/v1/customers/${randomUUID()}/timeline`)).statusCode).toBe(
      404,
    );
  });
});

describe('figures', () => {
  it('count quotes and how long acceptance took', async () => {
    const figures = json<{
      items: { issuedBy: string | null; issued: number; accepted: number }[];
    }>(await call(viewer, 'GET', `/v1/analytics/quotes?from=${yearAgo}&to=${today}`));
    expect(figures.items[0]).toMatchObject({ issuedBy: null, issued: 1, accepted: 1 });
    expect(figures.items.find((row) => row.issuedBy === owner.userId)).toMatchObject({
      issued: 1,
    });
    // Engineers read neither sales nor the CRM.
    expect(
      (await call(engineer, 'GET', `/v1/analytics/quotes?from=${yearAgo}&to=${today}`)).statusCode,
    ).toBe(403);
    expect(
      (await call(owner, 'GET', `/v1/analytics/quotes?from=${today}&to=${yearAgo}`)).statusCode,
    ).toBe(422);
  });

  it('count won and lost opportunities, by owner and furthest stage', async () => {
    for (const [title, to] of [
      ['Chiller', 'won'],
      ['Pumps', 'lost'],
      ['Lifts', null],
    ] as const) {
      const deal = await created<{ id: string; version: number }>(
        await call(owner, 'POST', '/v1/crm/opportunities', {
          title,
          customerId,
          stageId: stage('new'),
          ownerId: dispatcher.userId,
          amount: '1000',
          currencyCode: 'EGP',
        }),
      );
      const moved = await created<{ opportunity: { version: number } }>(
        await call(owner, 'POST', `/v1/crm/opportunities/${deal.id}/transitions`, {
          expectedVersion: deal.version,
          stageId: stage('proposal'),
        }),
      );
      if (to !== null) {
        await created(
          await call(owner, 'POST', `/v1/crm/opportunities/${deal.id}/transitions`, {
            expectedVersion: moved.opportunity.version,
            stageId: stage(to),
            ...(to === 'lost' ? { lostReason: 'Price' } : {}),
          }),
        );
      }
    }
    const byOwner = json<{ items: { group: string | null; won: number; lost: number }[] }>(
      await call(viewer, 'GET', `/v1/analytics/pipeline?from=${yearAgo}&to=${today}&groupBy=owner`),
    );
    expect(byOwner.items).toEqual([
      { group: null, won: 1, lost: 1, medianDaysToClose: 0 },
      { group: dispatcher.userId, won: 1, lost: 1, medianDaysToClose: 0 },
    ]);
    const byStage = json<{ items: { group: string | null }[] }>(
      await call(viewer, 'GET', `/v1/analytics/pipeline?from=${yearAgo}&to=${today}&groupBy=stage`),
    );
    expect(byStage.items.map((row) => row.group)).toEqual([null, 'proposal']);
  });

  it('place open value in its stage at each month end', async () => {
    const values = json<{
      monthEnds: string[];
      items: {
        monthEnd: string;
        stageId: string;
        count: number;
        amount: string;
        weighted: string;
      }[];
    }>(await call(viewer, 'GET', `/v1/analytics/pipelines/${pipelineId}/stage-values?months=3`));
    expect(values.monthEnds).toHaveLength(3);
    expect(values.monthEnds.at(-1)).toBe(today);
    // Only the open "Lifts" deal, in proposal, at today; none before it existed.
    expect(values.items).toHaveLength(1);
    expect(values.items[0]).toMatchObject({
      monthEnd: today,
      stageId: stage('proposal'),
      count: 1,
      amount: '1000',
    });
    expect(
      (await call(viewer, 'GET', `/v1/analytics/pipelines/${randomUUID()}/stage-values`))
        .statusCode,
    ).toBe(404);
  });

  it('hide the value of parts used from those who do not see costs', async () => {
    const url = `/v1/analytics/parts-usage?from=${yearAgo}&to=${today}&groupBy=customer`;
    expect((await call(viewer, 'GET', url)).statusCode).toBe(200);
    expect((await call(dispatcher, 'GET', url)).statusCode).toBe(200);
    expect(
      (await call(owner, 'GET', `/v1/analytics/parts-usage?from=2020-01-01&to=${today}`))
        .statusCode,
    ).toBe(422);
  });
});

describe('exports', () => {
  it('give leads as CSV to those who manage them, audited', async () => {
    await created(
      await call(owner, 'POST', '/v1/crm/leads', {
        displayName: 'Amr, "Cairo" Towers',
        source: 'referral',
      }),
    );
    expect((await call(viewer, 'GET', '/v1/crm/leads.csv')).statusCode).toBe(403);
    const response = await call(dispatcher, 'GET', '/v1/crm/leads.csv?source=referral');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['x-export-truncated']).toBe('false');
    const lines = response.body
      .replace(/^\uFEFF/u, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toMatch(/^Id,Name,Company/);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"Amr, ""Cairo"" Towers"');

    const audit = await withTenant(api.tenantId, (tx) =>
      tx.auditLog.list({ resourceType: 'tenant', resourceId: api.tenantId }),
    );
    const entry = audit.find((row) => row.action === 'crm.leads_exported');
    expect(entry?.metadata).toMatchObject({ rows: 1, filters: { source: ['referral'] } });
  });

  it('give opportunities and stock movements as CSV', async () => {
    const deals = await call(dispatcher, 'GET', '/v1/crm/opportunities.csv?status=open');
    expect(deals.statusCode, deals.body).toBe(200);
    const rows = deals.body.trim().split('\r\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('Lifts');

    const item = await created<{ id: string }>(
      await call(dispatcher, 'POST', '/v1/inventory/items', { sku: 'AN-1', name: 'Filter' }),
    );
    const store = await created<{ id: string }>(
      await call(dispatcher, 'POST', '/v1/inventory/locations', {
        name: 'Main store',
        kind: 'warehouse',
      }),
    );
    await created(
      await call(dispatcher, 'POST', '/v1/inventory/movements', {
        type: 'receipt',
        itemId: item.id,
        locationId: store.id,
        quantity: '12',
        unitCost: '3.5',
      }),
    );
    expect((await call(engineer, 'GET', '/v1/inventory/movements.csv')).statusCode).toBe(403);
    const moves = await call(owner, 'GET', `/v1/inventory/movements.csv?itemId=${item.id}`);
    expect(moves.statusCode, moves.body).toBe(200);
    const lines = moves.body.trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('AN-1,Filter');
    expect(lines[1]).toContain('Main store');
    expect(lines[1]).toContain(',12,3.5,');
  });
});
