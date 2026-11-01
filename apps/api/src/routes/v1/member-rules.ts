import {
  customRolePermissions,
  type Grant,
  type Permission,
  permissionsFor,
  type Principal,
  type Role,
} from '@integr8/core';
import type { CompanyRole, TenantTransaction } from '@integr8/db';
import { ApiError } from '../../http/errors.js';

/**
 * Who may hand out what (ADR-0010).
 *
 * Rank decides most of it: nobody gives a role above their own. HR is the
 * exception rank cannot express — an HR manager, by role or by grant, reads
 * every salary and ID number, so only the owner makes or unmakes one, even
 * though an admin outranks the role.
 *
 * Since 1.2.4 (Low 10) "HR access" also covers a company role holding any of
 * {@link HR_ACCESS_PERMISSIONS}, and the rule covers every way of changing it:
 * changing the role of somebody whose old **or** new role has HR access,
 * giving or taking the HR grant, and removing somebody who has HR access, are
 * the owner's alone. An admin may still **suspend** such a person — the
 * emergency stop for a lost phone or a sudden departure — which is audited and
 * emailed to the owners; letting them back in is the owner's again.
 */

/**
 * The HR permissions that make somebody "an HR person": pay, ID and bank
 * numbers, employee records and payroll. The rest of the HR area (`hr.read`
 * job details, approving expenses, qualifications) is the built-in admin's
 * anyway, so holding it changes nothing about who may manage you.
 */
export const HR_ACCESS_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'hr.sensitive',
  'hr.manage',
  'payroll.run',
  'payroll.approve',
]);

/** The refusal, with its own code so every app can say it in its own words. */
export function hrOwnerOnly(message: string): ApiError {
  return new ApiError(403, 'hr_access_owner_only', message);
}

export function assertMayAssign(principal: Principal, role: Role | Grant): void {
  if (role === 'hr_manager' && principal.role !== 'owner') {
    throw hrOwnerOnly('Only the owner makes somebody an HR manager, or stops them being one.');
  }
}

/**
 * Whether a role — built-in, or a company role over its base — holds HR
 * access. The owner's role is left out: nobody below an owner acts on one
 * anyway, and an owner is not "an HR person" to be protected from admins.
 */
export function roleHasHrAccess(
  role: Role,
  companyRole?: Pick<CompanyRole, 'baseRole' | 'added' | 'removed'> | null,
): boolean {
  if (role === 'owner') {
    return false;
  }
  const held =
    companyRole === undefined || companyRole === null
      ? permissionsFor(role)
      : customRolePermissions(companyRole.baseRole, companyRole);
  return held.some((permission) => HR_ACCESS_PERMISSIONS.has(permission));
}

/** Whether this member's role or grants give them HR access. */
export async function memberHasHrAccess(
  tx: TenantTransaction,
  member: { userId: string; role: Role; customRoleId: string | null },
): Promise<{ byRole: boolean; byGrant: boolean }> {
  const companyRole =
    member.customRoleId === null ? undefined : await tx.tenantRoles.find(member.customRoleId);
  const grants = await tx.memberGrants.forUser(member.userId);
  return {
    byRole: roleHasHrAccess(member.role, companyRole),
    byGrant: member.role !== 'owner' && grants.includes('hr_manager'),
  };
}
