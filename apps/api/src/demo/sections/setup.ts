import { day, type DemoContext } from '../context.js';

/**
 * The company itself: settings, branding, job types, custom roles, skills and
 * certificates.
 *
 * Adds to refs:
 *   jobTypes      { INSTALL, PPM, REPAIR, INSPECT, CALLOUT } → job type id
 *   qualifications { gas, electrical, height, fgas, firstAid } → qualification type id
 */
export async function seedSetup(ctx: DemoContext): Promise<void> {
  await ctx.call('owner', 'PATCH', '/v1/settings', {
    timezone: 'Africa/Cairo',
    currency: 'EGP',
    // Minutes from midnight, as the API takes them: 08:00 to 17:00.
    workDayStarts: 8 * 60,
    workDayEnds: 17 * 60,
    workingDays: [7, 1, 2, 3, 4],
    aiWebEnabled: true,
    aiDesktopEnabled: true,
    aiMobileEnabled: true,
  });
  // Branding is Integr8's to set, so staff do it.
  await ctx.attempt('staff', 'PATCH', '/v1/settings', {
    appsEnabled: true,
    brandColour: '#0F766E',
    shellColour: '#134E4A',
    defaultTheme: 'system',
  });
  ctx.log('settings and branding');

  // Job types: the onboarding five, given durations and checklists.
  const { items } = await ctx.call<{ items: { id: string; code: string }[] }>(
    'owner',
    'GET',
    '/v1/job-types',
  );
  const jobTypes: Record<string, string> = {};
  for (const item of items) {
    jobTypes[item.code] = item.id;
  }
  ctx.refs.jobTypes = jobTypes;

  const details: Record<string, Record<string, unknown>> = {
    INSTALL: {
      expectedDurationMinutes: 240,
      description: 'New equipment supplied and fitted.',
      checklist: [
        { label: 'Isolate supply and make safe' },
        { label: 'Fit and commission equipment' },
        { label: 'Demonstrate to the customer' },
      ],
    },
    PPM: {
      expectedDurationMinutes: 120,
      description: 'Scheduled preventive maintenance visit.',
      checklist: [
        { label: 'Visual inspection' },
        { label: 'Clean filters and coils' },
        { label: 'Record readings' },
      ],
    },
    REPAIR: {
      expectedDurationMinutes: 180,
      defaultPriority: 'high',
      checklist: [{ label: 'Diagnose fault' }, { label: 'Repair and test' }],
    },
    INSPECT: {
      expectedDurationMinutes: 90,
      checklist: [{ label: 'Inspect against the checklist' }, { label: 'Issue the certificate' }],
    },
    CALLOUT: { expectedDurationMinutes: 60, defaultPriority: 'urgent' },
  };
  for (const [code, patch] of Object.entries(details)) {
    const id = jobTypes[code];
    if (id !== undefined) {
      await ctx.attempt('staff', 'PATCH', `/v1/job-types/${id}`, patch);
    }
  }
  ctx.log(`${String(items.length)} job types`);

  // The company's own roles.
  await ctx.call('owner', 'POST', '/v1/roles', {
    name: 'Senior engineer',
    description: 'An engineer who can also review finished jobs.',
    baseRole: 'engineer',
    added: ['work_order.review', 'customer.read'],
  });
  await ctx.call('owner', 'POST', '/v1/roles', {
    name: 'Accounts clerk',
    description: 'Reads everything, raises and issues invoices.',
    baseRole: 'viewer',
    added: ['finance.read', 'finance.manage', 'finance.issue'],
  });
  ctx.log('2 custom roles');

  // Skills and certificates, who holds them, and which jobs need them.
  const types = [
    { key: 'gas', name: 'Gas safety certificate', kind: 'certificate' },
    { key: 'electrical', name: 'Electrical installation (Level 3)', kind: 'certificate' },
    { key: 'height', name: 'Working at height', kind: 'certificate' },
    { key: 'fgas', name: 'Refrigerant handling (F-Gas)', kind: 'certificate' },
    { key: 'firstAid', name: 'First aid at work', kind: 'certificate' },
    { key: 'hvac', name: 'HVAC diagnostics', kind: 'skill' },
  ] as const;
  const qualifications: Record<string, string> = {};
  for (const type of types) {
    const created = await ctx.call<{ id: string }>('owner', 'POST', '/v1/qualification-types', {
      name: type.name,
      kind: type.kind,
    });
    qualifications[type.key] = created.id;
  }
  ctx.refs.qualifications = qualifications;

  const held: [string, string, number | null][] = [
    // person, qualification, expires in days (null: no expiry)
    ['engineer1', 'gas', 400],
    ['engineer1', 'electrical', 220],
    ['engineer1', 'hvac', null],
    ['engineer2', 'fgas', 25], // expiring soon: shows on the warnings
    ['engineer2', 'height', 300],
    ['engineer2', 'hvac', null],
    ['engineer3', 'electrical', -10], // expired
    ['engineer3', 'firstAid', 500],
    ['engineer3', 'height', 120],
  ];
  for (const [index, [person, key, expires]] of held.entries()) {
    await ctx.call('owner', 'POST', '/v1/qualifications', {
      userId: ctx.people[person as 'engineer1'].userId,
      qualificationTypeId: qualifications[key],
      reference: `CERT-${String(1001 + index)}`,
      issuedOn: day(-365),
      ...(expires === null ? {} : { expiresOn: day(expires) }),
    });
  }
  await ctx.attempt('owner', 'PATCH', '/v1/qualification-settings', { warningDays: 30 });
  if (jobTypes.INSPECT !== undefined) {
    await ctx.call('owner', 'PUT', `/v1/job-types/${jobTypes.INSPECT}/qualifications`, {
      qualificationTypeIds: [qualifications.gas],
    });
  }
  if (jobTypes.INSTALL !== undefined) {
    await ctx.call('owner', 'PUT', `/v1/job-types/${jobTypes.INSTALL}/qualifications`, {
      qualificationTypeIds: [qualifications.electrical],
    });
  }
  ctx.log(`${String(types.length)} qualification types, ${String(held.length)} held`);
}
