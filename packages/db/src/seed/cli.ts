import { parseArgs } from 'node:util';
import { closeDatabase } from '../connection.js';
import { seedDemoData } from './seed.js';

const USAGE = `
Seed the two demo companies.

  pnpm --filter @integr8/db db:seed [--reset]

  --reset   Delete the demo companies first. Refuses to run outside
            development and test.
`.trim();

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      reset: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const result = await seedDemoData({ reset: values.reset });

  for (const tenant of result.tenants) {
    console.log(`seeded ${tenant.slug} (${tenant.id}) with ${String(tenant.members)} members`);
  }

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
