import { can, type Grant, GRANT_PERMISSIONS, GRANTS, type Role, ROLES } from '@integr8/core';

/**
 * What the people screen offers whom (ADR-0010), as pure functions so the
 * rules are testable without a browser. The API enforces every one of these;
 * the screen follows them so it never offers what will be refused.
 *
 * - Rank decides most of it, and the API says so when it refuses.
 * - The HR manager role and grant are the owner's alone to give or take: an
 *   HR manager reads every salary and ID number.
 * - A grant adds to a role only what the role lacks; offering one the role
 *   already holds in full would be refused (`role_holds_grant`).
 */

/** Roles an invitation may carry: never owner, and HR manager only from the owner. */
export function invitableRoles(viewer: Role | undefined): Role[] {
  return ROLES.filter((role) => role !== 'owner' && (role !== 'hr_manager' || viewer === 'owner'));
}

/**
 * Roles offered in a member's role picker. HR manager only to the owner, but
 * always the member's own role, so the picker shows what they are.
 */
export function roleOptions(viewer: Role | undefined, current: Role): Role[] {
  return ROLES.filter((role) => role === current || role !== 'hr_manager' || viewer === 'owner');
}

/** Whether the viewer may move this member off their role: an HR manager only by the owner. */
export function mayChangeRole(viewer: Role | undefined, current: Role): boolean {
  return current !== 'hr_manager' || viewer === 'owner';
}

/** The grants this viewer gives and takes back: none without `member.update_role`, HR only the owner. */
export function manageableGrants(
  viewer: Role | undefined,
  permissions: readonly string[],
): Grant[] {
  if (!permissions.includes('member.update_role')) {
    return [];
  }
  return GRANTS.filter((grant) => grant !== 'hr_manager' || viewer === 'owner');
}

/** True when the role already holds everything the grant would add. */
export function roleHoldsGrant(role: Role, grant: Grant): boolean {
  return GRANT_PERMISSIONS[grant].every((permission) => can(role, permission));
}

/** Whether a grant can be given to this member now: active, and their role lacks some of it. */
export function mayGiveGrant(
  member: { role: Role; status: string; grants: readonly Grant[] },
  grant: Grant,
): boolean {
  return (
    member.status === 'active' &&
    !member.grants.includes(grant) &&
    !roleHoldsGrant(member.role, grant)
  );
}
