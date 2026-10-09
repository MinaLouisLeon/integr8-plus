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
  STAFF_ONLY_PERMISSIONS,
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
    expect(withheld).toEqual(['tenant.update', 'branding.manage', 'billing.manage']);
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

  it('names exactly the form, job-type and branding configuration', () => {
    expect([...STAFF_ONLY_PERMISSIONS].sort()).toEqual([
      'branding.manage',
      'form.manage',
      'job_type.manage',
    ]);
  });

  it('withholds those from the company\u2019s own owner, and nothing else', () => {
    const withheld = PERMISSIONS.filter((permission) => !holds(owner, permission));
    expect(withheld).toEqual(['branding.manage', 'form.manage', 'job_type.manage']);
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
