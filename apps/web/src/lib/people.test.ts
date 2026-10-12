import { describe, expect, it } from 'vitest';
import {
  invitableRoles,
  manageableGrants,
  mayChangeRole,
  mayGiveGrant,
  roleHoldsGrant,
  roleOptions,
} from './people';

/**
 * The people screen offers only what the API will do: an option it shows and
 * the server refuses is a person told "no" for something they were invited
 * to try.
 */

const OWNER_PERMISSIONS = ['member.read', 'member.update_role'];

describe('roles on offer', () => {
  it('lets only the owner invite or make an HR manager', () => {
    expect(invitableRoles('owner')).toEqual([
      'admin',
      'hr_manager',
      'inventory_manager',
      'dispatcher',
      'engineer',
      'viewer',
    ]);
    expect(invitableRoles('admin')).not.toContain('hr_manager');
    expect(invitableRoles('admin')).toContain('inventory_manager');
    expect(invitableRoles(undefined)).not.toContain('hr_manager');
    expect(invitableRoles('owner')).not.toContain('owner');
  });

  it('keeps a member’s own role in their picker, and HR out of it for anyone but the owner', () => {
    expect(roleOptions('admin', 'engineer')).not.toContain('hr_manager');
    expect(roleOptions('admin', 'hr_manager')).toContain('hr_manager');
    expect(roleOptions('owner', 'engineer')).toContain('hr_manager');
    expect(roleOptions('admin', 'engineer')[0]).toBe('owner');
  });

  it('lets only the owner move somebody off the HR manager role', () => {
    expect(mayChangeRole('admin', 'hr_manager')).toBe(false);
    expect(mayChangeRole('owner', 'hr_manager')).toBe(true);
    expect(mayChangeRole('admin', 'dispatcher')).toBe(true);
  });
});

describe('grants on offer', () => {
  it('gives the owner both, an admin the inventory one, and others none', () => {
    expect(manageableGrants('owner', OWNER_PERMISSIONS)).toEqual([
      'hr_manager',
      'inventory_manager',
    ]);
    expect(manageableGrants('admin', OWNER_PERMISSIONS)).toEqual(['inventory_manager']);
    expect(manageableGrants('dispatcher', ['member.read'])).toEqual([]);
  });

  it('does not offer a grant the role already holds in full', () => {
    expect(roleHoldsGrant('owner', 'hr_manager')).toBe(true);
    expect(roleHoldsGrant('hr_manager', 'hr_manager')).toBe(true);
    // An admin reads HR but not pay or ID numbers: the grant adds those.
    expect(roleHoldsGrant('admin', 'hr_manager')).toBe(false);
    expect(roleHoldsGrant('admin', 'inventory_manager')).toBe(true);
    expect(roleHoldsGrant('dispatcher', 'inventory_manager')).toBe(false);
  });

  it('offers a grant only to an active member who lacks it', () => {
    const dispatcher = { role: 'dispatcher' as const, status: 'active', grants: [] };
    expect(mayGiveGrant(dispatcher, 'inventory_manager')).toBe(true);
    expect(mayGiveGrant({ ...dispatcher, status: 'suspended' }, 'inventory_manager')).toBe(false);
    expect(
      mayGiveGrant({ ...dispatcher, grants: ['inventory_manager'] }, 'inventory_manager'),
    ).toBe(false);
    expect(mayGiveGrant({ ...dispatcher, role: 'admin' }, 'inventory_manager')).toBe(false);
  });
});
