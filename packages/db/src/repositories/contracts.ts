import {
  type ContractTerms,
  type Coverage,
  type CoverageReason,
  type CoverageStatus,
  contractYear,
  toUserId,
  type UserId,
} from '@integr8/core';
import { sql } from 'kysely';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/** A customer's service agreement (P27, migration 0053). Dates are `YYYY-MM-DD`. */
export interface ServiceContract {
  id: string;
  reference: number;
  customerId: string;
  title: string;
  startsOn: string;
  endsOn: string;
  /** What the customer pays for the term, as a decimal string. */
  value: string | null;
  notes: string | null;
  renewalNoticeDays: number;
  allSites: boolean;
  siteIds: string[];
  allAssets: boolean;
  assetIds: string[];
  allJobTypes: boolean;
  jobTypeIds: string[];
  includedCallouts: number | null;
  renewedFromId: string | null;
  /** The contract that renewed this one, if any. */
  renewedById: string | null;
  cancelledOn: string | null;
  cancelledAt: Date | null;
  cancelledBy: UserId | null;
  cancelReason: string | null;
  version: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServiceContractInput {
  customerId: string;
  title: string;
  startsOn: string;
  endsOn: string;
  value?: string | null;
  notes?: string | null;
  renewalNoticeDays?: number;
  /** Null: every site of the customer. */
  siteIds?: readonly string[] | null;
  /** Null: every asset at the covered sites. */
  assetIds?: readonly string[] | null;
  /** Null: every job type. */
  jobTypeIds?: readonly string[] | null;
  includedCallouts?: number | null;
}

export type ServiceContractChanges = Partial<Omit<ServiceContractInput, 'customerId'>>;

export type ServiceContractWrite =
  | { outcome: 'written'; contract: ServiceContract }
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; current: ServiceContract }
  | { outcome: 'cancelled'; current: ServiceContract }
  | { outcome: 'already_renewed'; current: ServiceContract }
  | { outcome: 'site_not_customers' }
  | { outcome: 'asset_not_customers' }
  | { outcome: 'job_type_unknown' }
  | { outcome: 'dates_reversed' };

export interface ContractQuery {
  customerId?: string;
  /** Cancelled ones are left out unless asked for. */
  includeCancelled?: boolean;
  search?: string;
}

/** A job's coverage as stored (P27). */
export interface JobCoverage {
  workOrderId: string;
  contractId: string | null;
  status: CoverageStatus;
  reason: CoverageReason;
  overrideReason: string | null;
  overriddenBy: UserId | null;
  overriddenAt: Date | null;
}

/** A contract whose renewal reminder is due. */
export interface RenewalAlert {
  contract: ServiceContract;
  stage: 'notice' | 'ended';
}

const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const NOT_IN_PREREQUISITE_STATE = '55000';

function blank(value: string | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

/**
 * Service contracts for one company (P27).
 *
 * Migration 0053 numbers them, keeps a contract's customer, refuses changing a
 * cancelled one and makes sure a covered site is the customer's. Whether a job
 * is covered is decided in `@integr8/core` from `termsForCustomer`, when the job
 * is created, and stored with the job.
 */
export class ContractsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  #contracts() {
    return this.db
      .selectFrom('service_contracts as c')
      .select([
        'c.id',
        'c.reference',
        'c.customer_id',
        'c.title',
        sql<string>`c.starts_on::text`.as('starts_on'),
        sql<string>`c.ends_on::text`.as('ends_on'),
        sql<string | null>`c.value::text`.as('value'),
        'c.notes',
        'c.renewal_notice_days',
        'c.all_sites',
        'c.all_assets',
        'c.all_job_types',
        'c.included_callouts',
        'c.renewed_from_id',
        sql<string | null>`c.cancelled_on::text`.as('cancelled_on'),
        'c.cancelled_at',
        'c.cancelled_by',
        'c.cancel_reason',
        'c.version',
        'c.created_by',
        'c.created_at',
        'c.updated_at',
        sql<string | null>`(select r.id from service_contracts r
                            where r.tenant_id = c.tenant_id and r.renewed_from_id = c.id)`.as(
          'renewed_by_id',
        ),
      ])
      .where('c.tenant_id', '=', this.tenantId);
  }

  async #withLists(
    rows: Awaited<ReturnType<ReturnType<ContractsRepository['contractsQuery']>['execute']>>,
  ): Promise<ServiceContract[]> {
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((row) => row.id);
    const [sites, assets, jobTypes] = await Promise.all([
      this.db
        .selectFrom('service_contract_sites')
        .select(['contract_id', 'site_id'])
        .where('tenant_id', '=', this.tenantId)
        .where('contract_id', 'in', ids)
        .execute(),
      this.db
        .selectFrom('service_contract_assets')
        .select(['contract_id', 'asset_id'])
        .where('tenant_id', '=', this.tenantId)
        .where('contract_id', 'in', ids)
        .execute(),
      this.db
        .selectFrom('service_contract_job_types')
        .select(['contract_id', 'job_type_id'])
        .where('tenant_id', '=', this.tenantId)
        .where('contract_id', 'in', ids)
        .execute(),
    ]);
    const group = <T extends { contract_id: string }>(list: T[], pick: (row: T) => string) => {
      const map = new Map<string, string[]>();
      for (const row of list) {
        map.set(row.contract_id, [...(map.get(row.contract_id) ?? []), pick(row)]);
      }
      return map;
    };
    const siteMap = group(sites, (row) => row.site_id);
    const assetMap = group(assets, (row) => row.asset_id);
    const typeMap = group(jobTypes, (row) => row.job_type_id);
    return rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      customerId: row.customer_id,
      title: row.title,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      value: row.value,
      notes: row.notes,
      renewalNoticeDays: row.renewal_notice_days,
      allSites: row.all_sites,
      siteIds: (siteMap.get(row.id) ?? []).sort(),
      allAssets: row.all_assets,
      assetIds: (assetMap.get(row.id) ?? []).sort(),
      allJobTypes: row.all_job_types,
      jobTypeIds: (typeMap.get(row.id) ?? []).sort(),
      includedCallouts: row.included_callouts,
      renewedFromId: row.renewed_from_id,
      renewedById: row.renewed_by_id,
      cancelledOn: row.cancelled_on,
      cancelledAt: row.cancelled_at,
      cancelledBy: row.cancelled_by === null ? null : toUserId(row.cancelled_by),
      cancelReason: row.cancel_reason,
      version: row.version,
      createdBy: toUserId(row.created_by),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** The base query, exposed for its row type only. */
  contractsQuery() {
    return this.#contracts();
  }

  async list(query: ContractQuery = {}): Promise<ServiceContract[]> {
    let select = this.#contracts();
    if (query.customerId !== undefined) {
      select = select.where('c.customer_id', '=', query.customerId);
    }
    if (query.includeCancelled !== true) {
      select = select.where('c.cancelled_at', 'is', null);
    }
    const search = query.search?.trim();
    if (search !== undefined && search !== '') {
      const digits = /^\s*(?:ct-?)?0*(\d{1,9})\s*$/iu.exec(search)?.[1];
      select = select.where((eb) =>
        eb.or([
          eb('c.title', 'ilike', `%${search.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`),
          ...(digits === undefined ? [] : [eb('c.reference', '=', Number(digits))]),
        ]),
      );
    }
    const rows = await select.orderBy('c.ends_on', 'desc').orderBy('c.reference', 'desc').execute();
    return this.#withLists(rows);
  }

  async findMany(contractIds: readonly string[]): Promise<ServiceContract[]> {
    if (contractIds.length === 0) {
      return [];
    }
    const rows = await this.#contracts()
      .where('c.id', 'in', [...new Set(contractIds)])
      .execute();
    return this.#withLists(rows);
  }

  async find(contractId: string): Promise<ServiceContract | undefined> {
    return (await this.findMany([contractId]))[0];
  }

  async create(input: ServiceContractInput, actor: UserId | string): Promise<ServiceContractWrite> {
    const problem = await this.#checkLists(input.customerId, input);
    if (problem !== undefined) {
      return problem;
    }
    if (input.endsOn < input.startsOn) {
      return { outcome: 'dates_reversed' };
    }
    let id: string;
    try {
      const row = await this.db
        .insertInto('service_contracts')
        .values({
          tenant_id: this.tenantId,
          customer_id: input.customerId,
          title: input.title.trim(),
          starts_on: input.startsOn,
          ends_on: input.endsOn,
          value: input.value ?? null,
          notes: blank(input.notes) ?? null,
          ...(input.renewalNoticeDays === undefined
            ? {}
            : { renewal_notice_days: input.renewalNoticeDays }),
          all_sites: input.siteIds == null,
          all_assets: input.assetIds == null,
          all_job_types: input.jobTypeIds == null,
          included_callouts: input.includedCallouts ?? null,
          created_by: toUserId(actor),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      id = row.id;
    } catch (error) {
      if (errorCode(error) === CHECK_VIOLATION) {
        return { outcome: 'dates_reversed' };
      }
      throw error;
    }
    await this.#writeLists(id, input.customerId, input);
    return { outcome: 'written', contract: (await this.find(id))! };
  }

  async update(
    contractId: string,
    expectedVersion: number,
    changes: ServiceContractChanges,
  ): Promise<ServiceContractWrite> {
    const current = await this.find(contractId);
    if (current === undefined) {
      return { outcome: 'not_found' };
    }
    if (current.cancelledAt !== null) {
      return { outcome: 'cancelled', current };
    }
    if (current.version !== expectedVersion) {
      return { outcome: 'conflict', current };
    }
    const problem = await this.#checkLists(current.customerId, changes);
    if (problem !== undefined) {
      return problem;
    }
    if ((changes.endsOn ?? current.endsOn) < (changes.startsOn ?? current.startsOn)) {
      return { outcome: 'dates_reversed' };
    }
    const notes = blank(changes.notes);
    const row = await this.db
      .updateTable('service_contracts')
      .set({
        ...(changes.title === undefined ? {} : { title: changes.title.trim() }),
        ...(changes.startsOn === undefined ? {} : { starts_on: changes.startsOn }),
        ...(changes.endsOn === undefined ? {} : { ends_on: changes.endsOn }),
        ...(changes.value === undefined ? {} : { value: changes.value }),
        ...(notes === undefined ? {} : { notes }),
        ...(changes.renewalNoticeDays === undefined
          ? {}
          : { renewal_notice_days: changes.renewalNoticeDays }),
        ...(changes.siteIds === undefined ? {} : { all_sites: changes.siteIds === null }),
        ...(changes.assetIds === undefined ? {} : { all_assets: changes.assetIds === null }),
        ...(changes.jobTypeIds === undefined ? {} : { all_job_types: changes.jobTypeIds === null }),
        ...(changes.includedCallouts === undefined
          ? {}
          : { included_callouts: changes.includedCallouts }),
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', contractId)
      .where('version', '=', expectedVersion)
      .returning('id')
      .executeTakeFirst();
    if (row === undefined) {
      const latest = await this.find(contractId);
      return latest === undefined
        ? { outcome: 'not_found' }
        : { outcome: 'conflict', current: latest };
    }
    await this.#writeLists(contractId, current.customerId, changes);
    return { outcome: 'written', contract: (await this.find(contractId))! };
  }

  /** Ends coverage from `cancelledOn`. Final. */
  async cancel(
    contractId: string,
    expectedVersion: number,
    input: { cancelledOn: string; reason: string },
    actor: UserId | string,
  ): Promise<ServiceContractWrite> {
    const current = await this.find(contractId);
    if (current === undefined) {
      return { outcome: 'not_found' };
    }
    if (current.cancelledAt !== null) {
      return { outcome: 'cancelled', current };
    }
    if (current.version !== expectedVersion) {
      return { outcome: 'conflict', current };
    }
    const row = await this.db
      .updateTable('service_contracts')
      .set({
        cancelled_on: input.cancelledOn,
        cancelled_at: sql<Date>`now()`,
        cancelled_by: toUserId(actor),
        cancel_reason: input.reason.trim(),
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', contractId)
      .where('version', '=', expectedVersion)
      .returning('id')
      .executeTakeFirst();
    if (row === undefined) {
      const latest = await this.find(contractId);
      return latest === undefined
        ? { outcome: 'not_found' }
        : { outcome: 'conflict', current: latest };
    }
    return { outcome: 'written', contract: (await this.find(contractId))! };
  }

  /**
   * Renews a contract: a new one for the next term with the same coverage,
   * naming this one, and its maintenance plans moved across.
   */
  async renew(
    contractId: string,
    expectedVersion: number,
    term: { startsOn: string; endsOn: string; value?: string | null; title?: string },
    actor: UserId | string,
  ): Promise<ServiceContractWrite> {
    const current = await this.find(contractId);
    if (current === undefined) {
      return { outcome: 'not_found' };
    }
    if (current.cancelledAt !== null) {
      return { outcome: 'cancelled', current };
    }
    if (current.renewedById !== null) {
      return { outcome: 'already_renewed', current };
    }
    if (current.version !== expectedVersion) {
      return { outcome: 'conflict', current };
    }
    if (term.endsOn < term.startsOn) {
      return { outcome: 'dates_reversed' };
    }
    const row = await this.db
      .insertInto('service_contracts')
      .values({
        tenant_id: this.tenantId,
        customer_id: current.customerId,
        title: (term.title ?? current.title).trim(),
        starts_on: term.startsOn,
        ends_on: term.endsOn,
        value: term.value === undefined ? current.value : term.value,
        notes: current.notes,
        renewal_notice_days: current.renewalNoticeDays,
        all_sites: current.allSites,
        all_assets: current.allAssets,
        all_job_types: current.allJobTypes,
        included_callouts: current.includedCallouts,
        renewed_from_id: current.id,
        created_by: toUserId(actor),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.#writeLists(row.id, current.customerId, {
      siteIds: current.allSites ? null : current.siteIds,
      assetIds: current.allAssets ? null : current.assetIds,
      jobTypeIds: current.allJobTypes ? null : current.jobTypeIds,
    });
    await this.db
      .updateTable('maintenance_plans')
      .set({ contract_id: row.id })
      .where('tenant_id', '=', this.tenantId)
      .where('contract_id', '=', current.id)
      .where('status', '<>', 'ended')
      .execute();
    return { outcome: 'written', contract: (await this.find(row.id))! };
  }

  async #checkLists(
    customerId: string,
    input: Pick<ServiceContractInput, 'siteIds' | 'assetIds' | 'jobTypeIds'>,
  ): Promise<ServiceContractWrite | undefined> {
    if (input.siteIds != null && input.siteIds.length > 0) {
      const rows = await this.db
        .selectFrom('sites')
        .select('id')
        .where('tenant_id', '=', this.tenantId)
        .where('customer_id', '=', customerId)
        .where('id', 'in', [...new Set(input.siteIds)])
        .execute();
      if (rows.length !== new Set(input.siteIds).size) {
        return { outcome: 'site_not_customers' };
      }
    }
    if (input.assetIds != null && input.assetIds.length > 0) {
      const rows = await this.db
        .selectFrom('erp_assets')
        .select('id')
        .where('tenant_id', '=', this.tenantId)
        .where('customer_id', '=', customerId)
        .where('id', 'in', [...new Set(input.assetIds)])
        .execute();
      if (rows.length !== new Set(input.assetIds).size) {
        return { outcome: 'asset_not_customers' };
      }
    }
    if (input.jobTypeIds != null && input.jobTypeIds.length > 0) {
      const rows = await this.db
        .selectFrom('job_types')
        .select('id')
        .where('tenant_id', '=', this.tenantId)
        .where('id', 'in', [...new Set(input.jobTypeIds)])
        .execute();
      if (rows.length !== new Set(input.jobTypeIds).size) {
        return { outcome: 'job_type_unknown' };
      }
    }
    return undefined;
  }

  /** Replaces whichever coverage lists were given. Null or empty means "all". */
  async #writeLists(
    contractId: string,
    customerId: string,
    input: Pick<ServiceContractInput, 'siteIds' | 'assetIds' | 'jobTypeIds'>,
  ): Promise<void> {
    if (input.siteIds !== undefined) {
      await this.db
        .deleteFrom('service_contract_sites')
        .where('tenant_id', '=', this.tenantId)
        .where('contract_id', '=', contractId)
        .execute();
      if (input.siteIds !== null && input.siteIds.length > 0) {
        await this.db
          .insertInto('service_contract_sites')
          .values(
            [...new Set(input.siteIds)].map((siteId) => ({
              tenant_id: this.tenantId,
              contract_id: contractId,
              customer_id: customerId,
              site_id: siteId,
            })),
          )
          .execute();
      }
    }
    if (input.assetIds !== undefined) {
      await this.db
        .deleteFrom('service_contract_assets')
        .where('tenant_id', '=', this.tenantId)
        .where('contract_id', '=', contractId)
        .execute();
      if (input.assetIds !== null && input.assetIds.length > 0) {
        await this.db
          .insertInto('service_contract_assets')
          .values(
            [...new Set(input.assetIds)].map((assetId) => ({
              tenant_id: this.tenantId,
              contract_id: contractId,
              asset_id: assetId,
            })),
          )
          .execute();
      }
    }
    if (input.jobTypeIds !== undefined) {
      await this.db
        .deleteFrom('service_contract_job_types')
        .where('tenant_id', '=', this.tenantId)
        .where('contract_id', '=', contractId)
        .execute();
      if (input.jobTypeIds !== null && input.jobTypeIds.length > 0) {
        await this.db
          .insertInto('service_contract_job_types')
          .values(
            [...new Set(input.jobTypeIds)].map((jobTypeId) => ({
              tenant_id: this.tenantId,
              contract_id: contractId,
              job_type_id: jobTypeId,
            })),
          )
          .execute();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Coverage
  // -------------------------------------------------------------------------

  /**
   * Every contract a customer has had, as coverage needs it, with the call-outs
   * each has covered in the contract year `day` falls in.
   */
  async termsForCustomer(customerId: string, day: string): Promise<ContractTerms[]> {
    const contracts = await this.list({ customerId, includeCancelled: true });
    const terms: ContractTerms[] = [];
    for (const contract of contracts) {
      let calloutsUsed = 0;
      if (contract.includedCallouts !== null && day >= contract.startsOn) {
        const year = contractYear(contract.startsOn, day);
        const row = await this.db
          .selectFrom('work_order_coverage as v')
          .innerJoin('work_orders as w', (join) =>
            join.onRef('w.tenant_id', '=', 'v.tenant_id').onRef('w.id', '=', 'v.work_order_id'),
          )
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('v.tenant_id', '=', this.tenantId)
          .where('v.contract_id', '=', contract.id)
          .where('v.status', '=', 'covered')
          .where('v.reason', '=', 'contract')
          .where('w.state', '<>', 'cancelled')
          .where(
            sql<boolean>`(v.created_at at time zone coalesce(
            (select s.timezone from tenant_settings s where s.tenant_id = v.tenant_id), 'UTC'))::date
            between ${year.from}::date and ${year.to}::date`,
          )
          .executeTakeFirst();
        calloutsUsed = Number(row?.count ?? 0);
      }
      terms.push({
        id: contract.id,
        startsOn: contract.startsOn,
        endsOn: contract.endsOn,
        cancelledOn: contract.cancelledOn,
        allSites: contract.allSites,
        siteIds: contract.siteIds,
        allAssets: contract.allAssets,
        assetIds: contract.assetIds,
        allJobTypes: contract.allJobTypes,
        jobTypeIds: contract.jobTypeIds,
        includedCallouts: contract.includedCallouts,
        calloutsUsed,
      });
    }
    return terms;
  }

  async setCoverage(workOrderId: string, coverage: Coverage): Promise<void> {
    await this.db
      .insertInto('work_order_coverage')
      .values({
        tenant_id: this.tenantId,
        work_order_id: workOrderId,
        contract_id: coverage.contractId,
        status: coverage.status,
        reason: coverage.reason,
      })
      .onConflict((conflict) =>
        conflict.columns(['tenant_id', 'work_order_id']).doUpdateSet({
          contract_id: coverage.contractId,
          status: coverage.status,
          reason: coverage.reason,
        }),
      )
      .execute();
  }

  async coverageOf(workOrderIds: readonly string[]): Promise<Map<string, JobCoverage>> {
    if (workOrderIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('work_order_coverage')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('work_order_id', 'in', [...new Set(workOrderIds)])
      .execute();
    return new Map(
      rows.map((row) => [
        row.work_order_id,
        {
          workOrderId: row.work_order_id,
          contractId: row.contract_id,
          status: row.status,
          reason: row.reason,
          overrideReason: row.override_reason,
          overriddenBy: row.overridden_by === null ? null : toUserId(row.overridden_by),
          overriddenAt: row.overridden_at,
        },
      ]),
    );
  }

  /** Office staff decide a job's coverage, with a reason for its history. */
  async overrideCoverage(
    workOrderId: string,
    input: { status: CoverageStatus; contractId: string | null; reason: string },
    actor: UserId | string,
  ): Promise<JobCoverage> {
    const values = {
      contract_id: input.contractId,
      status: input.status,
      reason: 'override' as const,
      override_reason: input.reason.trim(),
      overridden_by: toUserId(actor),
      overridden_at: sql<Date>`now()`,
    };
    await this.db
      .insertInto('work_order_coverage')
      .values({ tenant_id: this.tenantId, work_order_id: workOrderId, ...values })
      .onConflict((conflict) =>
        conflict.columns(['tenant_id', 'work_order_id']).doUpdateSet(values),
      )
      .execute();
    return (await this.coverageOf([workOrderId])).get(workOrderId)!;
  }

  /** Jobs a contract covered, newest first, for its screen. */
  async coveredJobs(
    contractId: string,
    limit = 200,
  ): Promise<{ workOrderId: string; reason: CoverageReason }[]> {
    const rows = await this.db
      .selectFrom('work_order_coverage')
      .select(['work_order_id', 'reason'])
      .where('tenant_id', '=', this.tenantId)
      .where('contract_id', '=', contractId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({ workOrderId: row.work_order_id, reason: row.reason }));
  }

  // -------------------------------------------------------------------------
  // Renewal reminders
  // -------------------------------------------------------------------------

  /**
   * Contracts whose reminder is due today: entering their notice period, or
   * ended without being renewed. Each goes once.
   */
  async dueRenewalAlerts(today: string): Promise<RenewalAlert[]> {
    const rows = await this.#contracts()
      .where('c.cancelled_at', 'is', null)
      .where(
        sql<boolean>`not exists (select 1 from service_contracts r
                           where r.tenant_id = c.tenant_id and r.renewed_from_id = c.id)`,
      )
      .where((eb) =>
        eb.or([
          eb.and([
            eb('c.renewal_warned_at', 'is', null),
            sql<boolean>`c.ends_on - c.renewal_notice_days <= ${today}::date`,
            sql<boolean>`c.ends_on >= ${today}::date`,
          ]),
          eb.and([eb('c.end_alerted_at', 'is', null), sql<boolean>`c.ends_on < ${today}::date`]),
        ]),
      )
      .orderBy('c.ends_on')
      .execute();
    const contracts = await this.#withLists(rows);
    return contracts.map((contract) => ({
      contract,
      stage: contract.endsOn < today ? ('ended' as const) : ('notice' as const),
    }));
  }

  async markRenewalAlerted(contractId: string, stage: 'notice' | 'ended'): Promise<void> {
    await this.db
      .updateTable('service_contracts')
      .set(
        stage === 'notice'
          ? { renewal_warned_at: sql<Date>`now()` }
          : {
              end_alerted_at: sql<Date>`now()`,
              renewal_warned_at: sql<Date>`coalesce(renewal_warned_at, now())`,
            },
      )
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', contractId)
      .execute();
  }

  /** Whether an error was the database refusing a contract change. */
  static refused(error: unknown): boolean {
    const code = errorCode(error);
    return (
      code === FOREIGN_KEY_VIOLATION ||
      code === CHECK_VIOLATION ||
      code === NOT_IN_PREREQUISITE_STATE
    );
  }
}
