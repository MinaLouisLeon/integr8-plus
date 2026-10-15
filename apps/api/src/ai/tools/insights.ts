import { holds, WORK_ORDER_STATES } from '@integr8/core';
import { z } from 'zod';
import {
  type AnyAiTool,
  boundedLimit,
  dayString,
  defineTool,
  type ToolContext,
} from './registry.js';

/**
 * Level 2: read-only questions about the company (docs/ai §8.2; ADR-0001).
 *
 * Each tool answers one kind of question over the same repositories the
 * screens use, with the same visibility rules: an engineer's jobs are the
 * ones assigned to them, an engineer's assets are at the sites they work,
 * expenses are one's own. Results are counts and short rows, never a dump,
 * and amounts stay decimal strings. An empty answer is the same whether
 * nothing matched or nothing was allowed.
 */

const OPEN_STATES = WORK_ORDER_STATES.filter(
  (state) => state !== 'complete' && state !== 'reviewed' && state !== 'cancelled',
);

function day(context: ToolContext): string {
  return context.now.toISOString().slice(0, 10);
}

function readAll(context: ToolContext): boolean {
  return holds(context.principal, 'work_order.read_all');
}

// ---------------------------------------------------------------------------
// Work orders
// ---------------------------------------------------------------------------

const myWorkOrders = defineTool({
  key: 'get_my_work_orders',
  description:
    "The signed-in person's own jobs: open ones by default, optionally only those due today or overdue. Returns reference, title, state, priority and due time.",
  minLevel: 'insights',
  permission: ['work_order.progress', 'work_order.read_all'],
  dataClass: 'company_operational',
  inputSchema: z.object({
    scope: z.enum(['open', 'today', 'overdue']).default('open'),
    limit: boundedLimit(20),
  }),
  maxRows: 20,
  async execute(context, input) {
    const today = day(context);
    const page = await context.tx.workOrders.list({
      assigneeId: context.principal.userId,
      states: OPEN_STATES,
      ...(input.scope === 'today'
        ? { dueFrom: new Date(`${today}T00:00:00Z`), dueBefore: new Date(`${today}T23:59:59Z`) }
        : input.scope === 'overdue'
          ? { overdue: true }
          : {}),
      limit: input.limit,
    });
    return {
      count: page.items.length,
      more: page.next !== undefined,
      jobs: page.items.map((job) => ({
        reference: `WO-${String(job.reference).padStart(6, '0')}`,
        title: job.title,
        state: job.state,
        priority: job.priority,
        dueBy: job.dueBy?.toISOString() ?? null,
      })),
    };
  },
  summarise(output, locale) {
    return locale === 'ar'
      ? `${String(output.count)} مهمة`
      : `${String(output.count)} job${output.count === 1 ? '' : 's'}`;
  },
});

const workOrderSummary = defineTool({
  key: 'get_work_order_summary',
  description:
    'How many jobs are in each state (scheduled, dispatched, travelling, on site, in progress, awaiting parts, complete, reviewed, cancelled), optionally for one customer. People without company-wide access see only their own jobs.',
  minLevel: 'insights',
  permission: ['work_order.read_all', 'work_order.progress'],
  dataClass: 'company_operational',
  inputSchema: z.object({ customerId: z.uuid().optional() }),
  maxRows: 10,
  async execute(context, input) {
    const counts = await context.tx.workOrders.countByState({
      ...(readAll(context) ? {} : { assigneeId: context.principal.userId }),
      ...(input.customerId === undefined ? {} : { customerId: input.customerId }),
    });
    const byState = Object.fromEntries(
      WORK_ORDER_STATES.map((state) => [state, counts[state] ?? 0]),
    ) as Record<(typeof WORK_ORDER_STATES)[number], number>;
    const open = OPEN_STATES.reduce((sum, state) => sum + byState[state], 0);
    return { scope: readAll(context) ? 'company' : 'mine', open, byState };
  },
  summarise(output, locale) {
    return locale === 'ar'
      ? `${String(output.open)} مهمة مفتوحة`
      : `${String(output.open)} open job${output.open === 1 ? '' : 's'}`;
  },
});

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

const customerSummary = defineTool({
  key: 'get_customer_summary',
  description:
    'How many customers the company has by status (active, on hold, closed), and a few matching a search by name.',
  minLevel: 'insights',
  permission: 'customer.read',
  dataClass: 'company_operational',
  inputSchema: z.object({ search: z.string().max(100).optional(), limit: boundedLimit(10) }),
  maxRows: 10,
  async execute(context, input) {
    const counts = { active: 0, on_hold: 0, closed: 0 };
    for (const status of ['active', 'on_hold', 'closed'] as const) {
      const page = await context.tx.customers.list({ statuses: [status], limit: 100 });
      counts[status] = page.items.length + (page.next === undefined ? 0 : 100);
    }
    const matches =
      input.search === undefined || input.search.trim() === ''
        ? []
        : (
            await context.tx.customers.list({ text: input.search.trim(), limit: input.limit })
          ).items.map((customer) => ({
            name: customer.name,
            status: customer.status,
            city: customer.address.city ?? null,
          }));
    return { counts, matches };
  },
  summarise(output, locale) {
    return locale === 'ar'
      ? `${String(output.counts.active)} عميل نشط`
      : `${String(output.counts.active)} active customer${output.counts.active === 1 ? '' : 's'}`;
  },
});

// ---------------------------------------------------------------------------
// CRM
// ---------------------------------------------------------------------------

const pipelineSummary = defineTool({
  key: 'get_crm_pipeline_summary',
  description:
    'Open opportunities by pipeline stage: how many, and their total amount per currency. Uses the default pipeline unless one is named.',
  minLevel: 'insights',
  permission: 'crm.read',
  feature: 'crm',
  dataClass: 'company_operational',
  inputSchema: z.object({ pipelineName: z.string().max(100).optional() }),
  maxRows: 20,
  async execute(context, input) {
    const pipelines = await context.tx.crmPipelines.list();
    const wanted = input.pipelineName?.trim().toLowerCase();
    const pipeline =
      (wanted === undefined
        ? pipelines.find((candidate) => candidate.isDefault)
        : pipelines.find((candidate) => candidate.name.toLowerCase() === wanted)) ?? pipelines[0];
    if (pipeline === undefined) {
      return { pipeline: null, stages: [] };
    }
    const open = await context.tx.crmOpportunities.list({ statuses: ['open'], limit: 500 });
    const stages = pipeline.stages
      .filter((stage) => stage.archivedAt === null)
      .map((stage) => {
        const inStage = open.items.filter((opportunity) => opportunity.stageId === stage.id);
        const totals = new Map<string, bigint>();
        for (const opportunity of inStage) {
          if (opportunity.amount === null) {
            continue;
          }
          // Decimal strings summed in minor units: never a JavaScript float.
          const [whole = '0', fraction = ''] = opportunity.amount.split('.');
          const minor = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
          totals.set(
            opportunity.currencyCode,
            (totals.get(opportunity.currencyCode) ?? 0n) + minor,
          );
        }
        return {
          stage: stage.label,
          count: inStage.length,
          totals: [...totals.entries()].map(([currency, minor]) => ({
            currency,
            amount: `${String(minor / 100n)}.${String(minor % 100n).padStart(2, '0')}`,
          })),
        };
      });
    return { pipeline: pipeline.name, stages };
  },
  summarise(output, locale) {
    const count = output.stages.reduce((sum, stage) => sum + stage.count, 0);
    return locale === 'ar'
      ? `${String(count)} فرصة مفتوحة`
      : `${String(count)} open opportunit${count === 1 ? 'y' : 'ies'}`;
  },
});

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

const invoiceSummary = defineTool({
  key: 'get_invoice_summary',
  description:
    'Issued invoices still owing: how many, how much per currency, and how many are overdue. Optionally for one customer. No bank details or internal notes.',
  minLevel: 'insights',
  permission: 'finance.read',
  feature: 'finance',
  dataClass: 'company_financial',
  inputSchema: z.object({ customerId: z.uuid().optional(), limit: boundedLimit(10) }),
  maxRows: 10,
  async execute(context, input) {
    const page = await context.tx.financeInvoices.listInvoices({
      statuses: ['issued'],
      ...(input.customerId === undefined ? {} : { customerId: input.customerId }),
      limit: 100,
    });
    const amounts = await context.tx.financeInvoices.invoiceAmounts(page.items.map((i) => i.id));
    const today = day(context);
    const owing = new Map<string, bigint>();
    let unpaid = 0;
    let overdue = 0;
    const oldest: {
      reference: string;
      dueDate: string | null;
      balance: string;
      currency: string;
    }[] = [];
    for (const invoice of page.items) {
      const amount = amounts.get(invoice.id);
      if (amount === undefined) {
        continue;
      }
      const [whole = '0', fraction = ''] = amount.balance.split('.');
      const minor = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
      if (minor <= 0n) {
        continue;
      }
      unpaid += 1;
      owing.set(invoice.currencyCode, (owing.get(invoice.currencyCode) ?? 0n) + minor);
      if (invoice.dueDate !== null && invoice.dueDate < today) {
        overdue += 1;
      }
      if (oldest.length < input.limit) {
        oldest.push({
          reference:
            invoice.reference === null ? '' : `INV-${String(invoice.reference).padStart(6, '0')}`,
          dueDate: invoice.dueDate,
          balance: amount.balance,
          currency: invoice.currencyCode,
        });
      }
    }
    return {
      unpaid,
      overdue,
      owing: [...owing.entries()].map(([currency, minor]) => ({
        currency,
        amount: `${String(minor / 100n)}.${String(minor % 100n).padStart(2, '0')}`,
      })),
      oldest,
    };
  },
  summarise(output, locale) {
    return locale === 'ar'
      ? `${String(output.unpaid)} فاتورة غير مسددة، منها ${String(output.overdue)} متأخرة`
      : `${String(output.unpaid)} unpaid invoice${output.unpaid === 1 ? '' : 's'}, ${String(output.overdue)} overdue`;
  },
});

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

const inventorySummary = defineTool({
  key: 'get_inventory_summary',
  description:
    'Items below their reorder level, with how much is on hand against the minimum, by location. Stock levels only; no costs.',
  minLevel: 'insights',
  permission: 'inventory.read',
  feature: 'inventory',
  dataClass: 'company_operational',
  inputSchema: z.object({ limit: boundedLimit(20) }),
  maxRows: 20,
  async execute(context, input) {
    const low = await context.tx.inventoryStock.balances({
      belowMinimum: true,
      limit: input.limit,
    });
    const items = await context.tx.inventoryCatalogue.findItems([
      ...new Set(low.map((balance) => balance.itemId)),
    ]);
    const locations = await context.tx.inventoryStock.listLocations({ includeArchived: true });
    return {
      lowStock: low.map((balance) => ({
        item: items.find((item) => item.id === balance.itemId)?.name ?? '',
        sku: items.find((item) => item.id === balance.itemId)?.sku ?? '',
        location: locations.find((location) => location.id === balance.locationId)?.name ?? '',
        onHand: balance.onHand,
        minimum: balance.minimum,
      })),
    };
  },
  summarise(output, locale) {
    const count = output.lowStock.length;
    return locale === 'ar'
      ? `${String(count)} صنف تحت حد إعادة الطلب`
      : `${String(count)} item${count === 1 ? '' : 's'} below reorder level`;
  },
});

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

const assetServiceSummary = defineTool({
  key: 'get_asset_service_summary',
  description:
    'Assets whose warranty ends within the next days (default 30), and the count of assets by status. Engineers see assets at the sites they work.',
  minLevel: 'insights',
  permission: 'asset.read',
  feature: 'assets',
  dataClass: 'company_operational',
  inputSchema: z.object({
    withinDays: z.number().int().min(1).max(365).default(30),
    limit: boundedLimit(20),
  }),
  maxRows: 20,
  async execute(context, input) {
    const today = day(context);
    const until = new Date(context.now.getTime() + input.withinDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const everyone = readAll(context);
    const scope = everyone ? {} : { visibleTo: context.principal.userId };
    const expiring = await context.tx.assets.list({
      ...scope,
      statuses: ['active'],
      warrantyEndsFrom: today,
      warrantyEndsBy: until,
      limit: input.limit,
    });
    const active = await context.tx.assets.list({ ...scope, statuses: ['active'], limit: 100 });
    const retired = await context.tx.assets.list({
      ...scope,
      statuses: ['retired', 'out_of_service'],
      limit: 100,
    });
    return {
      inService: active.items.length + (active.next === undefined ? 0 : 100),
      retired: retired.items.length + (retired.next === undefined ? 0 : 100),
      warrantyEndingSoon: expiring.items.map((asset) => ({
        reference: `AS-${String(asset.reference).padStart(6, '0')}`,
        name: asset.name,
        warrantyExpiresOn: asset.warrantyExpiresOn,
      })),
    };
  },
  summarise(output, locale) {
    const count = output.warrantyEndingSoon.length;
    return locale === 'ar'
      ? `${String(count)} أصل ينتهي ضمانه قريبًا`
      : `${String(count)} asset${count === 1 ? '' : 's'} with warranty ending soon`;
  },
});

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

const myExpenseStatus = defineTool({
  key: 'get_my_expense_status',
  description:
    "The signed-in person's own expense claims and where each stands (submitted, approved, rejected, paid). Never anybody else's.",
  minLevel: 'insights',
  permission: 'expense.submit',
  feature: 'hr',
  dataClass: 'company_operational',
  inputSchema: z.object({ limit: boundedLimit(10) }),
  maxRows: 10,
  async execute(context, input) {
    const page = await context.tx.hrExpenses.list({
      claimantId: context.principal.userId,
      limit: input.limit,
    });
    return {
      claims: page.items.map((claim) => ({
        reference: `EXP-${String(claim.reference).padStart(6, '0')}`,
        spentOn: claim.spentOn,
        amount: claim.amount,
        currency: claim.currency,
        status: claim.status,
        description: claim.description.slice(0, 80),
      })),
    };
  },
  summarise(output, locale) {
    const count = output.claims.length;
    return locale === 'ar'
      ? `${String(count)} مطالبة مصروفات`
      : `${String(count)} expense claim${count === 1 ? '' : 's'}`;
  },
});

export const INSIGHT_TOOLS: readonly AnyAiTool[] = [
  myWorkOrders,
  workOrderSummary,
  customerSummary,
  pipelineSummary,
  invoiceSummary,
  inventorySummary,
  assetServiceSummary,
  myExpenseStatus,
];

export { dayString };
