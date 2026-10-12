import {
  leadSourceSchema,
  leadStatusSchema,
  movementKindSchema,
  opportunityStatusSchema,
  toCsv,
} from '@integr8/core';
import { type ExportPage, withTenant } from '@integr8/db';
import { z } from 'zod';
import { notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { crmAudit as audit } from './crm-shared.js';
import { seesCosts } from './inventory.js';
import { many } from './operations.js';
import { companyToday } from './sales-quotes.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * Figures and exports (eighth round; ADR-0012). The figures are read-only and
 * computed on request; amounts in different currencies are never added
 * together. Exports are CSV for owners, admins and the managers of each area,
 * and every one is audited with the filters it used.
 */

const TAGS = ['analytics'];

const period = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((value) => value.from <= value.to, { message: '`from` is after `to`.', path: ['to'] });

/** Refuses a period over two years: figures are for a screen, not a warehouse. */
function checkSpan(from: string, to: string): void {
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days > 731) {
    throw unprocessable('period_too_long', 'A period is at most two years.');
  }
}

/** The last day of each of the `months - 1` months before this one, then today. */
export function monthEnds(today: string, months: number): string[] {
  const [year, month] = today.split('-').map(Number) as [number, number];
  const ends: string[] = [];
  for (let back = months - 1; back >= 1; back -= 1) {
    // Day 0 of the next month is the last day of this one.
    const end = new Date(Date.UTC(year, month - back, 0));
    ends.push(end.toISOString().slice(0, 10));
  }
  ends.push(today);
  return ends;
}

function csvResponse(body: string, filename: string, truncated: boolean) {
  return {
    status: 200 as const,
    body,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-export-truncated': truncated ? 'true' : 'false',
    },
  };
}

const csv = { description: 'CSV.', schema: z.string(), contentType: 'text/csv' } as const;

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

export const quoteFiguresRoute = defineRoute({
  method: 'get',
  path: '/v1/analytics/quotes',
  operationId: 'getQuoteFigures',
  summary: 'Quotes issued in a period: accepted, declined, expired, open, and time to accept',
  description:
    'Overall (`issuedBy` null) and by who issued them. Accepted counts quotes that became an order. Expired is past its date with no answer, as of today in the company’s time zone.',
  tags: TAGS,
  security: 'authenticated',
  anyPermission: ['sales.read', 'crm.read'],
  feature: 'sales',
  params: noSchema,
  query: period,
  body: noSchema,
  responses: {
    200: {
      description: 'The figures.',
      schema: z.object({
        items: z.array(
          z.object({
            issuedBy: z.uuid().nullable(),
            issued: z.number().int(),
            accepted: z.number().int(),
            declined: z.number().int(),
            expired: z.number().int(),
            open: z.number().int(),
            medianDaysToAccept: z.number().int().nullable(),
          }),
        ),
      }),
    },
  },
  handler: async ({ query }, { principal }) => {
    checkSpan(query.from, query.to);
    const items = await withTenant(principal.tenantId, async (tx) =>
      tx.analytics.quoteFigures(query.from, query.to, await companyToday(tx)),
    );
    return { status: 200, body: { items } };
  },
});

export const pipelineFiguresRoute = defineRoute({
  method: 'get',
  path: '/v1/analytics/pipeline',
  operationId: 'getPipelineFigures',
  summary: 'Opportunities closed in a period: won, lost and time to close',
  description:
    'Overall (`group` null) and by the source of the lead they came from, by owner (a member’s id), or by the key of the furthest open stage they reached. `none` groups those without one.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.read',
  feature: 'crm',
  params: noSchema,
  query: period.and(z.object({ groupBy: z.enum(['source', 'owner', 'stage']).default('source') })),
  body: noSchema,
  responses: {
    200: {
      description: 'The figures.',
      schema: z.object({
        groupBy: z.enum(['source', 'owner', 'stage']),
        items: z.array(
          z.object({
            group: z.string().nullable(),
            won: z.number().int(),
            lost: z.number().int(),
            medianDaysToClose: z.number().int().nullable(),
          }),
        ),
      }),
    },
  },
  handler: async ({ query }, { principal }) => {
    checkSpan(query.from, query.to);
    const items = await withTenant(principal.tenantId, (tx) =>
      tx.analytics.pipelineFigures(query.from, query.to, query.groupBy),
    );
    return { status: 200, body: { groupBy: query.groupBy, items } };
  },
});

export const stageValuesRoute = defineRoute({
  method: 'get',
  path: '/v1/analytics/pipelines/:pipelineId/stage-values',
  operationId: 'getStageValues',
  summary: 'Open value in each stage at each month’s end',
  description:
    'Where each open opportunity stood at the end of each month, from its history, with today as the last point. Amounts are what each deal had at that month end, by currency, weighted by the stage’s usual chance. Nothing was kept before `amountsRecordedFrom`: a month end before it counts a deal at the amount it had then, and `estimated` says how many deals were counted so.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.read',
  feature: 'crm',
  params: z.object({ pipelineId: z.uuid() }),
  query: z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }),
  body: noSchema,
  responses: {
    200: {
      description: 'The values.',
      schema: z.object({
        monthEnds: z.array(z.iso.date()),
        items: z.array(
          z.object({
            monthEnd: z.iso.date(),
            stageId: z.uuid(),
            currency: z.string(),
            count: z.number().int(),
            amount: z.string(),
            weighted: z.string(),
            /** Deals counted at the amount they had when the history began. */
            estimated: z.number().int(),
          }),
        ),
        /** When amounts began to be kept (ADR-0013); null when every deal has its full history. */
        amountsRecordedFrom: z.iso.datetime().nullable(),
      }),
    },
    404: { description: 'No such pipeline.' },
  },
  handler: async ({ params, query }, { principal }) => {
    const body = await withTenant(principal.tenantId, async (tx) => {
      if ((await tx.crmPipelines.find(params.pipelineId)) === undefined) {
        throw notFound('No such pipeline.');
      }
      const ends = monthEnds(await companyToday(tx), query.months);
      const from = await tx.analytics.amountsRecordedFrom();
      return {
        monthEnds: ends,
        items: await tx.analytics.stageValues(params.pipelineId, ends),
        amountsRecordedFrom: from === null ? null : from.toISOString(),
      };
    });
    return { status: 200, body };
  },
});

const partsQuery = period.and(
  z.object({ groupBy: z.enum(['engineer', 'customer', 'job_type']).default('engineer') }),
);

export const partsUsageRoute = defineRoute({
  method: 'get',
  path: '/v1/analytics/parts-usage',
  operationId: 'getPartsUsage',
  summary: 'Parts used on jobs in a period, by engineer, customer or job type',
  description:
    'Part lines recorded on jobs, net of returns, and their value at the cost recorded when used; the value only for those who see costs (`inventory.move`). Cancelled and refused lines are left out.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.read',
  feature: 'inventory',
  params: noSchema,
  query: partsQuery,
  body: noSchema,
  responses: {
    200: {
      description: 'The figures.',
      schema: z.object({
        groupBy: z.enum(['engineer', 'customer', 'job_type']),
        items: z.array(
          z.object({
            group: z.string(),
            label: z.string(),
            lines: z.number().int(),
            value: z.string().nullable(),
          }),
        ),
      }),
    },
  },
  handler: async ({ query }, { principal }) => {
    checkSpan(query.from, query.to);
    const items = await withTenant(principal.tenantId, (tx) =>
      tx.analytics.partsUsage(query.from, query.to, query.groupBy),
    );
    const costs = seesCosts(principal);
    return {
      status: 200,
      body: {
        groupBy: query.groupBy,
        items: items.map((item) => ({ ...item, value: costs ? item.value : null })),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** Days are optional on exports: with none, everything. */
const exportDates = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

function filterMetadata(
  query: Record<string, unknown>,
  page: ExportPage<unknown>,
): Record<string, unknown> {
  return {
    filters: Object.fromEntries(
      Object.entries(query).filter(
        ([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0),
      ),
    ),
    rows: page.rows.length,
    truncated: page.truncated,
  };
}

export const partsUsageExportRoute = defineRoute({
  method: 'get',
  path: '/v1/analytics/parts-usage.csv',
  operationId: 'exportPartsUsage',
  summary: 'Parts used on jobs in a period, as CSV',
  description: 'The same figures as `getPartsUsage`. For those who move stock. Audited.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.move',
  feature: 'inventory',
  params: noSchema,
  query: partsQuery,
  body: noSchema,
  responses: { 200: csv },
  handler: async ({ query }, context) => {
    checkSpan(query.from, query.to);
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const items = await tx.analytics.partsUsage(query.from, query.to, query.groupBy);
      await audit(tx, context, 'analytics.parts_usage_exported', 'tenant', principal.tenantId, {
        filters: query,
        rows: items.length,
      });
      return toCsv([
        ['Group', 'Name', 'Lines', 'Value'],
        ...items.map((item) => [item.group, item.label, item.lines, item.value]),
      ]);
    });
    return csvResponse(body, `parts-usage-${query.from}-${query.to}.csv`, false);
  },
});

export const leadsExportRoute = defineRoute({
  method: 'get',
  path: '/v1/crm/leads.csv',
  operationId: 'exportLeads',
  summary: 'Leads, as CSV',
  description: `Oldest first, filtered by status, source and the day they were added. At most 50,000 rows; \`x-export-truncated\` says when more matched. For those who manage leads. Audited.`,
  tags: ['crm'],
  security: 'authenticated',
  permission: 'crm.lead.manage',
  feature: 'crm',
  params: noSchema,
  query: exportDates.extend({
    status: many(leadStatusSchema),
    source: many(leadSourceSchema),
    includeArchived: z.enum(['true', 'false']).optional(),
  }),
  body: noSchema,
  responses: { 200: csv },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const result = await withTenant(principal.tenantId, async (tx) => {
      const page = await tx.analytics.leadRows({
        from: query.from,
        to: query.to,
        statuses: query.status,
        sources: query.source,
        includeArchived: query.includeArchived === 'true',
      });
      await audit(tx, context, 'crm.leads_exported', 'tenant', principal.tenantId, {
        ...filterMetadata(query, page),
      });
      return page;
    });
    const rows: (string | number | null)[][] = [
      [
        'Id',
        'Name',
        'Company',
        'Email',
        'Phone',
        'Source',
        'Status',
        'Assigned to',
        'Estimated value',
        'Currency',
        'Added',
        'Converted',
        'Archived',
      ],
      ...result.rows.map((row) => [
        row.id,
        row.name,
        row.company,
        row.email,
        row.phone,
        row.source,
        row.status,
        row.assignedTo,
        row.estimatedValue,
        row.currencyCode,
        iso(row.createdAt),
        isoOrNull(row.convertedAt),
        isoOrNull(row.archivedAt),
      ]),
    ];
    return csvResponse(toCsv(rows), 'leads.csv', result.truncated);
  },
});

export const opportunitiesExportRoute = defineRoute({
  method: 'get',
  path: '/v1/crm/opportunities.csv',
  operationId: 'exportOpportunities',
  summary: 'Opportunities, as CSV',
  description: `Oldest first, filtered by pipeline, status and the day they were added. At most 50,000 rows; \`x-export-truncated\` says when more matched. For those who manage opportunities. Audited.`,
  tags: ['crm'],
  security: 'authenticated',
  permission: 'crm.opportunity.manage',
  feature: 'crm',
  params: noSchema,
  query: exportDates.extend({
    pipelineId: z.uuid().optional(),
    status: many(opportunityStatusSchema),
    includeArchived: z.enum(['true', 'false']).optional(),
  }),
  body: noSchema,
  responses: { 200: csv },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const result = await withTenant(principal.tenantId, async (tx) => {
      const page = await tx.analytics.opportunityRows({
        from: query.from,
        to: query.to,
        statuses: query.status,
        includeArchived: query.includeArchived === 'true',
        ...(query.pipelineId === undefined ? {} : { pipelineId: query.pipelineId }),
      });
      await audit(tx, context, 'crm.opportunities_exported', 'tenant', principal.tenantId, {
        ...filterMetadata(query, page),
      });
      return page;
    });
    const rows: (string | number | null)[][] = [
      [
        'Id',
        'Title',
        'Customer',
        'Pipeline',
        'Stage key',
        'Stage',
        'Status',
        'Owner',
        'Amount',
        'Currency',
        'Chance (%)',
        'Expected close',
        'Lost reason',
        'Added',
        'Closed',
      ],
      ...result.rows.map((row) => [
        row.id,
        row.title,
        row.customer,
        row.pipeline,
        row.stageKey,
        row.stage,
        row.status,
        row.owner,
        row.amount,
        row.currencyCode,
        // Basis points to a percentage, as text: 3500 is 35, 1250 is 12.5.
        (row.probabilityBp / 100).toString(),
        row.expectedCloseDate,
        row.lostReason,
        iso(row.createdAt),
        isoOrNull(row.closedAt),
      ]),
    ];
    return csvResponse(toCsv(rows), 'opportunities.csv', result.truncated);
  },
});

export const movementsExportRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/movements.csv',
  operationId: 'exportStockMovements',
  summary: 'Stock movements, as CSV',
  description: `Oldest first, filtered by item, location, kind and day. At most 50,000 rows; \`x-export-truncated\` says when more matched. For those who move stock. Audited.`,
  tags: ['inventory'],
  security: 'authenticated',
  permission: 'inventory.move',
  feature: 'inventory',
  params: noSchema,
  query: exportDates.extend({
    itemId: z.uuid().optional(),
    locationId: z.uuid().optional(),
    kind: many(movementKindSchema),
  }),
  body: noSchema,
  responses: { 200: csv },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const result = await withTenant(principal.tenantId, async (tx) => {
      const page = await tx.analytics.movementRows({
        from: query.from,
        to: query.to,
        kinds: query.kind,
        ...(query.itemId === undefined ? {} : { itemId: query.itemId }),
        ...(query.locationId === undefined ? {} : { locationId: query.locationId }),
      });
      await audit(tx, context, 'inventory.movements_exported', 'tenant', principal.tenantId, {
        ...filterMetadata(query, page),
      });
      return page;
    });
    const rows: (string | number | null)[][] = [
      [
        'Id',
        'When',
        'SKU',
        'Item',
        'Unit',
        'Location',
        'Kind',
        'Quantity',
        'Unit cost',
        'Reason',
        'By',
      ],
      ...result.rows.map((row) => [
        row.id,
        iso(row.occurredAt),
        row.sku,
        row.item,
        row.unit,
        row.location,
        row.kind,
        row.quantity,
        row.unitCost,
        row.reason,
        row.actor,
      ]),
    ];
    return csvResponse(toCsv(rows), 'stock-movements.csv', result.truncated);
  },
});

export const analyticsRoutes = [
  quoteFiguresRoute,
  pipelineFiguresRoute,
  stageValuesRoute,
  partsUsageRoute,
  partsUsageExportRoute,
  leadsExportRoute,
  opportunitiesExportRoute,
  movementsExportRoute,
];
