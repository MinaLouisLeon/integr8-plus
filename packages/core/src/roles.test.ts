import { describe, expect, it } from 'vitest';
import { ROLES, hasAtLeastRole, roleRank, roleSchema } from './roles.js';

describe('roles', () => {
  it('ranks owner highest and viewer lowest', () => {
    expect(roleRank('owner')).toBeGreaterThan(roleRank('admin'));
    expect(roleRank('admin')).toBeGreaterThan(roleRank('dispatcher'));
    expect(roleRank('dispatcher')).toBeGreaterThan(roleRank('engineer'));
    expect(roleRank('engineer')).toBeGreaterThan(roleRank('viewer'));
  });

  it('treats a role as satisfying itself', () => {
    for (const role of ROLES) {
      expect(hasAtLeastRole(role, role)).toBe(true);
    }
  });

  it('does not let a lower role satisfy a higher requirement', () => {
    expect(hasAtLeastRole('engineer', 'admin')).toBe(false);
    expect(hasAtLeastRole('admin', 'engineer')).toBe(true);
  });

  it('rejects an unknown role at the schema boundary', () => {
    expect(roleSchema.safeParse('superadmin').success).toBe(false);
    expect(roleSchema.safeParse('owner').success).toBe(true);
  });
});
