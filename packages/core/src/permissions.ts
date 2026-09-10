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
  ],

  // Everything an owner can do except change the company itself. The line is
  // drawn at what an owner would want to be the only person able to alter:
  // company identity today, the subscription that pays for it from P17.
  admin: [
    'tenant.read',
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
  ],

  // Runs the day: needs to see who is available, not to change who they are.
  dispatcher: ['tenant.read', 'member.read'],

  // Does the work. Sees colleagues so a job can be handed over.
  engineer: ['tenant.read', 'member.read'],

  viewer: ['tenant.read', 'member.read'],
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
