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
   *
   * Staff-only (see {@link STAFF_ONLY_PERMISSIONS}): Integr8 builds each
   * company's forms; the company's own owners and admins read and fill them.
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
  /**
   * Configure job types: their forms, checklist, instructions and expected
   * duration. Staff-only, like `form.manage`, and for the same reason.
   */
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
    /**
     * `role`: the role never holds it. `staff_only`: the role's seat would,
     * but only with Integr8 staff in it (see {@link STAFF_ONLY_PERMISSIONS}).
     */
    readonly reason: 'role' | 'staff_only' = 'role',
  ) {
    super(
      reason === 'staff_only'
        ? `Permission "${permission}" is held only by Integr8 staff acting for the company`
        : `Role "${role}" does not hold permission "${permission}"`,
    );
    this.name = 'PermissionDeniedError';
  }
}

/** {@link can}, but throwing. The form most call sites want. */
export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw new PermissionDeniedError(role, permission);
  }
}

// ---------------------------------------------------------------------------
// What Integr8 does for a company, rather than the company for itself
// ---------------------------------------------------------------------------

/**
 * Permissions that only Integr8 staff hold, however senior the seat.
 *
 * The product is sold with its forms and job types built by Integr8 for each
 * company: a company's people fill forms and work jobs, and ask Integr8 when
 * something about either needs to change. So an owner's `form.manage` in the
 * matrix above is the *ceiling* for the seat, and this set says which of those
 * capabilities are only reached when the seat is held by a staff member —
 * which, in a token, is an impersonation claim (`imp`), since staff never
 * become members of a company (`tenant_users_reject_platform_user`).
 *
 * Kept as an overlay rather than removed from the matrix so that the matrix
 * still answers "what can this role's seat do when Integr8 sits in it", and
 * so an impersonated engineer gains nothing: the ceiling still applies.
 */
export const STAFF_ONLY_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'form.manage',
  'job_type.manage',
]);

/**
 * The part of a principal that decides what it may actually do: the role
 * (its ceiling) and whether Integr8 staff are behind it. Structurally a
 * `Principal`, so one can be passed as is.
 */
export interface Seat {
  readonly role: Role;
  /** Present when a super admin is acting through this seat. */
  readonly impersonatedBy?: object | undefined;
}

/** True when Integr8 staff hold the seat. */
export function isStaffSeat(seat: Seat): boolean {
  return seat.impersonatedBy !== undefined;
}

/**
 * True when this seat may do this now: the role holds the permission, and the
 * permission is either open to the company or the seat is held by staff.
 *
 * Call sites that have a principal use this rather than {@link can}; `can`
 * remains the matrix lookup for code that only has a role in hand (such as a
 * form's fill roles).
 */
export function holds(seat: Seat, permission: Permission): boolean {
  return (
    can(seat.role, permission) && (!STAFF_ONLY_PERMISSIONS.has(permission) || isStaffSeat(seat))
  );
}

/** Every permission a seat holds right now, for `/v1/me` and the screens built on it. */
export function permissionsHeld(seat: Seat): Permission[] {
  return permissionsFor(seat.role).filter((permission) => holds(seat, permission));
}

/** {@link holds}, but throwing, with the reason for the denial attached. */
export function assertHolds(seat: Seat, permission: Permission): void {
  if (!can(seat.role, permission)) {
    throw new PermissionDeniedError(seat.role, permission);
  }
  if (!holds(seat, permission)) {
    throw new PermissionDeniedError(seat.role, permission, 'staff_only');
  }
}
