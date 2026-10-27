import { z } from 'zod';
import { addMonths, daysBetween, earlierDay } from './calendar.js';
import { addDays } from './finance.js';

/**
 * Service contracts (P27): what a customer has agreed to, and whether a job is
 * covered by it.
 *
 * A contract covers its customer's jobs between its start and end days (or
 * until the day before it was cancelled) at the sites, for the assets and of
 * the job types it lists — each list empty meaning "all". It may include a
 * number of call-outs per contract year: jobs that did not come from a
 * maintenance plan. Coverage is worked out once, when the job is created; the
 * office can override it afterwards with a reason.
 */

export const COVERAGE_STATUSES = ['covered', 'chargeable'] as const;
export const coverageStatusSchema = z.enum(COVERAGE_STATUSES);
export type CoverageStatus = z.infer<typeof coverageStatusSchema>;

export const COVERAGE_REASONS = [
  'contract',
  'maintenance_plan',
  'no_contract',
  'contract_ended',
  'site_not_covered',
  'asset_not_covered',
  'job_type_not_covered',
  'callouts_used',
  'override',
] as const;
export const coverageReasonSchema = z.enum(COVERAGE_REASONS);
export type CoverageReason = z.infer<typeof coverageReasonSchema>;

export const DEFAULT_RENEWAL_NOTICE_DAYS = 60;
export const RENEWAL_NOTICE_DAYS_MAX = 365;
export const CONTRACT_CANCEL_REASON_MAX = 500;
export const COVERAGE_OVERRIDE_REASON_MAX = 500;

export function formatContractReference(reference: number): string {
  return `CT-${String(reference).padStart(6, '0')}`;
}

/** What coverage needs to know about a contract. */
export interface ContractTerms {
  id: string;
  startsOn: string;
  endsOn: string;
  cancelledOn: string | null;
  allSites: boolean;
  siteIds: readonly string[];
  allAssets: boolean;
  assetIds: readonly string[];
  allJobTypes: boolean;
  jobTypeIds: readonly string[];
  includedCallouts: number | null;
  /** Call-outs it has already covered in the contract year the job falls in. */
  calloutsUsed: number;
}

/** The last day a contract covers: its end, or the day before it was cancelled. */
export function contractLastDay(contract: Pick<ContractTerms, 'endsOn' | 'cancelledOn'>): string {
  return contract.cancelledOn === null
    ? contract.endsOn
    : earlierDay(contract.endsOn, addDays(contract.cancelledOn, -1));
}

/** Whether a contract covers a day at all. */
export function contractRunsOn(
  contract: Pick<ContractTerms, 'startsOn' | 'endsOn' | 'cancelledOn'>,
  day: string,
): boolean {
  return day >= contract.startsOn && day <= contractLastDay(contract);
}

export type ContractStanding = 'upcoming' | 'active' | 'ending' | 'ended' | 'cancelled';

/** Where a contract stands today, for its badge. `ending` is within its notice period. */
export function contractStanding(
  contract: Pick<ContractTerms, 'startsOn' | 'endsOn' | 'cancelledOn'> & {
    renewalNoticeDays: number;
  },
  today: string,
): ContractStanding {
  if (contract.cancelledOn !== null && today >= contract.cancelledOn) {
    return 'cancelled';
  }
  if (today < contract.startsOn) {
    return 'upcoming';
  }
  if (today > contract.endsOn) {
    return 'ended';
  }
  return daysBetween(today, contract.endsOn) <= contract.renewalNoticeDays ? 'ending' : 'active';
}

/** The contract year a day falls in: whole years from the start date. */
export function contractYear(startsOn: string, day: string): { from: string; to: string } {
  let years = Math.max(0, Math.floor(daysBetween(startsOn, day) / 366));
  while (addMonths(startsOn, (years + 1) * 12) <= day) {
    years += 1;
  }
  const from = addMonths(startsOn, years * 12);
  return { from, to: addDays(addMonths(startsOn, (years + 1) * 12), -1) };
}

/**
 * The next term when a contract is renewed: from the day after it ends, for
 * as long again. A term of whole months (1 January to 31 December) stays whole
 * months; anything else keeps its number of days.
 */
export function renewalTerm(contract: Pick<ContractTerms, 'startsOn' | 'endsOn'>): {
  startsOn: string;
  endsOn: string;
} {
  const startsOn = addDays(contract.endsOn, 1);
  for (let months = 1; months <= 120; months += 1) {
    const next = addMonths(contract.startsOn, months);
    if (next === startsOn) {
      return { startsOn, endsOn: addDays(addMonths(startsOn, months), -1) };
    }
    if (next > startsOn) {
      break;
    }
  }
  return { startsOn, endsOn: addDays(startsOn, daysBetween(contract.startsOn, contract.endsOn)) };
}

/** The first day of a contract's renewal notice period. */
export function renewalNoticeDay(contract: { endsOn: string; renewalNoticeDays: number }): string {
  return addDays(contract.endsOn, -contract.renewalNoticeDays);
}

export interface CoverageInput {
  /** The company's day the job was created. */
  day: string;
  siteId: string;
  assetIds: readonly string[];
  jobTypeId: string;
  /**
   * Set for a job made by a maintenance plan: the plan's contract, or null when
   * the plan has none. Planned jobs never use up included call-outs.
   */
  fromPlan?: { contractId: string | null } | undefined;
  /** Every contract the customer has had, cancelled ones included. */
  contracts: readonly ContractTerms[];
}

export interface Coverage {
  status: CoverageStatus;
  reason: CoverageReason;
  contractId: string | null;
}

/** Why one running contract does not cover a job, or undefined when it does. */
function shortfall(
  contract: ContractTerms,
  input: CoverageInput,
  planned: boolean,
): CoverageReason | undefined {
  if (!contract.allSites && !contract.siteIds.includes(input.siteId)) {
    return 'site_not_covered';
  }
  if (!contract.allAssets && input.assetIds.some((id) => !contract.assetIds.includes(id))) {
    return 'asset_not_covered';
  }
  if (!contract.allJobTypes && !contract.jobTypeIds.includes(input.jobTypeId)) {
    return 'job_type_not_covered';
  }
  if (
    !planned &&
    contract.includedCallouts !== null &&
    contract.calloutsUsed >= contract.includedCallouts
  ) {
    return 'callouts_used';
  }
  return undefined;
}

/**
 * Whether a new job is covered. Undefined when the customer has never had a
 * contract: a company that does not use contracts sees no badge at all.
 */
export function coverageFor(input: CoverageInput): Coverage | undefined {
  if (input.contracts.length === 0) {
    return undefined;
  }
  const planned = input.fromPlan !== undefined;

  // A plan's own contract covers its jobs while it runs, whatever its lists say:
  // the plan was set up under it.
  if (input.fromPlan?.contractId != null) {
    const own = input.contracts.find((contract) => contract.id === input.fromPlan!.contractId);
    if (own !== undefined && contractRunsOn(own, input.day)) {
      return { status: 'covered', reason: 'maintenance_plan', contractId: own.id };
    }
  }

  const running = input.contracts
    .filter((contract) => contractRunsOn(contract, input.day))
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.id.localeCompare(b.id));
  if (running.length === 0) {
    const ended = input.contracts.some((contract) => contractLastDay(contract) < input.day);
    return {
      status: 'chargeable',
      reason: ended ? 'contract_ended' : 'no_contract',
      contractId: null,
    };
  }

  let first: { contract: ContractTerms; reason: CoverageReason } | undefined;
  for (const contract of running) {
    const reason = shortfall(contract, input, planned);
    if (reason === undefined) {
      return {
        status: 'covered',
        reason: planned ? 'maintenance_plan' : 'contract',
        contractId: contract.id,
      };
    }
    first ??= { contract, reason };
  }
  return { status: 'chargeable', reason: first!.reason, contractId: first!.contract.id };
}
