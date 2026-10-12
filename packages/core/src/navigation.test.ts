import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, NAV_SECTIONS, visibleNavigation } from './navigation.js';
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

  it('shows manufacturing under inventory, only with inventory on as well', () => {
    const inventory = (
      seat: Parameters<typeof permissionsHeld>[0],
      features?: Record<string, boolean>,
    ) =>
      visibleNavigation('desktop', permissionsHeld(seat), features)
        .find((group) => group.group === 'inventory')
        ?.sections.map((section) => section.key);
    const making = ['boms', 'assemblyOrders', 'materialPlans'];
    const both = { inventory: true, manufacturing: true };

    expect(inventory({ role: 'owner' }, both)).toEqual(expect.arrayContaining(making));
    expect(inventory({ role: 'viewer' }, both)).toEqual(expect.arrayContaining(making));
    expect(inventory({ role: 'dispatcher', grants: ['inventory_manager'] }, both)).toEqual(
      expect.arrayContaining(making),
    );
    expect(inventory({ role: 'engineer' }, both)).not.toContain('boms');
    // The module needs inventory: without it, nothing of manufacturing shows.
    expect(
      visibleNavigation('web', permissionsHeld({ role: 'owner' }), { manufacturing: true })
        .flatMap((group) => group.sections)
        .map((section) => section.key),
    ).not.toContain('boms');
    expect(inventory({ role: 'owner' }, { inventory: true })).not.toContain('assemblyOrders');
  });

  it('shows the ledger under accounting to owners, admins and viewers of a company that has it', () => {
    const groupsFor = (role: 'owner' | 'admin' | 'dispatcher' | 'engineer' | 'viewer') =>
      visibleNavigation('web', permissionsFor(role), { ledger: true });
    const accounting = (role: 'owner' | 'admin' | 'dispatcher' | 'engineer' | 'viewer') =>
      groupsFor(role)
        .find((group) => group.group === 'accounting')
        ?.sections.map((section) => section.key);

    expect(accounting('owner')).toEqual(['ledger', 'journals', 'ledgerReports']);
    expect(accounting('admin')).toEqual(['ledger', 'journals', 'ledgerReports']);
    expect(accounting('viewer')).toEqual(['ledger', 'journals', 'ledgerReports']);
    expect(accounting('dispatcher')).toBeUndefined();
    expect(accounting('engineer')).toBeUndefined();
    // Without the module, no accounting heading at all.
    expect(
      visibleNavigation('desktop', permissionsFor('owner'), { ledger: false }).map((g) => g.group),
    ).not.toContain('accounting');
    // Right after finance, in the menu's order.
    expect(NAV_GROUPS.indexOf('accounting')).toBe(NAV_GROUPS.indexOf('finance') + 1);
  });

  it('shows HR after accounting: the lists to those who may use them, a profile and claims to everybody', () => {
    const hr = (seat: Parameters<typeof permissionsHeld>[0], features?: Record<string, boolean>) =>
      visibleNavigation('web', permissionsHeld(seat), features)
        .find((group) => group.group === 'hr')
        ?.sections.map((section) => section.key);
    const everything = ['employees', 'expenseClaims', 'myProfile', 'myExpenses'];

    expect(hr({ role: 'owner' }, { hr: true })).toEqual(everything);
    expect(hr({ role: 'admin' }, { hr: true })).toEqual(everything);
    expect(hr({ role: 'hr_manager' }, { hr: true })).toEqual(everything);
    // Every member claims expenses back; only approvers see everybody's claims.
    expect(hr({ role: 'engineer' }, { hr: true })).toEqual(['myProfile', 'myExpenses']);
    expect(hr({ role: 'viewer' }, { hr: true })).toEqual(['myProfile', 'myExpenses']);
    // A grant on top of a role brings the lists with it.
    expect(hr({ role: 'dispatcher', grants: ['hr_manager'] }, { hr: true })).toEqual(everything);
    // Without the module, no HR heading at all, for anybody.
    expect(hr({ role: 'owner' })).toBeUndefined();
    expect(hr({ role: 'owner' }, { hr: false })).toBeUndefined();
    expect(NAV_GROUPS.indexOf('hr')).toBe(NAV_GROUPS.indexOf('accounting') + 1);
    // The same in the desktop app, which has every one of these screens.
    expect(
      visibleNavigation('desktop', permissionsHeld({ role: 'viewer' }), { hr: true })
        .flatMap((group) => group.sections)
        .map((section) => section.key),
    ).toEqual(expect.arrayContaining(['myProfile', 'myExpenses']));
  });
});
