import { describe, expect, it } from 'vitest';
import {
  assertCan,
  assertHolds,
  can,
  holds,
  PERMISSIONS,
  PermissionDeniedError,
  permissionSchema,
  permissionsFor,
  permissionsHeld,
  GRANT_PERMISSIONS,
  STAFF_ONLY_PERMISSIONS,
  customRoleMayHold,
  customRolePermissions,
  type Permission,
} from './permissions.js';
import { ROLES } from './roles.js';

describe('the matrix is complete', () => {
  /**
   * The test that gives the matrix its value.
   *
   * Adding a permission without deciding it for every role is the failure mode
   * that matters: the new capability silently defaults to denied for four roles
   * and nobody notices until a customer reports that their dispatcher cannot do
   * their job. This makes every cell an explicit decision.
   */
  it('decides every permission for every role', () => {
    const undecided: string[] = [];

    for (const role of ROLES) {
      const held = new Set(permissionsFor(role));
      for (const permission of PERMISSIONS) {
        // `can` is total, so this cannot throw; what is being asserted is that
        // the answer came from the matrix rather than from a missing entry.
        const granted = can(role, permission);
        if (granted !== held.has(permission)) {
          undecided.push(`${role} / ${permission}`);
        }
      }
    }

    expect(undecided).toEqual([]);
  });

  it('grants nothing outside the declared vocabulary', () => {
    for (const role of ROLES) {
      for (const permission of permissionsFor(role)) {
        expect(permissionSchema.safeParse(permission).success).toBe(true);
      }
    }
  });

  it('rejects a permission that does not exist', () => {
    expect(permissionSchema.safeParse('tenant.delete').success).toBe(false);
  });
});

describe('who can do what', () => {
  it('gives an owner every permission', () => {
    for (const permission of PERMISSIONS) {
      expect(can('owner', permission), permission).toBe(true);
    }
  });

  it('withholds company settings and the subscription from an admin', () => {
    const withheld = PERMISSIONS.filter((permission) => !can('admin', permission));
    // An admin may read the billing state — "why did uploads stop" reaches
    // them first — but may not start or end a recurring charge (P17).
    // Reopening the books is the owner's (ADR-0009); pay and ID numbers are
    // the owner's and HR managers' (ADR-0010).
    expect(withheld).toEqual([
      'tenant.update',
      'branding.manage',
      'billing.manage',
      'role.manage',
      'ledger.unlock',
      'hr.sensitive',
      'hr.manage',
      'payroll.run',
      'payroll.approve',
      'eta.switch',
    ]);
  });

  it('keeps the ledger to owners and admins, read by viewers, and its reopening to owners', () => {
    expect(ROLES.filter((role) => can(role, 'ledger.read'))).toEqual(['owner', 'admin', 'viewer']);
    expect(ROLES.filter((role) => can(role, 'ledger.post'))).toEqual(['owner', 'admin']);
    expect(ROLES.filter((role) => can(role, 'ledger.manage'))).toEqual(['owner', 'admin']);
    expect(ROLES.filter((role) => can(role, 'ledger.unlock'))).toEqual(['owner']);
  });

  it('does not let a dispatcher manage members despite outranking an engineer', () => {
    expect(can('dispatcher', 'member.read')).toBe(true);
    expect(can('dispatcher', 'member.invite')).toBe(false);
    expect(can('dispatcher', 'member.update_role')).toBe(false);
  });

  it('lets those who do the work fill forms, and those who oversee it read every submission', () => {
    expect(ROLES.filter((role) => can(role, 'submission.fill'))).toEqual([
      'owner',
      'admin',
      'dispatcher',
      'engineer',
    ]);
    // An engineer reads their own submissions only; a viewer reads everything and fills nothing.
    expect(ROLES.filter((role) => can(role, 'submission.read_all'))).toEqual([
      'owner',
      'admin',
      'dispatcher',
      'viewer',
    ]);
  });

  it('keeps correcting a submitted form to owners and admins', () => {
    expect(ROLES.filter((role) => can(role, 'submission.amend'))).toEqual(['owner', 'admin']);
  });

  it('keeps audit and session control to owners and admins', () => {
    for (const permission of [
      'audit.read',
      'session.read',
      'session.revoke',
      'storage.read',
    ] as const) {
      expect(can('owner', permission)).toBe(true);
      expect(can('admin', permission)).toBe(true);
      expect(can('dispatcher', permission)).toBe(false);
      expect(can('engineer', permission)).toBe(false);
      expect(can('viewer', permission)).toBe(false);
    }
  });

  it('lets everyone read forms, and only owner and admin seats build or publish them', () => {
    // Filling a form needs the form. Building one happens from an owner's or
    // admin's seat — and, since Integr8 builds each company's forms, only with
    // staff in that seat; see `what Integr8 does for a company` below. A
    // dispatcher who could publish would be changing what every engineer is
    // asked, from the day's schedule screen.
    for (const role of ROLES) {
      expect(can(role, 'form.read'), role).toBe(true);
    }
    expect(ROLES.filter((role) => can(role, 'form.manage'))).toEqual(['owner', 'admin']);
  });

  it('lets every role read the company it belongs to', () => {
    for (const role of ROLES) {
      expect(can(role, 'tenant.read')).toBe(true);
    }
  });
});

describe('assertCan', () => {
  it('passes silently when the role holds the permission', () => {
    expect(() => {
      assertCan('admin', 'member.invite');
    }).not.toThrow();
  });

  it('throws with the role and permission attached, not just a message', () => {
    try {
      assertCan('engineer', 'member.remove');
      expect.unreachable('assertCan should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionDeniedError);
      const denied = error as PermissionDeniedError;
      expect(denied.role).toBe('engineer');
      expect(denied.permission).toBe('member.remove');
    }
  });
});

describe('the matrix cannot be mutated by a caller', () => {
  it('hands out a copy, not the live list', () => {
    const first = permissionsFor('viewer');
    first.push('tenant.update');

    expect(permissionsFor('viewer')).not.toContain('tenant.update');
    expect(can('viewer', 'tenant.update')).toBe(false);
  });
});

describe('the relationship to roleRank', () => {
  /**
   * P03 recorded that every permission's holders happened to form a prefix of
   * ROLES, and asked for that test to be deleted the day it stopped being true.
   * P08 is that day: a viewer reads every submission and an engineer, who
   * outranks a viewer, reads only their own. This keeps the lesson instead.
   */
  it('is not rank-monotone, so no call site may substitute a rank check for a permission', () => {
    expect(can('viewer', 'submission.read_all')).toBe(true);
    expect(can('engineer', 'submission.read_all')).toBe(false);
  });
});

describe('what Integr8 does for a company', () => {
  const owner = { role: 'owner' } as const;
  const staffAsOwner = { role: 'owner', impersonatedBy: { pid: 'p', gid: 'g' } } as const;
  const staffAsEngineer = { role: 'engineer', impersonatedBy: { pid: 'p', gid: 'g' } } as const;

  it('names exactly the form, job-type, branding and PDF-template configuration, and the e-invoicing switch', () => {
    expect([...STAFF_ONLY_PERMISSIONS].sort()).toEqual([
      'branding.manage',
      'document.design',
      'eta.switch',
      'form.manage',
      'job_type.manage',
    ]);
  });

  it('withholds those from the company\u2019s own owner, and nothing else', () => {
    const withheld = PERMISSIONS.filter((permission) => !holds(owner, permission));
    expect(withheld.sort()).toEqual([
      'branding.manage',
      'document.design',
      'eta.switch',
      'form.manage',
      'job_type.manage',
    ]);
    expect(permissionsHeld(owner)).toEqual(
      permissionsFor('owner').filter((permission) => !STAFF_ONLY_PERMISSIONS.has(permission)),
    );
  });

  it('grants them to staff sitting in that seat', () => {
    expect(holds(staffAsOwner, 'form.manage')).toBe(true);
    expect(permissionsHeld(staffAsOwner)).toEqual(permissionsFor('owner'));
  });

  it('never lifts staff above the seat they sit in', () => {
    // An impersonated engineer is still an engineer: the overlay only decides
    // who reaches a role's ceiling, it never raises it.
    expect(holds(staffAsEngineer, 'form.manage')).toBe(false);
    expect(holds(staffAsEngineer, 'member.invite')).toBe(false);
    expect(permissionsHeld(staffAsEngineer)).toEqual(permissionsFor('engineer'));
  });

  it('says why a denial happened, so the API can say who to ask', () => {
    try {
      assertHolds(owner, 'form.manage');
      expect.unreachable('assertHolds should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionDeniedError);
      expect((error as PermissionDeniedError).reason).toBe('staff_only');
    }
    try {
      assertHolds({ role: 'engineer' }, 'form.manage');
      expect.unreachable('assertHolds should have thrown');
    } catch (error) {
      expect((error as PermissionDeniedError).reason).toBe('role');
    }
    expect(() => {
      assertHolds(staffAsOwner, 'form.manage');
    }).not.toThrow();
  });
});

describe('HR, payroll and the store (ADR-0010, ADR-0011)', () => {
  const holders = (permission: Parameters<typeof can>[1]) =>
    ROLES.filter((role) => can(role, permission));

  it('ranks the two new roles between admin and dispatcher', () => {
    expect(ROLES).toEqual([
      'owner',
      'admin',
      'hr_manager',
      'inventory_manager',
      'dispatcher',
      'engineer',
      'viewer',
    ]);
  });

  it('keeps pay and ID numbers to owners and HR managers, and lets every member claim expenses', () => {
    expect(holders('hr.sensitive')).toEqual(['owner', 'hr_manager']);
    expect(holders('hr.manage')).toEqual(['owner', 'hr_manager']);
    expect(holders('payroll.run')).toEqual(['owner', 'hr_manager']);
    expect(holders('payroll.approve')).toEqual(['owner', 'hr_manager']);
    expect(holders('hr.read')).toEqual(['owner', 'admin', 'hr_manager']);
    expect(holders('expense.approve')).toEqual(['owner', 'admin', 'hr_manager']);
    expect(holders('expense.submit')).toEqual([...ROLES]);
  });

  it('gives manufacturing to owners, admins and inventory managers, read by viewers', () => {
    expect(holders('manufacturing.manage')).toEqual(['owner', 'admin', 'inventory_manager']);
    expect(holders('manufacturing.read')).toEqual([
      'owner',
      'admin',
      'inventory_manager',
      'viewer',
    ]);
  });

  it('leaves each new role nothing outside its area', () => {
    for (const role of ['hr_manager', 'inventory_manager'] as const) {
      for (const permission of [
        'member.invite',
        'member.update_role',
        'work_order.manage',
        'finance.read',
        'ledger.read',
        'crm.read',
        'purchasing.approve',
      ] as const) {
        expect(can(role, permission), `${role} ${permission}`).toBe(false);
      }
    }
    expect(can('hr_manager', 'inventory.read')).toBe(false);
    expect(can('inventory_manager', 'hr.read')).toBe(false);
  });

  it('adds a grant\u2019s area on top of a role, and nothing else', () => {
    const storekeeper = { role: 'dispatcher', grants: ['inventory_manager'] } as const;
    expect(holds(storekeeper, 'manufacturing.manage')).toBe(true);
    expect(holds({ role: 'dispatcher' }, 'manufacturing.manage')).toBe(false);
    expect(permissionsHeld(storekeeper)).toEqual([
      ...permissionsFor('dispatcher'),
      'manufacturing.read',
      'manufacturing.manage',
    ]);
    const payroller = { role: 'admin', grants: ['hr_manager'] } as const;
    expect(holds(payroller, 'payroll.run')).toBe(true);
    expect(() => {
      assertHolds(payroller, 'hr.sensitive');
    }).not.toThrow();
    expect(() => {
      assertHolds({ role: 'admin' }, 'hr.sensitive');
    }).toThrow(PermissionDeniedError);
  });

  it('never lets a grant hand out roles, grants or anything staff-only', () => {
    for (const permissions of Object.values(GRANT_PERMISSIONS)) {
      for (const permission of permissions) {
        expect(permission.startsWith('member.') || permission.startsWith('invitation.')).toBe(
          false,
        );
      }
    }
    expect(holds({ role: 'viewer', grants: ['hr_manager'] }, 'form.manage')).toBe(false);
  });
});

describe('custom roles (ADR-0013)', () => {
  const base = {
    role: 'dispatcher' as const,
    customRole: {
      id: '00000000-0000-4000-8000-000000000001',
      added: ['finance.issue', 'billing.manage', 'form.manage'] as Permission[],
      removed: ['customer.manage'] as Permission[],
    },
  };

  it('add to and take from their base role', () => {
    expect(holds(base, 'finance.issue')).toBe(true);
    expect(holds(base, 'customer.manage')).toBe(false);
    expect(holds(base, 'work_order.manage')).toBe(true);
  });

  it('never hold what is the owner’s or Integr8’s', () => {
    expect(holds(base, 'billing.manage')).toBe(false);
    expect(holds(base, 'form.manage')).toBe(false);
    expect(customRoleMayHold('role.manage')).toBe(false);
    expect(customRolePermissions('dispatcher', base.customRole)).not.toContain('billing.manage');
  });

  it('list what they hold for the screens', () => {
    const held = permissionsHeld(base);
    expect(held).toContain('finance.issue');
    expect(held).not.toContain('customer.manage');
    expect(held).not.toContain('billing.manage');
  });

  it('are ignored on the owner’s seat, and grants still add', () => {
    expect(holds({ ...base, role: 'owner' }, 'customer.manage')).toBe(true);
    expect(holds({ ...base, grants: ['inventory_manager'] }, 'inventory.manage')).toBe(true);
  });
});
