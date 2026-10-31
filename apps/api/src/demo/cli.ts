import { FakeIdentityProvider } from '@integr8/auth';
import { isProductionLike } from '@integr8/core';
import { closeDatabase, getPlatformDataSource } from '@integr8/db';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { buildServices } from '../composition.js';
import { loadApiConfig } from '../config.js';
import { createLogger } from '../http/logger.js';
import { allRoutes } from '../routes/index.js';
import { buildServer } from '../server.js';
import { seedDemoCompany } from './seed.js';

/**
 * Creates one demo company, full of sample data in every section, for testing.
 *
 *   node dist/demo/cli.js --owner-email you@example.com
 *
 * It signs nothing in on your behalf and changes no existing company: it makes
 * a new company with a new slug, its people (you as the owner, plus one person
 * for every other role), and then fills customers, jobs, CRM, sales, stock,
 * purchasing, manufacturing, assets, contracts, finance, the ledger, HR,
 * payroll and the rest through the API, as those people.
 */

const USAGE = `
Create a demo company full of sample data, for testing.

  node dist/demo/cli.js --owner-email <you@example.com> [options]
  pnpm --filter @integr8/api demo-company --owner-email <you@example.com> [options]

Options:
  --owner-email <email>    Required. You: the company's owner. If this address can
                           already sign in, it keeps its password.
  --owner-name <name>      Your name in the company. Default: "Demo Owner".
  --name <name>            Company name. Default: "Nile Delta Facilities (Demo)".
  --slug <slug>            Company slug. Default: demo-<random>.
  --password <password>    Password for every new sign-in account. Default: generated
                           and printed once.
  --platform-user <email>  The Integr8 staff account recorded as setting the company
                           up. Default: the first active one.
  --confirm-production     Required when APP_ENV is staging or production.
  --without-sign-in        Do not create sign-in accounts (no Auth container needed). The
                           people exist in the company but nobody can sign in as
                           them. Refused in staging and production.
  --only <keys>            Only these sections (comma-separated), plus setup,
                           customers and stock, which the rest need. Keys:
                           ledger-setup, purchasing, manufacturing, assets,
                           field-service, forms, crm, sales, hr, finance,
                           e-invoicing, ledger, holds.
  -h, --help               This text.

Other members get addresses like <you>+<slug>-omar@<your domain>, so any mail
for them reaches your own mailbox.
`.trim();

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'owner-email': { type: 'string' },
      'owner-name': { type: 'string', default: 'Demo Owner' },
      name: { type: 'string', default: 'Nile Delta Facilities (Demo)' },
      slug: { type: 'string' },
      password: { type: 'string' },
      'platform-user': { type: 'string' },
      'confirm-production': { type: 'boolean', default: false },
      'without-sign-in': { type: 'boolean', default: false },
      only: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const ownerEmail = values['owner-email']?.trim();
  if (ownerEmail === undefined || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) {
    console.error(USAGE);
    return 1;
  }

  const slug = values.slug ?? `demo-${randomUUID().slice(0, 6)}`;
  if (!/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/.test(slug)) {
    console.error('--slug must be 3 to 48 lower-case letters, digits and hyphens.');
    return 1;
  }

  // Every request the seed makes goes through the real routes in this
  // process, so the API's own per-company rate limit is lifted for it.
  const config = loadApiConfig({
    ...process.env,
    API_TENANT_RATE_LIMIT: '1000000',
    API_IP_RATE_LIMIT: '1000000',
  });

  if (isProductionLike(config.APP_ENV)) {
    if (!values['confirm-production']) {
      console.error(
        `APP_ENV is ${config.APP_ENV}. This adds a demo company with made-up customers, invoices and payroll to this database. Run again with --confirm-production if that is what you want.`,
      );
      return 1;
    }
    if (values['without-sign-in']) {
      console.error('--without-sign-in is for development databases only.');
      return 1;
    }
  }

  const password = values.password ?? `Demo-${randomBytes(9).toString('base64url')}`;

  const services = await buildServices({
    config,
    ...(values['without-sign-in'] ? { identity: new FakeIdentityProvider() } : {}),
  });
  const app = buildServer({
    config,
    services,
    routes: allRoutes(config),
    logger: createLogger({
      level: 'error',
      service: 'integr8-demo-seed',
      release: config.API_RELEASE,
    }),
  });
  await app.ready();

  try {
    const platformUsers = (await getPlatformDataSource().platformUsers.list()).filter(
      (account) => account.isActive,
    );
    const wanted = values['platform-user']?.toLowerCase();
    let platformUser =
      wanted === undefined
        ? platformUsers[0]
        : platformUsers.find((account) => account.email.toLowerCase() === wanted);
    if (platformUser === undefined) {
      if (wanted !== undefined) {
        console.error(
          `No active platform account ${wanted}. See: node dist/platform/admin-cli.js list`,
        );
        return 1;
      }
      // A fresh database with no staff yet. The seed needs somebody to set the
      // company up as; this account has no password and cannot sign in.
      platformUser = await getPlatformDataSource().platformUsers.create({
        email: 'demo-seed@integr8.invalid',
        displayName: 'Demo seed',
        canManageStaff: false,
      });
    }

    console.log(`Seeding a demo company (APP_ENV=${config.APP_ENV})`);
    const result = await seedDemoCompany({
      app,
      services,
      identity: services.identity,
      name: values.name,
      slug,
      ownerEmail,
      ownerName: values['owner-name'],
      password,
      platformUserId: platformUser.id,
      ...(values.only === undefined
        ? {}
        : { only: values.only.split(',').map((key) => key.trim()) }),
    });

    console.log('');
    console.log(`Done: ${values.name} (slug ${result.slug}, id ${result.tenantId})`);
    console.log('');
    console.log('Sign in as any of these:');
    for (const person of result.people) {
      const credential = values['without-sign-in']
        ? '(no sign-in account)'
        : person.createdAccount
          ? `password ${password}`
          : '(existing account: its own password)';
      console.log(`  ${person.role.padEnd(18)} ${person.email.padEnd(48)} ${credential}`);
    }

    const failed = result.sections.filter((section) => !section.ok);
    if (result.warnings.length > 0) {
      console.log('');
      console.log(`${String(result.warnings.length)} item(s) were skipped:`);
      for (const warning of result.warnings) {
        console.log(`  - ${warning}`);
      }
    }
    if (failed.length > 0) {
      console.log('');
      console.log(`${String(failed.length)} section(s) did not finish:`);
      for (const section of failed) {
        console.log(`  - ${section.name}: ${section.error ?? ''}`);
      }
      return 2;
    }
    return 0;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
