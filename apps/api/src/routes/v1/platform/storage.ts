import {
  MONTH_PATTERN,
  monthBounds,
  monthlyOverage,
  toPlatformUserId,
  toTenantId,
  utcMonthOf,
} from '@integr8/core';
import {
  getPlatformDataSource,
  OVERAGE_POLICIES,
  type OverageSample,
  type Reconciliation,
  type StorageSample,
  TENANT_PLANS,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import { notFound } from '../../../http/errors.js';
import { defineRoute, noSchema } from '../../../http/routes.js';
import { forgetAllowances } from '../../../media/quota.js';
import { iso, isoOrNull } from '../schemas.js';
import { recordPlatformAction } from './audit.js';
import { platformListSchema } from './schemas.js';

/**
 * Storage, seen from the platform (P16).
 *
 * The question this answers is "what does each company cost, and is the number
 * true". Two numbers exist and both matter: the ledger is what we bill from,
 * because it is attributable to a company, a file and a job; Cloudflare is what
 * we audit against. When they disagree the ledger is wrong until proven
 * otherwise, and these screens are how somebody finds out.
 */

const sampleSchema = z.object({
  day: z.string(),
  bytes: z.number().int(),
  objects: z.number().int(),
  byCategory: z.record(z.string(), z.number()),
  allowanceBytes: z.number().int().nullable(),
  overageBytes: z.number().int().nullable(),
  classAOperations: z.number().int().nullable(),
  classBOperations: z.number().int().nullable(),
});

const reconciliationSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  ranAt: z.iso.datetime(),
  ledgerBytes: z.number().int(),
  ledgerObjects: z.number().int(),
  cloudflareBytes: z.number().int().nullable(),
  cloudflareObjects: z.number().int().nullable(),
  cloudflareSampledAt: z.iso.datetime().nullable(),
  /** Signed: positive means the ledger claims more than Cloudflare reports. */
  driftBytes: z.number().int().nullable(),
  status: z.enum(['matched', 'drifted', 'unavailable']),
  note: z.string().nullable(),
});

/**
 * A company over its storage allowance, for the staff dashboard's "Over
 * allowance" list and the invoice (Low 2). Plans with overage `allow` keep
 * taking uploads past the line; this is what Integr8 bills for it.
 */
const overAllowanceSchema = z.object({
  tenantId: z.uuid(),
  name: z.string(),
  slug: z.string(),
  plan: z.enum(TENANT_PLANS),
  /** The latest sample: what the company stores, and what its plan allowed that day. */
  usedBytes: z.number().int(),
  allowanceBytes: z.number().int().nullable(),
  /** How far over the company is on the latest sample; 0 when it is back under. */
  overNowBytes: z.number().int(),
  /** Days in the month with a sample over the allowance. */
  daysOver: z.number().int(),
  /** The most it was over on any day of the month. */
  peakBytes: z.number().int(),
  /**
   * The month's daily overage, summed and divided by the days in the month:
   * byte-months, so a thousand million of them is the GB-month to invoice.
   * Accrues as the month goes on; the figure on its last day is the bill.
   */
  averageBytes: z.number().int(),
});

const allowanceSchema = z.object({
  plan: z.enum(TENANT_PLANS),
  storageBytes: z.number().int().nullable(),
  retentionDays: z.number().int().nullable(),
  overage: z.enum(OVERAGE_POLICIES),
  warnAtPercent: z.number().int(),
  /** What the plan costs and allows (P17). Null is uncapped, or unpriced. */
  seats: z.number().int().nullable(),
  submissionsPerMonth: z.number().int().nullable(),
  priceCents: z.number().int().nullable(),
  currency: z.string().nullable(),
  /**
   * The provider's own price identifiers.
   *
   * Held rather than derived, because the mapping from one of our plans to a
   * price at a provider is a decision somebody makes in the provider's
   * dashboard and then records here. A plan with neither cannot be bought.
   */
  providerPriceMonthly: z.string().nullable(),
  providerPriceYearly: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});

export const companyStorageRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/companies/:tenantId/storage',
  operationId: 'getCompanyStorage',
  summary: 'What this company is using, and whether the number is true',
  description:
    'The live ledger with its breakdown, the last ninety days of daily samples, and the most recent reconciliations against Cloudflare.',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ tenantId: z.uuid() }),
  query: z.object({ days: z.coerce.number().int().min(1).max(365).default(90) }),
  body: noSchema,
  responses: {
    200: {
      description: 'Storage for one company.',
      schema: z.object({
        usage: z.object({
          categories: z.array(
            z.object({
              category: z.string(),
              bytes: z.number().int(),
              objects: z.number().int(),
            }),
          ),
          totalBytes: z.number().int(),
          totalObjects: z.number().int(),
        }),
        allowanceBytes: z.number().int().nullable(),
        trend: z.array(sampleSchema),
        reconciliations: z.array(reconciliationSchema),
      }),
    },
    404: { description: 'No such company.' },
  },
  handler: async ({ params, query }, context) => {
    void context;
    const platform = getPlatformDataSource();
    const tenant = await platform.tenants.findById(params.tenantId);
    if (tenant === undefined) {
      throw notFound(`No company with id ${params.tenantId}`);
    }

    // The live figure comes from the company's own connection, so what the
    // dashboard shows is what the company's own screen shows. A second way of
    // computing it would be a second thing to be wrong.
    const usage = await withTenant(toTenantId(tenant.id), (tx) => tx.files.usage());
    const allowance = await platform.metering.allowanceFor(tenant.plan);

    return {
      status: 200,
      body: {
        usage,
        allowanceBytes: allowance?.storageBytes ?? null,
        trend: (await platform.metering.samplesFor(tenant.id, query.days)).map(toSampleBody),
        reconciliations: (await platform.metering.reconciliationsFor(tenant.id)).map(
          toReconciliationBody,
        ),
      },
    };
  },
});

export const storageOverviewRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/storage',
  operationId: 'getStorageOverview',
  summary: 'Platform-wide storage, and what it is likely to cost',
  description:
    'The latest sample for every company, the totals, and the projected monthly Cloudflare bill from them. Also the companies whose ledger last disagreed with Cloudflare, and when each nightly task last ran.',
  tags: ['platform'],
  security: 'platform',
  params: noSchema,
  query: z.object({
    /** The month the "Over allowance" list covers, `YYYY-MM`. This month (UTC) when absent. */
    month: z.string().regex(MONTH_PATTERN).optional(),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'Platform-wide storage.',
      schema: z.object({
        totalBytes: z.number().int(),
        totalObjects: z.number().int(),
        companies: z.number().int(),
        /** What a month at this size and rate would cost, in US dollars. */
        projectedMonthlyCost: z.object({
          storage: z.number(),
          classA: z.number(),
          classB: z.number(),
          total: z.number(),
        }),
        drifted: z.array(reconciliationSchema),
        /**
         * Companies over their allowance in the month asked for (this month by
         * default): every company with a day over in it, and, for this month,
         * any company over on its latest sample. Most over first.
         */
        overAllowance: z.object({
          month: z.string(),
          daysInMonth: z.number().int(),
          companies: z.array(overAllowanceSchema),
        }),
        tasks: z.array(
          z.object({
            task: z.string(),
            lastRunAt: z.iso.datetime(),
            lastFinishedAt: z.iso.datetime().nullable(),
            lastError: z.string().nullable(),
          }),
        ),
      }),
    },
  },
  handler: async ({ query }, context) => {
    void context;
    const platform = getPlatformDataSource();
    const metering = platform.metering;
    const samples = await metering.latestSamples();

    const totalBytes = samples.reduce((sum, sample) => sum + sample.bytes, 0);
    const totalObjects = samples.reduce((sum, sample) => sum + sample.objects, 0);
    const classA = samples.reduce((sum, sample) => sum + (sample.classAOperations ?? 0), 0);
    const classB = samples.reduce((sum, sample) => sum + (sample.classBOperations ?? 0), 0);

    const drifted = (await metering.latestReconciliations()).filter(
      (row) => row.status === 'drifted',
    );

    return {
      status: 200,
      body: {
        totalBytes,
        totalObjects,
        companies: samples.length,
        projectedMonthlyCost: projectCost({ bytes: totalBytes, classA, classB }),
        drifted: drifted.map(toReconciliationBody),
        overAllowance: await overAllowance(query.month, samples),
        tasks: (await metering.taskRuns()).map((run) => ({
          task: run.task,
          lastRunAt: iso(run.lastRunAt),
          lastFinishedAt: isoOrNull(run.lastFinishedAt),
          lastError: run.lastError,
        })),
      },
    };
  },
});

export const listAllowancesRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/plans',
  operationId: 'listPlanAllowances',
  summary: 'What each plan allows',
  tags: ['platform'],
  security: 'platform',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The plans.', schema: platformListSchema(allowanceSchema) },
  },
  handler: async (_input, context) => {
    void context;
    const allowances = await getPlatformDataSource().metering.allowances();
    return {
      status: 200,
      body: { items: allowances.map((row) => ({ ...row, updatedAt: iso(row.updatedAt) })) },
    };
  },
});

export const setAllowanceRoute = defineRoute({
  method: 'patch',
  path: '/v1/platform/plans/:plan',
  operationId: 'setPlanAllowance',
  summary: 'Change what a plan allows',
  description:
    'Only what is sent is changed, so raising one number does not reset a retention window somebody agreed with a customer. Takes effect within a minute everywhere, and at once on the instance that served this request.',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ plan: z.enum(TENANT_PLANS) }),
  query: noSchema,
  body: z.object({
    /** Null is uncapped. */
    storageBytes: z.number().int().positive().nullable().optional(),
    /** Null keeps media for ever. */
    retentionDays: z.number().int().min(1).max(36_500).nullable().optional(),
    overage: z.enum(OVERAGE_POLICIES).optional(),
    warnAtPercent: z.number().int().min(1).max(100).optional(),
    /** Null is uncapped. Zero is refused by the database: a plan nobody can use is not a plan. */
    seats: z.number().int().positive().nullable().optional(),
    submissionsPerMonth: z.number().int().positive().nullable().optional(),
    /**
     * The list price, in minor units, with its currency. Neither is what the
     * customer is charged — the provider's price is — but it is what the
     * pricing page shows, and the two disagreeing is a support ticket.
     */
    priceCents: z.number().int().min(0).nullable().optional(),
    currency: z.string().length(3).nullable().optional(),
    providerPriceMonthly: z.string().max(255).nullable().optional(),
    providerPriceYearly: z.string().max(255).nullable().optional(),
  }),
  responses: {
    200: { description: 'Changed.', schema: allowanceSchema },
    404: { description: 'No such plan.' },
  },
  handler: async ({ params, body }, context) => {
    const allowance = await getPlatformDataSource().metering.setAllowance(params.plan, {
      ...body,
      updatedBy: toPlatformUserId(context.platform.platformUserId),
    });
    if (allowance === undefined) {
      throw notFound(`No allowance for plan ${params.plan}`);
    }

    // This instance stops using the cached rule at once; the others age out
    // within the minute their cache allows.
    forgetAllowances();

    await recordPlatformAction(context, {
      action: 'plan.allowance_changed',
      targetKind: 'plan',
      targetId: params.plan,
      metadata: { ...body },
    });

    return { status: 200, body: { ...allowance, updatedAt: iso(allowance.updatedAt) } };
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Cloudflare's published R2 rates, in US dollars.
 *
 * Here rather than in configuration because a wrong number here produces a
 * wrong estimate on a screen, not a wrong bill — and a rate that changes should
 * be changed in a diff somebody reviews. The estimate is deliberately labelled
 * projected: it ignores the free tier, egress (R2 has none) and any negotiated
 * rate.
 */
const RATE_STORAGE_PER_GB_MONTH = 0.015;
const RATE_CLASS_A_PER_MILLION = 4.5;
const RATE_CLASS_B_PER_MILLION = 0.36;
const DAYS_PER_MONTH = 30;

export function projectCost(input: { bytes: number; classA: number; classB: number }) {
  const gigabytes = input.bytes / 1_000_000_000;
  const storage = gigabytes * RATE_STORAGE_PER_GB_MONTH;
  // The operation counts are one day's, so a month is thirty of them.
  const classA = (input.classA / 1_000_000) * RATE_CLASS_A_PER_MILLION * DAYS_PER_MONTH;
  const classB = (input.classB / 1_000_000) * RATE_CLASS_B_PER_MILLION * DAYS_PER_MONTH;

  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    storage: round(storage),
    classA: round(classA),
    classB: round(classB),
    total: round(storage + classA + classB),
  };
}

/**
 * The "Over allowance" list for a month: each company's days over, added up the
 * way it is invoiced ({@link monthlyOverage}), beside where it stands now.
 */
async function overAllowance(
  requested: string | undefined,
  latest: readonly StorageSample[],
): Promise<{
  month: string;
  daysInMonth: number;
  companies: z.infer<typeof overAllowanceSchema>[];
}> {
  const thisMonth = utcMonthOf(new Date());
  const month = requested ?? thisMonth;
  const { first, last, days } = monthBounds(month);
  const platform = getPlatformDataSource();

  const byTenant = new Map<string, OverageSample[]>();
  for (const day of await platform.metering.overageBetween(first, last)) {
    byTenant.set(day.tenantId, [...(byTenant.get(day.tenantId) ?? []), day]);
  }
  const latestByTenant = new Map(latest.map((sample) => [sample.tenantId, sample]));

  const companies: z.infer<typeof overAllowanceSchema>[] = [];
  for (const [tenantId, rows] of byTenant) {
    const company = rows[0];
    if (company === undefined) {
      continue;
    }
    const now = latestByTenant.get(tenantId);
    const total = monthlyOverage(
      rows.map((row) => ({ day: row.sampledOn, overageBytes: row.overageBytes })),
      month,
    );
    companies.push({
      tenantId,
      name: company.tenantName,
      slug: company.tenantSlug,
      plan: company.plan,
      usedBytes: now?.bytes ?? rows.at(-1)?.bytes ?? 0,
      allowanceBytes: now?.allowanceBytes ?? company.allowanceBytes,
      overNowBytes: now?.overageBytes ?? 0,
      daysOver: total.daysOver,
      peakBytes: total.peakBytes,
      averageBytes: total.averageBytes,
    });
  }

  // On the first of the month, before the sampler has run, a company over
  // yesterday has no day in this month yet; it is still over, so it is listed.
  if (month === thisMonth) {
    for (const sample of latest) {
      if ((sample.overageBytes ?? 0) <= 0 || byTenant.has(sample.tenantId)) {
        continue;
      }
      const tenant = await platform.tenants.findById(sample.tenantId);
      if (tenant === undefined) {
        continue;
      }
      companies.push({
        tenantId: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.plan,
        usedBytes: sample.bytes,
        allowanceBytes: sample.allowanceBytes,
        overNowBytes: sample.overageBytes ?? 0,
        daysOver: 0,
        peakBytes: 0,
        averageBytes: 0,
      });
    }
  }

  companies.sort((a, b) => b.averageBytes - a.averageBytes || b.overNowBytes - a.overNowBytes);
  return { month, daysInMonth: days, companies };
}

function toSampleBody(sample: StorageSample): z.infer<typeof sampleSchema> {
  return {
    day: sample.sampledOn,
    bytes: sample.bytes,
    objects: sample.objects,
    byCategory: sample.byCategory,
    allowanceBytes: sample.allowanceBytes,
    overageBytes: sample.overageBytes,
    classAOperations: sample.classAOperations,
    classBOperations: sample.classBOperations,
  };
}

function toReconciliationBody(row: Reconciliation): z.infer<typeof reconciliationSchema> {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ranAt: iso(row.ranAt),
    ledgerBytes: row.ledgerBytes,
    ledgerObjects: row.ledgerObjects,
    cloudflareBytes: row.cloudflareBytes,
    cloudflareObjects: row.cloudflareObjects,
    cloudflareSampledAt: isoOrNull(row.cloudflareSampledAt),
    driftBytes: row.driftBytes,
    status: row.status,
    note: row.note,
  };
}

export const platformStorageRoutes = [
  storageOverviewRoute,
  companyStorageRoute,
  listAllowancesRoute,
  setAllowanceRoute,
];
