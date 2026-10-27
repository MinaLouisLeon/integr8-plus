import {
  calendarDaySchema,
  CONTRACT_CANCEL_REASON_MAX,
  COVERAGE_OVERRIDE_REASON_MAX,
  COVERAGE_STATUSES,
  contractStanding,
  contractYear,
  DEFAULT_RENEWAL_NOTICE_DAYS,
  formatContractReference,
  holds,
  RENEWAL_NOTICE_DAYS_MAX,
  renewalTerm,
} from '@integr8/core';
import type { ServiceContract, ServiceContractWrite, TenantTransaction } from '@integr8/db';
import { withTenant } from '@integr8/db';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { crmAudit as audit } from './crm-shared.js';
import { coverageDetailBody, coverageDetailSchema, jobTermsOf } from './job-terms.js';
import {
  booleanQuery,
  readableWorkOrder,
  workOrderSummaries,
  workOrderSummarySchema,
} from './operations.js';
import { workOrderParams } from './work-orders.js';
import { companyToday } from './sales-quotes.js';
import { iso } from './schemas.js';

/**
 * Service contracts (P27).
 *
 * What each customer has agreed to: a term, the sites, assets and job types it
 * covers, and how many call-outs a year it includes. Each new job is marked
 * covered or chargeable when it is created; office staff can override that
 * with a reason. Owners, admins and dispatchers keep contracts
 * (`contract.manage`); viewers read them (`contract.read`).
 */

const TAGS = ['contracts'];

const contractParams = z.object({ contractId: z.uuid() });

const STANDINGS = ['upcoming', 'active', 'ending', 'ended', 'cancelled'] as const;

const idList = z
  .array(z.uuid())
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, 'Each once');

const moneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/u, 'A positive amount with at most two decimals');

export const contractSchema = z.object({
  id: z.uuid(),
  /** `CT-000012`. */
  reference: z.string(),
  title: z.string(),
  customer: z.object({ id: z.uuid(), name: z.string() }),
  /** Calendar days, `YYYY-MM-DD`; the end is the last day covered. */
  startsOn: z.string(),
  endsOn: z.string(),
  value: z.string().nullable(),
  notes: z.string().nullable(),
  renewalNoticeDays: z.number().int(),
  /** Null: every one of the customer's. */
  sites: z.array(z.object({ id: z.uuid(), name: z.string() })).nullable(),
  /** Null: every asset at the covered sites. */
  assets: z.array(z.object({ id: z.uuid(), name: z.string() })).nullable(),
  /** Null: every job type. */
  jobTypes: z.array(z.object({ id: z.uuid(), name: z.string() })).nullable(),
  /** Call-outs included per contract year; null for no limit. */
  includedCallouts: z.number().int().nullable(),
  /** Call-outs covered so far in the current contract year. */
  calloutsUsed: z.number().int(),
  /** Today, in the company's time zone. `ending` is within the renewal notice period. */
  standing: z.enum(STANDINGS),
  renewedFrom: z.object({ id: z.uuid(), reference: z.string() }).nullable(),
  renewedBy: z.object({ id: z.uuid(), reference: z.string() }).nullable(),
  cancelledOn: z.string().nullable(),
  cancelReason: z.string().nullable(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const contractInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  startsOn: calendarDaySchema,
  endsOn: calendarDaySchema,
  value: moneySchema.nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  renewalNoticeDays: z.number().int().min(0).max(RENEWAL_NOTICE_DAYS_MAX).optional(),
  siteIds: idList.nullable().optional(),
  assetIds: idList.nullable().optional(),
  jobTypeIds: idList.nullable().optional(),
  includedCallouts: z.number().int().min(0).max(10000).nullable().optional(),
});

// ---------------------------------------------------------------------------

async function contractBodies(tx: TenantTransaction, contracts: readonly ServiceContract[]) {
  if (contracts.length === 0) {
    return [];
  }
  const today = await companyToday(tx);
  const [customers, sites, assets, jobTypes, related] = await Promise.all([
    tx.customers.findMany(contracts.map((contract) => contract.customerId)),
    tx.sites.findMany(contracts.flatMap((contract) => contract.siteIds)),
    tx.assets.findMany(contracts.flatMap((contract) => contract.assetIds)),
    tx.jobTypes.list({ includeArchived: true }),
    tx.contracts.findMany(
      contracts.flatMap((contract) =>
        [contract.renewedFromId, contract.renewedById].filter((id): id is string => id !== null),
      ),
    ),
  ]);
  const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));
  const siteName = new Map(sites.map((site) => [site.id, site.name]));
  const assetName = new Map(assets.map((asset) => [asset.id, asset.name]));
  const typeName = new Map(jobTypes.map((type) => [type.id, type.name]));
  const referenceOf = new Map(
    related.map((contract) => [contract.id, formatContractReference(contract.reference)]),
  );
  return Promise.all(
    contracts.map(async (contract) => {
      const terms = await tx.contracts.termsForCustomer(contract.customerId, today);
      const used = terms.find((entry) => entry.id === contract.id)?.calloutsUsed ?? 0;
      return {
        id: contract.id,
        reference: formatContractReference(contract.reference),
        title: contract.title,
        customer: { id: contract.customerId, name: customerName.get(contract.customerId) ?? '' },
        startsOn: contract.startsOn,
        endsOn: contract.endsOn,
        value: contract.value,
        notes: contract.notes,
        renewalNoticeDays: contract.renewalNoticeDays,
        sites: contract.allSites
          ? null
          : contract.siteIds.map((id) => ({ id, name: siteName.get(id) ?? '' })),
        assets: contract.allAssets
          ? null
          : contract.assetIds.map((id) => ({ id, name: assetName.get(id) ?? '' })),
        jobTypes: contract.allJobTypes
          ? null
          : contract.jobTypeIds.map((id) => ({ id, name: typeName.get(id) ?? '' })),
        includedCallouts: contract.includedCallouts,
        calloutsUsed: contract.includedCallouts === null ? 0 : used,
        standing: contractStanding(contract, today),
        renewedFrom:
          contract.renewedFromId === null
            ? null
            : {
                id: contract.renewedFromId,
                reference: referenceOf.get(contract.renewedFromId) ?? '',
              },
        renewedBy:
          contract.renewedById === null
            ? null
            : { id: contract.renewedById, reference: referenceOf.get(contract.renewedById) ?? '' },
        cancelledOn: contract.cancelledOn,
        cancelReason: contract.cancelReason,
        version: contract.version,
        createdAt: iso(contract.createdAt),
        updatedAt: iso(contract.updatedAt),
      };
    }),
  );
}

async function contractBody(tx: TenantTransaction, contract: ServiceContract) {
  return (await contractBodies(tx, [contract]))[0]!;
}

function contractRefusal(result: Exclude<ServiceContractWrite, { outcome: 'written' }>): never {
  switch (result.outcome) {
    case 'not_found':
      throw notFound('This contract does not exist.');
    case 'conflict':
      throw conflict(
        'contract_changed',
        'Someone else changed this contract. Reload and try again.',
      );
    case 'cancelled':
      throw conflict('contract_cancelled', 'This contract was cancelled and cannot change.');
    case 'already_renewed':
      throw conflict('contract_already_renewed', 'This contract has already been renewed.');
    case 'site_not_customers':
      throw unprocessable('contract_site_not_customers', 'Choose the customer’s own sites.', [
        {
          field: 'body.siteIds',
          code: 'contract_site_not_customers',
          message: 'Choose the customer’s own sites.',
        },
      ]);
    case 'asset_not_customers':
      throw unprocessable('contract_asset_not_customers', 'Choose the customer’s own assets.', [
        {
          field: 'body.assetIds',
          code: 'contract_asset_not_customers',
          message: 'Choose the customer’s own assets.',
        },
      ]);
    case 'job_type_unknown':
      throw unprocessable('job_type_unknown', 'This job type does not exist.', [
        {
          field: 'body.jobTypeIds',
          code: 'job_type_unknown',
          message: 'Choose existing job types.',
        },
      ]);
    case 'dates_reversed':
      throw unprocessable(
        'contract_dates_reversed',
        'The end date must be on or after the start date.',
        [
          {
            field: 'body.endsOn',
            code: 'contract_dates_reversed',
            message: 'Choose a later end date.',
          },
        ],
      );
  }
}

function written(result: ServiceContractWrite): ServiceContract {
  if (result.outcome !== 'written') {
    contractRefusal(result);
  }
  return result.contract;
}

// ---------------------------------------------------------------------------

export const listContractsRoute = defineRoute({
  method: 'get',
  path: '/v1/contracts',
  operationId: 'listContracts',
  summary: 'Service contracts',
  description:
    'Latest end first. `customerId` for one customer’s; cancelled ones only with `includeCancelled`. `q` matches the title or the reference (`CT-000012`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'contract.read',
  params: noSchema,
  query: z.object({
    customerId: z.uuid().optional(),
    includeCancelled: booleanQuery,
    q: z.string().trim().max(200).optional(),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'The contracts.',
      schema: z.object({
        items: z.array(contractSchema),
        defaults: z.object({ renewalNoticeDays: z.number().int() }),
        can: z.object({ manage: z.boolean() }),
      }),
    },
  },
  handler: async ({ query }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const contracts = await tx.contracts.list({
        ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
        includeCancelled: query.includeCancelled === 'true',
        ...(query.q === undefined ? {} : { search: query.q }),
      });
      return {
        items: await contractBodies(tx, contracts),
        defaults: { renewalNoticeDays: DEFAULT_RENEWAL_NOTICE_DAYS },
        can: { manage: holds(context.principal, 'contract.manage') },
      };
    });
    return { status: 200, body };
  },
});

export const getContractRoute = defineRoute({
  method: 'get',
  path: '/v1/contracts/:contractId',
  operationId: 'getContract',
  summary: 'A contract, its maintenance plans and the jobs it covered',
  description: 'The jobs are the latest 200 whose coverage names this contract, covered or not.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'contract.read',
  params: contractParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The contract.',
      schema: z.object({
        contract: contractSchema,
        /** This contract year, `YYYY-MM-DD`, which `calloutsUsed` counts. */
        contractYear: z.object({ from: z.string(), to: z.string() }).nullable(),
        plans: z.array(
          z.object({
            id: z.uuid(),
            title: z.string(),
            asset: z.object({ id: z.uuid(), name: z.string() }),
            status: z.string(),
            nextDueOn: z.string().nullable(),
          }),
        ),
        jobs: z.array(workOrderSummarySchema),
        can: z.object({ manage: z.boolean() }),
      }),
    },
    404: { description: 'No such contract.' },
  },
  handler: async ({ params }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const contract = await tx.contracts.find(params.contractId);
      if (contract === undefined) {
        throw notFound('This contract does not exist.');
      }
      const today = await companyToday(tx);
      const [plans, covered] = await Promise.all([
        tx.maintenance.listPlans({ contractId: contract.id }),
        tx.contracts.coveredJobs(contract.id),
      ]);
      const jobs = await tx.workOrders.findMany(covered.map((entry) => entry.workOrderId));
      const order = new Map(covered.map((entry, index) => [entry.workOrderId, index]));
      jobs.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      return {
        contract: await contractBody(tx, contract),
        contractYear:
          today < contract.startsOn || today > contract.endsOn
            ? null
            : contractYear(contract.startsOn, today),
        plans: plans.map((plan) => ({
          id: plan.id,
          title: plan.title,
          asset: { id: plan.assetId, name: plan.assetName },
          status: plan.status,
          nextDueOn: plan.nextDueOn,
        })),
        jobs: await workOrderSummaries(tx, jobs),
        can: { manage: holds(context.principal, 'contract.manage') },
      };
    });
    return { status: 200, body };
  },
});

export const createContractRoute = defineRoute({
  method: 'post',
  path: '/v1/contracts',
  operationId: 'createContract',
  summary: 'Add a service contract',
  description:
    'Leave `siteIds`, `assetIds` or `jobTypeIds` out (or null) to cover all of that kind. Jobs created from now on are marked covered or chargeable against it; existing jobs keep their coverage.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'contract.manage',
  params: noSchema,
  query: noSchema,
  body: contractInputSchema.extend({ customerId: z.uuid() }),
  responses: {
    201: { description: 'The contract.', schema: contractSchema },
    422: {
      description:
        'A site or asset is not the customer’s (`contract_site_not_customers`, `contract_asset_not_customers`), or the dates are reversed (`contract_dates_reversed`).',
    },
  },
  handler: async ({ body }, context) => {
    const created = await withTenant(context.principal.tenantId, async (tx) => {
      const customer = await tx.customers.find(body.customerId);
      if (customer === undefined) {
        throw unprocessable('customer_unknown', 'This customer does not exist.', [
          { field: 'body.customerId', code: 'not_found', message: 'Choose a customer.' },
        ]);
      }
      const contract = written(await tx.contracts.create(body, context.principal.userId));
      await audit(tx, context, 'contract.created', 'service_contract', contract.id, {
        reference: formatContractReference(contract.reference),
      });
      return contractBody(tx, contract);
    });
    return { status: 201, body: created };
  },
});

export const updateContractRoute = defineRoute({
  method: 'patch',
  path: '/v1/contracts/:contractId',
  operationId: 'updateContract',
  summary: 'Change a contract’s term or coverage',
  description:
    'Jobs already created keep their coverage. Changing the end date re-arms the renewal reminder.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'contract.manage',
  params: contractParams,
  query: noSchema,
  body: contractInputSchema.partial().extend({ expectedVersion: z.number().int().min(1) }),
  responses: {
    200: { description: 'The contract.', schema: contractSchema },
    404: { description: 'No such contract.' },
    409: {
      description: 'Changed elsewhere (`contract_changed`) or cancelled (`contract_cancelled`).',
    },
    422: { description: 'As for adding one.' },
  },
  handler: async ({ params, body }, context) => {
    const updated = await withTenant(context.principal.tenantId, async (tx) => {
      const { expectedVersion, ...changes } = body;
      const contract = written(
        await tx.contracts.update(params.contractId, expectedVersion, changes),
      );
      await audit(tx, context, 'contract.updated', 'service_contract', contract.id, {
        fields: Object.keys(changes),
      });
      return contractBody(tx, contract);
    });
    return { status: 200, body: updated };
  },
});

export const cancelContractRoute = defineRoute({
  method: 'post',
  path: '/v1/contracts/:contractId/cancel',
  operationId: 'cancelContract',
  summary: 'Cancel a contract',
  description:
    'Coverage ends the day before `cancelledOn`. Final: a cancelled contract cannot be changed or renewed. Its maintenance plans stop making jobs after it ends.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'contract.manage',
  params: contractParams,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().min(1),
    cancelledOn: calendarDaySchema,
    reason: z.string().trim().min(1).max(CONTRACT_CANCEL_REASON_MAX),
  }),
  responses: {
    200: { description: 'The contract.', schema: contractSchema },
    404: { description: 'No such contract.' },
    409: { description: 'Changed elsewhere, or already cancelled.' },
  },
  handler: async ({ params, body }, context) => {
    const cancelled = await withTenant(context.principal.tenantId, async (tx) => {
      const contract = written(
        await tx.contracts.cancel(
          params.contractId,
          body.expectedVersion,
          { cancelledOn: body.cancelledOn, reason: body.reason },
          context.principal.userId,
        ),
      );
      await audit(tx, context, 'contract.cancelled', 'service_contract', contract.id, {
        cancelledOn: body.cancelledOn,
        reason: body.reason,
      });
      return contractBody(tx, contract);
    });
    return { status: 200, body: cancelled };
  },
});

export const renewContractRoute = defineRoute({
  method: 'post',
  path: '/v1/contracts/:contractId/renew',
  operationId: 'renewContract',
  summary: 'Renew a contract',
  description:
    'Creates the next contract with the same coverage, by default from the day after this one ends for as long again, and moves this one’s maintenance plans to it. A contract is renewed once.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'contract.manage',
  params: contractParams,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().min(1),
    startsOn: calendarDaySchema.optional(),
    endsOn: calendarDaySchema.optional(),
    value: moneySchema.nullable().optional(),
    title: z.string().trim().min(1).max(200).optional(),
  }),
  responses: {
    201: { description: 'The new contract.', schema: contractSchema },
    404: { description: 'No such contract.' },
    409: {
      description: 'Changed elsewhere, cancelled, or already renewed (`contract_already_renewed`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const renewed = await withTenant(context.principal.tenantId, async (tx) => {
      const current = await tx.contracts.find(params.contractId);
      if (current === undefined) {
        throw notFound('This contract does not exist.');
      }
      const term = renewalTerm(current);
      const contract = written(
        await tx.contracts.renew(
          current.id,
          body.expectedVersion,
          {
            startsOn: body.startsOn ?? term.startsOn,
            endsOn: body.endsOn ?? term.endsOn,
            ...(body.value === undefined ? {} : { value: body.value }),
            ...(body.title === undefined ? {} : { title: body.title }),
          },
          context.principal.userId,
        ),
      );
      await audit(tx, context, 'contract.renewed', 'service_contract', contract.id, {
        renewedFrom: current.id,
        reference: formatContractReference(contract.reference),
      });
      return contractBody(tx, contract);
    });
    return { status: 201, body: renewed };
  },
});

export const overrideCoverageRoute = defineRoute({
  method: 'put',
  path: '/v1/work-orders/:workOrderId/coverage',
  operationId: 'overrideWorkOrderCoverage',
  summary: 'Decide whether a contract covers a job',
  description:
    'Overrides what was worked out when the job was created. The reason goes into the job’s history. `contractId` must be one of the customer’s contracts.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'contract.manage',
  params: workOrderParams,
  query: noSchema,
  body: z.object({
    status: z.enum(COVERAGE_STATUSES),
    contractId: z.uuid().nullable(),
    reason: z.string().trim().min(1).max(COVERAGE_OVERRIDE_REASON_MAX),
  }),
  responses: {
    200: { description: 'The coverage.', schema: coverageDetailSchema },
    404: { description: 'No such work order.' },
    409: { description: 'The job is cancelled (`work_order_closed`).' },
    422: { description: 'The contract is not the customer’s (`contract_not_customers`).' },
  },
  handler: async ({ params, body }, context) => {
    const coverage = await withTenant(context.principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, context.principal, params.workOrderId);
      if (job.state === 'cancelled') {
        throw conflict('work_order_closed', 'This job is cancelled.');
      }
      if (body.contractId !== null) {
        const contract = await tx.contracts.find(body.contractId);
        if (contract?.customerId !== job.customerId) {
          throw unprocessable('contract_not_customers', 'Choose one of the customer’s contracts.', [
            {
              field: 'body.contractId',
              code: 'contract_not_customers',
              message: 'Choose one of the customer’s contracts.',
            },
          ]);
        }
      }
      await tx.contracts.overrideCoverage(
        job.id,
        { status: body.status, contractId: body.contractId, reason: body.reason },
        context.principal.userId,
      );
      await audit(tx, context, 'work_order.coverage_overridden', 'work_order', job.id, {
        status: body.status,
        contractId: body.contractId,
      });
      return coverageDetailBody(await jobTermsOf(tx, [job.id]), job.id)!;
    });
    return { status: 200, body: coverage };
  },
});

export const contractRoutes = [
  listContractsRoute,
  getContractRoute,
  createContractRoute,
  updateContractRoute,
  cancelContractRoute,
  renewContractRoute,
  overrideCoverageRoute,
];
