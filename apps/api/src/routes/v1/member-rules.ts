import type { Grant, Principal, Role } from '@integr8/core';
import { forbidden } from '../../http/errors.js';

/**
 * Who may hand out what (ADR-0010).
 *
 * Rank decides most of it: nobody gives a role above their own. HR is the
 * exception rank cannot express — an HR manager, by role or by grant, reads
 * every salary and ID number, so only the owner makes or unmakes one, even
 * though an admin outranks the role.
 */
export function assertMayAssign(principal: Principal, role: Role | Grant): void {
  if (role === 'hr_manager' && principal.role !== 'owner') {
    throw forbidden('Only the owner makes somebody an HR manager, or stops them being one.');
  }
}
