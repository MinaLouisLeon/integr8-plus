import { NAV_SECTIONS, PERMISSIONS } from '@integr8/core';
import { describe, expect, it } from 'vitest';
import { desktopNavigation, NAV_ROUTES, routeChrome, sectionPathFor } from './navigation';

/**
 * The menu model is shared; what is this app's own is where each section lives
 * and how a route on screen finds its way back to the section it belongs to.
 * A section without a route is a menu row that goes nowhere, and a detail
 * screen with no way back is a dead end — both are caught here.
 */

describe('mapping the shared menu onto hash routes', () => {
  it('gives every desktop section a route and no web-only section one', () => {
    for (const section of NAV_SECTIONS) {
      const route = NAV_ROUTES[section.path];
      if (section.webOnly === true) {
        expect(route, section.key).toBeNull();
      } else {
        expect(route, section.key).toMatch(/^\/[a-z-/]+$/u);
      }
    }
  });

  it('shows a staff seat the branding screen and a bare seat only what needs no permission', () => {
    const everything = desktopNavigation(PERMISSIONS);
    const keys = everything.flatMap((group) => group.sections.map((section) => section.key));
    expect(keys).toContain('branding');
    expect(keys).toContain('forms');
    expect(keys).not.toContain('billing');

    const bare = desktopNavigation([]);
    const bareKeys = bare.flatMap((group) => group.sections.map((section) => section.key));
    expect(bareKeys).toEqual(['dashboard', 'workOrders', 'jobTypes']);
    expect(bare.find((group) => group.group === 'setup')?.sections.map((s) => s.to)).toEqual([
      '/settings/job-types',
    ]);
  });
});

describe('finding the section a route is in', () => {
  it('matches a root, a nested route and a trailing slash', () => {
    expect(sectionPathFor('/work-orders')).toBe('workOrders');
    expect(sectionPathFor('/work-orders/')).toBe('workOrders');
    expect(sectionPathFor('/work-orders/new')).toBe('workOrders');
    expect(sectionPathFor('/work-orders/abc')).toBe('workOrders');
    expect(sectionPathFor('/forms/f1/versions/v2')).toBe('forms');
    expect(sectionPathFor('/settings/job-types')).toBe('jobTypes');
    expect(sectionPathFor('/settings/branding')).toBe('branding');
  });

  it('reads a site as part of its customers', () => {
    expect(sectionPathFor('/sites/s1')).toBe('customers');
  });

  it('does not mistake a longer word for a shorter route', () => {
    expect(sectionPathFor('/formsx')).toBeUndefined();
    expect(sectionPathFor('/')).toBeUndefined();
    expect(sectionPathFor('/sign-in')).toBeUndefined();
  });
});

describe('what the top bar needs', () => {
  it('offers no way back from a section root', () => {
    expect(routeChrome('/dashboard')).toEqual({ section: 'dashboard', back: undefined });
    expect(routeChrome('/settings/branding')).toEqual({ section: 'branding', back: undefined });
  });

  it('leads a nested route back to its section', () => {
    expect(routeChrome('/work-orders/42')).toEqual({
      section: 'workOrders',
      back: { to: '/work-orders', section: 'workOrders' },
    });
    expect(routeChrome('/sites/s1')).toEqual({
      section: 'customers',
      back: { to: '/customers', section: 'customers' },
    });
    expect(routeChrome('/forms/f1/versions/v2').back).toEqual({ to: '/forms', section: 'forms' });
  });

  it('leads an unknown settings route back to the dashboard', () => {
    expect(routeChrome('/settings/elsewhere')).toEqual({
      section: undefined,
      back: { to: '/dashboard', section: 'dashboard' },
    });
  });
});
