import { z } from 'zod';

/**
 * Roles a user holds *within a company*. Platform (super admin) identity is a
 * separate space and deliberately absent from this list — see P03.
 *
 * Ordered from most to least privileged; `roleRank` depends on this order.
 */
export const ROLES = [
  'owner',
  'admin',
  // Seventh round (ADR-0010): a person who keeps HR and payroll, and one who
  // keeps the store, purchasing and manufacturing — each nothing else.
  'hr_manager',
  'inventory_manager',
  'dispatcher',
  'engineer',
  'viewer',
] as const;

export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

const RANK_BY_ROLE: Readonly<Record<Role, number>> = Object.freeze(
  Object.fromEntries(ROLES.map((role, index) => [role, ROLES.length - index])) as Record<
    Role,
    number
  >,
);

/** Higher rank means more privilege. `owner` is the highest. */
export function roleRank(role: Role): number {
  return RANK_BY_ROLE[role];
}

/**
 * True when `role` is at least as privileged as `required`.
 *
 * This is a coarse hierarchy check for guarding whole surfaces. Fine-grained
 * capability checks arrive with the permission matrix in P03 and must not be
 * expressed as rank comparisons.
 */
export function hasAtLeastRole(role: Role, required: Role): boolean {
  return roleRank(role) >= roleRank(required);
}

/**
 * Capabilities the company can give a member on top of their role
 * (ADR-0010): an engineer who also keeps the store, an admin who also runs
 * payroll. Each grants what the role of the same name does in its own area,
 * and nothing of that role's basics.
 */
export const GRANTS = ['hr_manager', 'inventory_manager'] as const;

export const grantSchema = z.enum(GRANTS);
export type Grant = z.infer<typeof grantSchema>;
