import { z } from 'zod';

/**
 * The CRM's vocabulary, shared by every client and the API (CRM/ERP plan,
 * phase F1).
 *
 * Statuses and sources are data here and check constraints in the database
 * (migration 0024), and the schema-invariant suite compares the two, so a
 * screen can never offer a value the server refuses.
 */

// ---------------------------------------------------------------------------
// Modules a company can have switched on
// ---------------------------------------------------------------------------

/**
 * Feature flags that gate whole modules. Each is a row in `feature_flags`,
 * declared by the migration that introduces the module and off by default;
 * Integr8 staff switch it on per company. A route or a menu section that names
 * one is unavailable to a company without it, whatever the seat's permissions.
 */
export const MODULE_FEATURES = ['crm'] as const;
export const moduleFeatureSchema = z.enum(MODULE_FEATURES);
export type ModuleFeature = z.infer<typeof moduleFeatureSchema>;

/** True when a company's resolved flags (as `/v1/me` returns them) include this module. */
export function hasFeature(
  features: Readonly<Record<string, boolean>> | undefined,
  feature: ModuleFeature,
): boolean {
  return features?.[feature] === true;
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified', 'converted'] as const;
export const leadStatusSchema = z.enum(LEAD_STATUSES);
export type LeadStatus = z.infer<typeof leadStatusSchema>;

/** Every status a person can set by editing a lead. `converted` is reached only by converting. */
export const OPEN_LEAD_STATUSES = [
  'new',
  'contacted',
  'qualified',
  'unqualified',
] as const satisfies readonly LeadStatus[];
export type OpenLeadStatus = (typeof OPEN_LEAD_STATUSES)[number];

export const LEAD_SOURCES = ['manual', 'referral', 'web', 'import', 'other'] as const;
export const leadSourceSchema = z.enum(LEAD_SOURCES);
export type LeadSource = z.infer<typeof leadSourceSchema>;

/**
 * Whether a lead may move from one status to another by an edit.
 *
 * The open statuses move freely among themselves: a prospect who went quiet can
 * be contacted again, and one marked unqualified can be reconsidered. Nothing
 * moves into `converted` by an edit, because conversion creates or links a
 * customer and has its own endpoint; and nothing moves out of it, because the
 * customer it became may already have work against it.
 */
export function leadTransitionAllowed(from: LeadStatus, to: LeadStatus): boolean {
  if (from === to) {
    return true;
  }
  return from !== 'converted' && to !== 'converted';
}

/** A lead counts as live — in lists by default, in counts — until it is converted, ruled out or archived. */
export function isLeadOpen(status: LeadStatus): boolean {
  return status !== 'converted' && status !== 'unqualified';
}

/**
 * Whether a lead can be converted into a customer: it is still open (new,
 * contacted or qualified) and not archived. A lead ruled out is reconsidered
 * (moved back to an open status), and an archived one restored, before it
 * becomes a customer, so nobody converts one by accident.
 */
export function leadConvertible(lead: { status: LeadStatus; archivedAt: unknown }): boolean {
  return lead.archivedAt === null && isLeadOpen(lead.status);
}

/** Why an existing customer is suggested for a lead. Suggestions only: nothing is merged. */
export const LEAD_MATCH_REASONS = ['email', 'phone', 'name'] as const;
export type LeadMatchReason = (typeof LEAD_MATCH_REASONS)[number];

// ---------------------------------------------------------------------------
// Opportunities and the pipeline
// ---------------------------------------------------------------------------

/** Where an opportunity stands. Always the outcome of its stage (a database trigger checks). */
export const OPPORTUNITY_STATUSES = ['open', 'won', 'lost'] as const;
export const opportunityStatusSchema = z.enum(OPPORTUNITY_STATUSES);
export type OpportunityStatus = z.infer<typeof opportunityStatusSchema>;

/** What reaching a stage means. The same words as an opportunity's status. */
export const STAGE_OUTCOMES = OPPORTUNITY_STATUSES;
export type StageOutcome = OpportunityStatus;

/** What happened to an opportunity, in its history. */
export const OPPORTUNITY_EVENT_KINDS = [
  'created',
  'stage_changed',
  'won',
  'lost',
  'reopened',
] as const;
export type OpportunityEventKind = (typeof OPPORTUNITY_EVENT_KINDS)[number];

/**
 * The pipeline every company starts with. Keys are stable and translated by
 * the screens (`crm.stage.<key>`); probabilities are basis points, so 2500 is
 * 25 %. Exactly one stage wins and one loses.
 */
export const DEFAULT_PIPELINE_STAGES = [
  { key: 'new', label: 'New', probabilityBp: 1000, outcome: 'open' },
  { key: 'qualified', label: 'Qualified', probabilityBp: 2500, outcome: 'open' },
  { key: 'proposal', label: 'Proposal', probabilityBp: 5000, outcome: 'open' },
  { key: 'negotiation', label: 'Negotiation', probabilityBp: 7500, outcome: 'open' },
  { key: 'won', label: 'Won', probabilityBp: 10000, outcome: 'won' },
  { key: 'lost', label: 'Lost', probabilityBp: 0, outcome: 'lost' },
] as const satisfies readonly {
  key: string;
  label: string;
  probabilityBp: number;
  outcome: StageOutcome;
}[];

/** A chance in basis points: 0 (never) to 10000 (certain). Whole numbers, so no float rounding. */
export const basisPointsSchema = z.number().int().min(0).max(10_000);

/**
 * Whether an opportunity may move from one stage to another. Any stage of its
 * own pipeline that is not archived and is not where it already is: deals skip
 * stages, go back a step, and are reopened after being lost. Losing needs a
 * reason (checked by the API, which has the text).
 */
export function opportunityMoveAllowed(
  from: { id: string; pipelineId: string },
  to: { id: string; pipelineId: string; archivedAt: unknown },
): boolean {
  return to.pipelineId === from.pipelineId && to.id !== from.id && to.archivedAt === null;
}

/** The history entry a move from one outcome to another records. */
export function opportunityEventKind(from: StageOutcome, to: StageOutcome): OpportunityEventKind {
  if (to === 'won' || to === 'lost') {
    return from === to ? 'stage_changed' : to;
  }
  return from === 'open' ? 'stage_changed' : 'reopened';
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export const ACTIVITY_KINDS = ['call', 'email', 'meeting', 'note', 'follow_up', 'task'] as const;
export const activityKindSchema = z.enum(ACTIVITY_KINDS);
export type ActivityKind = z.infer<typeof activityKindSchema>;

export const ACTIVITY_STATUSES = ['open', 'done', 'cancelled'] as const;
export const activityStatusSchema = z.enum(ACTIVITY_STATUSES);
export type ActivityStatus = z.infer<typeof activityStatusSchema>;

/** A note records something that happened; it is done when written. Everything else starts open. */
export function activityStartsDone(kind: ActivityKind): boolean {
  return kind === 'note';
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * A decimal amount as the API carries it: a string, never a JavaScript number,
 * with up to 16 whole digits and 4 decimal places (Postgres `numeric(20,4)`).
 * Non-negative: CRM amounts are estimates of a deal's value, not ledger entries.
 */
export const decimalAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,16}(\.\d{1,4})?$/u, 'Use digits with up to four decimal places, such as 1250.50');

/** An ISO 4217 currency code, upper case. */
export const currencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/u, 'Use a three-letter currency code, such as EGP');
