import { describe, expect, it } from 'vitest';
import {
  can,
  PERMISSIONS,
  PermissionDeniedError,
  assertCan,
  permissionSchema,
  permissionsFor,
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

  it('withholds only company settings from an admin', () => {
    const withheld = PERMISSIONS.filter((permission) => !can('admin', permission));
    expect(withheld).toEqual(['tenant.update']);
  });

  it('does not let a dispatcher manage members despite outranking an engineer', () => {
    expect(can('dispatcher', 'member.read')).toBe(true);
    expect(can('dispatcher', 'member.invite')).toBe(false);
    expect(can('dispatcher', 'member.update_role')).toBe(false);
  });

  it('gives dispatcher, engineer and viewer the same capabilities at this phase', () => {
    const dispatcher = permissionsFor('dispatcher').sort();
    expect(permissionsFor('engineer').sort()).toEqual(dispatcher);
    expect(permissionsFor('viewer').sort()).toEqual(dispatcher);
  });

  it('keeps audit and session control to owners and admins', () => {
    for (const permission of ['audit.read', 'session.read', 'session.revoke'] as const) {
      expect(can('owner', permission)).toBe(true);
      expect(can('admin', permission)).toBe(true);
      expect(can('dispatcher', permission)).toBe(false);
      expect(can('engineer', permission)).toBe(false);
      expect(can('viewer', permission)).toBe(false);
    }
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
   * As it stands, every permission's holders happen to form a prefix of ROLES,
   * so a rank comparison would currently give the same answers. That is a
   * coincidence of this phase's small vocabulary, not a property being
   * preserved: P10 adds `work_order.assign`, which a dispatcher needs and an
   * owner has no reason to hold.
   *
   * This test records the coincidence so that the day it stops being true is a
   * deliberate edit to this file rather than a surprise. Delete it then.
   */
  it('is currently rank-monotone, which is an observation and not a rule', () => {
    const gaps: string[] = [];

    for (const permission of PERMISSIONS) {
      const holders = ROLES.filter((role) => can(role, permission));
      const lowest = holders.at(-1);
      if (lowest === undefined) {
        continue;
      }
      for (const role of ROLES.slice(0, ROLES.indexOf(lowest))) {
        if (!can(role, permission)) {
          gaps.push(`${role} / ${permission}`);
        }
      }
    }

    expect(gaps).toEqual([]);
  });
});
