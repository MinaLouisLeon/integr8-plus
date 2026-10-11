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
