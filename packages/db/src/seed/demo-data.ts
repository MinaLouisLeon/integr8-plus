import type { Role } from '@integr8/core';

/**
 * Two demo companies whose data looks confusable on purpose.
 *
 * Seeds that use obviously different names ("Acme" and "Zebra", ids `1` and
 * `999`) hide isolation bugs, because a leaked row looks wrong at a glance.
 * These two share a business name shape, a site name, a job reference format,
 * and one person — Sam Carter, the same auth identity, a member of both — so a
 * query missing its `tenant_id` returns something that looks entirely
 * plausible. That is the failure the isolation suite has to catch.
 *
 * The ids are fixed so tests can reference them without a lookup, and so a
 * developer recognises them in a log line.
 */

export interface DemoMember {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface DemoTenant {
  id: string;
  slug: string;
  name: string;
  members: DemoMember[];
}

/** Belongs to both companies, with a different role in each. */
export const SHARED_USER_ID = '00000000-0000-4000-8000-00000000c001';

export const DEMO_PLATFORM_USER = {
  id: '00000000-0000-4000-8000-00000000f001',
  email: 'super.admin@integr8.example',
  displayName: 'Platform Super Admin',
  // Stands in for an account the terminal command made, so the Staff screen
  // can be tried locally.
  canManageStaff: true,
} as const;

export const NORTHWIND: DemoTenant = {
  id: '00000000-0000-4000-8000-0000000000a1',
  slug: 'northwind-facilities',
  name: 'Northwind Facilities Ltd',
  members: [
    {
      userId: '00000000-0000-4000-8000-00000000a101',
      email: 'dana.okafor@northwind.example',
      displayName: 'Dana Okafor',
      role: 'owner',
    },
    {
      userId: '00000000-0000-4000-8000-00000000a102',
      email: 'priya.raman@northwind.example',
      displayName: 'Priya Raman',
      role: 'dispatcher',
    },
    {
      userId: SHARED_USER_ID,
      email: 'sam.carter@contractor.example',
      displayName: 'Sam Carter',
      role: 'engineer',
    },
  ],
};

export const SOUTHGATE: DemoTenant = {
  id: '00000000-0000-4000-8000-0000000000b2',
  slug: 'southgate-facilities',
  name: 'Southgate Facilities Ltd',
  members: [
    {
      userId: '00000000-0000-4000-8000-00000000b201',
      email: 'marek.novak@southgate.example',
      displayName: 'Marek Novak',
      role: 'owner',
    },
    {
      userId: '00000000-0000-4000-8000-00000000b202',
      email: 'priya.raman@southgate.example',
      displayName: 'Priya Raman',
      role: 'admin',
    },
    {
      // Same person, same auth identity, different company, different role.
      userId: SHARED_USER_ID,
      email: 'sam.carter@contractor.example',
      displayName: 'Sam Carter',
      role: 'admin',
    },
  ],
};

export const DEMO_TENANTS: readonly DemoTenant[] = [NORTHWIND, SOUTHGATE];

/** Audit lines written for each company, deliberately identical in shape. */
export const DEMO_AUDIT_ACTIONS = [
  { action: 'tenant.created', resourceType: 'tenant' },
  { action: 'tenant_user.invited', resourceType: 'tenant_user' },
  { action: 'tenant_user.accepted_invite', resourceType: 'tenant_user' },
] as const;
