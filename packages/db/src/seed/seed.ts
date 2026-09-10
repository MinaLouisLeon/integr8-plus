import { appEnvironmentSchema, isProductionLike, optionalEnv } from '@integr8/core';
import { sql } from 'kysely';
import { getPlatformDataSource, getPlatformDb, withTenant } from '../connection.js';
import {
  DEMO_AUDIT_ACTIONS,
  DEMO_PLATFORM_USER,
  DEMO_TENANTS,
  type DemoTenant,
} from './demo-data.js';

export interface SeedOptions {
  /**
   * Delete the demo companies before recreating them.
   *
   * Off by default: seeding is additive, and a reset is a destructive act that
   * should be typed on purpose.
   */
  reset?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface SeedResult {
  tenants: { id: string; slug: string; members: number }[];
}

/**
 * Creates the two demo companies.
 *
 * Companies and platform users are written through the platform data source,
 * because creating a company is outside every company. Memberships and audit
 * entries are written through the *tenant* data source as `integr8_app`, which
 * means seeding exercises the same RLS policies and the same repository layer
 * that production traffic does. A seed that used owner privileges throughout
 * would happily create data the application could never read.
 */
export async function seedDemoData(options: SeedOptions = {}): Promise<SeedResult> {
  const env = options.env ?? process.env;
  const environment = appEnvironmentSchema.parse(optionalEnv('APP_ENV', 'development', env));

  if (isProductionLike(environment)) {
    throw new Error(
      `Refusing to seed demo data in the ${environment} environment. Demo companies in production are how a customer ends up looking at Sam Carter's fake job history.`,
    );
  }

  const platform = getPlatformDataSource();

  if (options.reset === true) {
    await resetDemoData();
  }

  if ((await platform.platformUsers.findByEmail(DEMO_PLATFORM_USER.email)) === undefined) {
    await platform.platformUsers.create(DEMO_PLATFORM_USER);
  }

  const result: SeedResult = { tenants: [] };

  for (const demo of DEMO_TENANTS) {
    await seedTenant(demo);
    result.tenants.push({ id: demo.id, slug: demo.slug, members: demo.members.length });
  }

  return result;
}

async function seedTenant(demo: DemoTenant): Promise<void> {
  const platform = getPlatformDataSource();

  const existing = await platform.tenants.findById(demo.id);
  if (existing === undefined) {
    // Fixed ids, so the insert names them rather than letting the default
    // generate one. This is the only place that is true.
    await getPlatformDb()
      .insertInto('tenants')
      .values({ id: demo.id, slug: demo.slug, name: demo.name })
      .execute();
  }

  await withTenant(demo.id, async (tx) => {
    for (const member of demo.members) {
      if ((await tx.tenantUsers.findByUserId(member.userId)) === undefined) {
        await tx.tenantUsers.create(member);
      }
    }

    const owner = demo.members.find((member) => member.role === 'owner') ?? demo.members[0];
    if (owner === undefined) {
      return;
    }

    if ((await tx.auditLog.count()) === 0) {
      for (const entry of DEMO_AUDIT_ACTIONS) {
        await tx.auditLog.append({
          actorKind: 'tenant_user',
          actorId: owner.userId,
          actorLabel: owner.email,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: demo.id,
          metadata: { seeded: true },
        });
      }
    }
  });
}

/**
 * Removes the demo companies.
 *
 * `audit_log` refuses deletes by trigger, for every role including the owner,
 * so clearing it means disabling that trigger for the duration. That is
 * deliberately awkward: it is the proof that the append-only guarantee is real
 * rather than a convention, and the only place in the codebase allowed to do
 * it is a development-only seed reset.
 */
async function resetDemoData(): Promise<void> {
  const ids = DEMO_TENANTS.map((demo) => demo.id);

  await getPlatformDb()
    .transaction()
    .execute(async (trx) => {
      await sql`alter table audit_log disable trigger audit_log_no_delete`.execute(trx);
      try {
        await trx.deleteFrom('audit_log').where('tenant_id', 'in', ids).execute();
      } finally {
        await sql`alter table audit_log enable trigger audit_log_no_delete`.execute(trx);
      }

      // tenant_users cascades from tenants.
      await trx.deleteFrom('tenants').where('id', 'in', ids).execute();
    });
}
