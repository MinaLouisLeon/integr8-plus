import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS, visibleNavigation } from './navigation.js';
import { permissionsFor, permissionsHeld } from './permissions.js';

describe('the dashboard map', () => {
  it('gives every section a unique key', () => {
    const keys = NAV_SECTIONS.map((section) => section.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('shows an owner every section an app has, and drops empty groups', () => {
    const web = visibleNavigation('web', permissionsFor('owner')).flatMap((g) => g.sections);
    expect(web.map((s) => s.key)).toContain('billing');
    expect(web.map((s) => s.key)).not.toContain('forms');
    const desktop = visibleNavigation('desktop', permissionsFor('owner')).flatMap(
      (g) => g.sections,
    );
    expect(desktop.map((s) => s.key)).toContain('forms');
    expect(desktop.map((s) => s.key)).not.toContain('billing');
  });

  it('shows branding only to staff sitting in the seat', () => {
    const owner = visibleNavigation('desktop', permissionsHeld({ role: 'owner' }));
    expect(owner.flatMap((g) => g.sections).map((s) => s.key)).not.toContain('branding');
    const staff = visibleNavigation(
      'desktop',
      permissionsHeld({ role: 'owner', impersonatedBy: { pid: 'p', gid: 'g' } }),
    );
    expect(staff.flatMap((g) => g.sections).map((s) => s.key)).toContain('branding');
  });

  it('shows a viewer no imports, no timesheets and no empty operations heading', () => {
    const groups = visibleNavigation('web', permissionsFor('viewer'));
    const keys = groups.flatMap((g) => g.sections).map((s) => s.key);
    expect(keys).not.toContain('imports');
    expect(keys).not.toContain('timesheets');
    expect(keys).toContain('customers');
    for (const group of groups) {
      expect(group.sections.length).toBeGreaterThan(0);
    }
  });

  it('shows the CRM only to a company that has it, and only to seats that may read it', () => {
    const keysFor = (
      role: 'owner' | 'dispatcher' | 'engineer' | 'viewer',
      features?: Record<string, boolean>,
    ) =>
      visibleNavigation('web', permissionsFor(role), features)
        .flatMap((g) => g.sections)
        .map((s) => s.key);

    // A caller that passes no flags shows no module-gated section at all.
    expect(keysFor('owner')).not.toContain('crm');
    expect(keysFor('owner', { crm: false })).not.toContain('crm');
    expect(keysFor('owner', { crm: true })).toContain('crm');
    expect(keysFor('dispatcher', { crm: true })).toEqual(
      expect.arrayContaining(['crm', 'leads', 'opportunities', 'activities']),
    );
    expect(keysFor('owner', { crm: false })).not.toContain('opportunities');
    // Inventory: engineers see it (their van), viewers too; nobody without the module.
    expect(keysFor('engineer', { inventory: true })).toEqual(
      expect.arrayContaining(['inventory', 'items', 'stockLocations']),
    );
    expect(keysFor('owner', { crm: true })).not.toContain('inventory');
    expect(keysFor('viewer', { crm: true })).toContain('crm');
    expect(keysFor('engineer', { crm: true })).not.toContain('crm');
  });
});
