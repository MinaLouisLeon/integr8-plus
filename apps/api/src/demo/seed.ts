import type { IdentityProvider } from '@integr8/auth';
import { type Role, toTenantId, toUserId } from '@integr8/core';
import { getPlatformDataSource, withTenant } from '@integr8/db';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../composition.js';
import { onboardCompany } from '../platform/onboarding.js';
import { type Actor, createContext, type DemoContext, type DemoPerson } from './context.js';
import { DEMO_SECTIONS } from './sections/index.js';

/**
 * One demo company with something in every section, for trying the product.
 *
 * The company is onboarded the way a super admin onboards a real one (the
 * same job types, settings row, subscription and storage bucket), then every
 * module is switched on and filled through the API as the company's own
 * people. See `context.ts` for why it goes through the API.
 */

export interface DemoSeedInput {
  app: FastifyInstance;
  services: Services;
  identity: Pick<IdentityProvider, 'createIdentity' | 'findByEmail'>;
  name: string;
  slug: string;
  ownerEmail: string;
  ownerName: string;
  /** Applied to every sign-in account the seed creates; existing accounts keep theirs. */
  password: string;
  /** Integr8 staff account that sets the company up (forms, job types, branding). */
  platformUserId: string;
  /** Section keys to run (plus the ones everything needs); all of them when absent. */
  only?: readonly string[];
}

export interface DemoSeedResult {
  tenantId: string;
  slug: string;
  people: (DemoPerson & { createdAccount: boolean })[];
  sections: { name: string; ok: boolean; error?: string }[];
  warnings: string[];
}

interface PersonSeed {
  key: DemoPerson['key'];
  first: string;
  last: string;
  role: Role;
}

/** The company's people, one per built-in role, three in the field. */
const PEOPLE: readonly PersonSeed[] = [
  { key: 'admin', first: 'Omar', last: 'Hassan', role: 'admin' },
  { key: 'hr', first: 'Laila', last: 'Mansour', role: 'hr_manager' },
  { key: 'store', first: 'Karim', last: 'Fathy', role: 'inventory_manager' },
  { key: 'dispatcher', first: 'Nour', last: 'Ibrahim', role: 'dispatcher' },
  { key: 'engineer1', first: 'Youssef', last: 'Adel', role: 'engineer' },
  { key: 'engineer2', first: 'Mariam', last: 'Saeed', role: 'engineer' },
  { key: 'engineer3', first: 'Ahmed', last: 'Tarek', role: 'engineer' },
  { key: 'viewer', first: 'Salma', last: 'Nabil', role: 'viewer' },
];

/** `owner@acme.com` → `omar.hassan+<slug>@acme.com`, so everybody lands in one mailbox. */
function memberEmail(ownerEmail: string, slug: string, seed: PersonSeed): string {
  const [local, domain] = ownerEmail.split('@') as [string, string];
  const base = local.split('+')[0] ?? local;
  return `${base}+${slug}-${seed.first.toLowerCase()}@${domain}`.toLowerCase();
}

export async function seedDemoCompany(input: DemoSeedInput): Promise<DemoSeedResult> {
  const platform = getPlatformDataSource();

  if ((await platform.tenants.findBySlug(input.slug)) !== undefined) {
    throw new Error(
      `A company with the slug "${input.slug}" already exists. Pass --slug with another one.`,
    );
  }

  // 1. Sign-in accounts. Found when the address already has one (its password
  //    is left alone), created otherwise.
  const accounts: { seed: PersonSeed | null; email: string; name: string; role: Role }[] = [
    { seed: null, email: input.ownerEmail.toLowerCase(), name: input.ownerName, role: 'owner' },
    ...PEOPLE.map((seed) => ({
      seed,
      email: memberEmail(input.ownerEmail, input.slug, seed),
      name: `${seed.first} ${seed.last}`,
      role: seed.role,
    })),
  ];

  const people = {} as Record<DemoPerson['key'], DemoPerson & { createdAccount: boolean }>;
  for (const account of accounts) {
    const existing = await input.identity.findByEmail(account.email);
    const identity =
      existing ?? (await input.identity.createIdentity(account.email, input.password));
    const key = account.seed?.key ?? 'owner';
    people[key] = {
      key,
      userId: identity.userId,
      email: account.email,
      displayName: account.name,
      role: account.role,
      createdAccount: existing === undefined,
    };
  }

  // 2. The company, onboarded like a real one: invoiced, so it starts active
  //    on the top plan with no trial to run out mid-test.
  const owner = people.owner;
  const onboarded = await onboardCompany({
    slug: input.slug,
    name: input.name,
    plan: 'enterprise',
    seats: null,
    billingMode: 'invoiced',
    ownerEmail: owner.email,
    ownerAccess: { kind: 'direct', userId: owner.userId, displayName: owner.displayName },
    websiteUrl: null,
    aiChannels: { web: true, desktop: true, mobile: true },
    onboardedBy: input.platformUserId as never,
    invitationTtlSeconds: 7 * 24 * 60 * 60,
    media: input.services.media,
    billing: { provider: 'demo', trialDays: 0 },
  });
  const tenantId = onboarded.tenant.id;
  console.log(`  company ${input.name} (${input.slug}, ${tenantId})`);
  if (onboarded.storage.error !== null) {
    console.log(`  storage bucket not ready yet: ${onboarded.storage.error}`);
  }

  // 3. Every module on. Each is a platform switch, normally flipped on the
  //    dashboard's company screen.
  const flags = await platform.settings.listFlags();
  for (const flag of flags) {
    await platform.settings.setFlag({
      tenantId,
      key: flag.key,
      enabled: true,
      updatedBy: input.platformUserId,
    });
  }
  console.log(`  switched on ${String(flags.length)} modules`);

  // 4. The rest of the people, active members straight away.
  await withTenant(tenantId, async (tx) => {
    for (const person of Object.values(people)) {
      if (person.key === 'owner') {
        continue;
      }
      await tx.tenantUsers.create({
        userId: person.userId,
        email: person.email,
        displayName: person.displayName,
        role: person.role,
        status: 'active',
      });
    }
  });
  console.log(`  added ${String(PEOPLE.length)} members`);

  // 5. A session for each of them, and one for Integr8 staff acting as the
  //    company, so each request is made by whoever would really make it.
  const tokens = {} as Record<Actor, string>;
  const sessionIds: string[] = [];
  for (const person of Object.values(people)) {
    const issued = await withTenant(tenantId, (tx) =>
      input.services.sessions.issue(tx, {
        tenantId: toTenantId(tenantId),
        userId: toUserId(person.userId),
        role: person.role,
        clientApp: 'web',
        deviceLabel: 'Demo company seed',
      }),
    );
    tokens[person.key] = issued.accessToken;
    sessionIds.push(issued.session.id);
  }
  const staff = await input.services.impersonation.start({
    platformUserId: input.platformUserId as never,
    tenantId: toTenantId(tenantId),
    reason: 'Demo company seed: setting up forms, job types and branding',
    clientApp: 'web',
  });
  tokens.staff = staff.tokens.accessToken;

  const ctx = createContext({ app: input.app, tenantId, people, tokens });

  // 6. The sections, in dependency order. One failing does not stop the rest:
  //    a company with nine full sections and one thin one is still useful.
  const sections: DemoSeedResult['sections'] = [];
  const chosen = DEMO_SECTIONS.filter(
    (section) =>
      input.only === undefined || section.always === true || input.only.includes(section.key),
  );
  for (const section of chosen) {
    console.log(`  ${section.name}`);
    try {
      await section.run(ctx);
      sections.push({ name: section.name, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`    FAILED: ${message}`);
      sections.push({ name: section.name, ok: false, error: message });
    }
  }

  // 7. Tidy up: the seed's own sessions and the staff grant end here, so the
  //    company's Sessions screen shows only real sign-ins.
  await input.services.impersonation.end(staff.grantId, toTenantId(tenantId), 'ended_by_admin');
  for (const sessionId of sessionIds) {
    await input.services.sessions.revoke(toTenantId(tenantId), sessionId, 'signed_out');
  }

  return {
    tenantId,
    slug: input.slug,
    people: Object.values(people),
    sections,
    warnings: ctx.warnings,
  };
}

export type { DemoContext };
