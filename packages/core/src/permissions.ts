import { z } from 'zod';
import type { Role } from './roles.js';

/**
 * What each role may do, as one table.
 *
 * The alternative — a `role === 'admin'` check at each call site — spreads the
 * access-control policy across hundreds of files, where nobody can read it and
 * a missing check looks exactly like code that was never written. Here the
 * whole policy fits on a screen, and a reviewer can answer "what can a
 * dispatcher do?" by reading rather than by grepping.
 *
 * This is deliberately *not* derived from `roleRank`. Rank answers "is this
 * role at least as senior as that one", which is the right question for
 * guarding a whole surface and the wrong one for a specific capability: a
 * dispatcher outranks an engineer without needing to revoke anyone's sessions.
 * Every cell below is decided on its own, and `permissions.test.ts` fails if a
 * new permission is added without deciding it for all five roles.
 */

export const PERMISSIONS = [
  /** Read the company's own record: name, slug, status. */
  'tenant.read',
  /** Change company settings. Owner only — billing hangs off this in P17. */
  'tenant.update',

  'member.read',
  'member.invite',
  'member.update_role',
  'member.suspend',
  'member.remove',

  'invitation.read',
  'invitation.revoke',

  'session.read',
  'session.revoke',

  'audit.read',

  /** See forms and their published versions — everyone who fills one needs this. */
  'form.read',
  /**
   * Build, edit, clone and publish forms, and change who may fill them. A
   * published version can never be changed by anyone (migration 0006); this is
   * the permission to create the next one.
   */
  'form.manage',

  /**
   * Start, fill and submit a form, and read one's own submissions. The form's
   * own fill roles narrow this further: holding the permission is necessary,
   * being in the form's list is also necessary.
   */
  'submission.fill',
  /** Read every submission in the company, not only one's own. */
  'submission.read_all',
  /**
   * Reopen a submitted form so it can be corrected, and submit the correction.
   * Every reopening and every amendment is kept (migration 0008); this is the
   * permission to add to that history, not to rewrite it.
   */
  'submission.amend',

  /** See how much storage the company's files use, by kind. What the company is billed for. */
  'storage.read',

  /** Read customers, their contacts and sites — access notes included, since the job needs them. */
  'customer.read',
  /** Create and change customers, contacts and sites, and attach files to them. */
  'customer.manage',
  /** Configure job types: their forms, checklist, instructions and expected duration. */
  'job_type.manage',
  /** Read every work order, not only those one is assigned to. */
  'work_order.read_all',
  /** Create, edit, assign, dispatch, reschedule and cancel work orders, one at a time or in bulk. */
  'work_order.manage',
  /**
   * Work a job: travel, arrive, start, wait for parts, complete, tick its
   * checklist, comment and attach. Held by engineers for jobs they are assigned to.
   */
  'work_order.progress',
  /** Sign a completed job off, or send it back with a reason. */
  'work_order.review',
  /** Import customers, sites and work orders from CSV. */
  'import.run',

  /**
   * See what the company is paying for: the plan, the period, the card's
   * last failure. Separate from `billing.manage` because an admin may need to
   * know why uploads stopped without being able to change the subscription.
   */
  'billing.read',
  /**
   * Start a checkout, open the provider's portal, cancel. Owner only: the
   * person who signs up for a recurring charge should be the person who can
   * end it, and that is not everybody with an admin badge.
   */
  'billing.manage',
] as const;

export const permissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof permissionSchema>;

/**
 * The matrix. Every role lists every permission it holds, in full — no
 * inheritance, no spreading of one role into another.
 *
 * Inheritance is how a matrix silently grants something: widening `admin`
 * quietly widens everything built on top of it, and the diff that did it shows
 * one line in an unrelated role. Repetition here is the point.
 */
const MATRIX: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  owner: [
    'tenant.read',
    'tenant.update',
    'billing.read',
    'billing.manage',
    'member.read',
    'member.invite',
    'member.update_role',
    'member.suspend',
    'member.remove',
    'invitation.read',
    'invitation.revoke',
    'session.read',
    'session.revoke',
    'audit.read',
    'form.read',
    'form.manage',
    'submission.fill',
    'submission.read_all',
    'submission.amend',
    'storage.read',
    'customer.read',
    'customer.manage',
    'job_type.manage',
    'work_order.read_all',
    'work_order.manage',
    'work_order.progress',
    'work_order.review',
    'import.run',
  ],

  // Everything an owner can do except change the company itself. The line is
  // drawn at what an owner would want to be the only person able to alter:
  // company identity, and the subscription that pays for it (P17). An admin
  // may read the billing state, because "why did uploads stop" is a question
  // they will be asked before the owner is.
  admin: [
    'tenant.read',
    'billing.read',
    'member.read',
    'member.invite',
    'member.update_role',
    'member.suspend',
    'member.remove',
    'invitation.read',
    'invitation.revoke',
    'session.read',
    'session.revoke',
    'audit.read',
    'form.read',
    'form.manage',
    'submission.fill',
    'submission.read_all',
    'submission.amend',
    'storage.read',
    'customer.read',
    'customer.manage',
    'job_type.manage',
    'work_order.read_all',
    'work_order.manage',
    'work_order.progress',
    'work_order.review',
    'import.run',
  ],

  // Runs the day: needs to see who is available, not to change who they are.
  // Reads every submission to follow the day's work, and can fill a form on an
  // engineer's behalf; correcting a submitted one is left to owners and admins.
  // Owns work orders and customer records; signing a job off and configuring
  // job types are left to owners and admins too.
  dispatcher: [
    'tenant.read',
    'member.read',
    'form.read',
    'submission.fill',
    'submission.read_all',
    'customer.read',
    'customer.manage',
    'work_order.read_all',
    'work_order.manage',
    'work_order.progress',
  ],

  // Does the work. Sees colleagues so a job can be handed over, their own
  // submissions, and the jobs they are assigned to — with the customer and site
  // details those jobs need.
  engineer: [
    'tenant.read',
    'member.read',
    'form.read',
    'submission.fill',
    'customer.read',
    'work_order.progress',
  ],

  // Reads, and only reads: every submission and every job, and nothing to fill.
  viewer: [
    'tenant.read',
    'member.read',
    'form.read',
    'submission.read_all',
    'customer.read',
    'work_order.read_all',
  ],
});

/** Lookup form of {@link MATRIX}, written out so no cast is needed to build it. */
const BY_ROLE: Readonly<Record<Role, ReadonlySet<Permission>>> = Object.freeze({
  owner: new Set(MATRIX.owner),
  admin: new Set(MATRIX.admin),
  dispatcher: new Set(MATRIX.dispatcher),
  engineer: new Set(MATRIX.engineer),
  viewer: new Set(MATRIX.viewer),
});

/** True when `role` holds `permission`. */
export function can(role: Role, permission: Permission): boolean {
  return BY_ROLE[role].has(permission);
}

/** Every permission a role holds, for building a UI or debugging a denial. */
export function permissionsFor(role: Role): Permission[] {
  return [...MATRIX[role]];
}

/**
 * Thrown when a permission check fails.
 *
 * Carries the role and permission so the API can log precisely what was denied
 * while telling the caller only that it was.
 */
export class PermissionDeniedError extends Error {
  constructor(
    readonly role: Role,
    readonly permission: Permission,
  ) {
    super(`Role "${role}" does not hold permission "${permission}"`);
    this.name = 'PermissionDeniedError';
  }
}

/** {@link can}, but throwing. The form most call sites want. */
export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw new PermissionDeniedError(role, permission);
  }
}
