import {
  closeDatabase,
  configureDatabase,
  getPlatformDataSource,
  loadDatabaseConfig,
  withTenant,
} from '@integr8/db';
import { buildMediaStorage } from '../composition.js';
import { loadApiConfig } from '../config.js';
import { fetchBucketAnalytics } from './cloudflare-usage.js';
import { runMediaMaintenance } from './maintenance.js';
import { provisionTenantStorage, purgeTenantStorage } from './tenant-storage.js';

/**
 * Operating company storage by hand.
 *
 *   pnpm --filter @integr8/api storage provision <tenant-id>|--all
 *   pnpm --filter @integr8/api storage maintain [<tenant-id>]
 *   pnpm --filter @integr8/api storage verify <tenant-id>
 *   pnpm --filter @integr8/api storage purge <tenant-id> --yes-delete-every-file
 *
 * `verify` compares three figures for one company: what the ledger's usage
 * rollup says, what listing the bucket adds up to, and what Cloudflare's
 * analytics report — the number the bill comes from. The first two must match
 * exactly; Cloudflare's lags by however long since it last sampled the bucket.
 *
 * Every command runs as the schema owner. `purge` cannot be undone.
 */

const USAGE = `Usage:
  storage provision <tenant-id>|--all
  storage maintain [<tenant-id>]
  storage verify <tenant-id>
  storage purge <tenant-id> --yes-delete-every-file`;

async function main(argv: readonly string[]): Promise<number> {
  const [command, target, flag] = argv;
  const config = loadApiConfig();
  configureDatabase(loadDatabaseConfig(process.env));
  const media = buildMediaStorage(config);
  const platform = getPlatformDataSource();
  const print = (value: unknown) => {
    console.log(JSON.stringify(value, null, 2));
  };

  switch (command) {
    case 'provision': {
      if (target === undefined) {
        break;
      }
      const tenants =
        target === '--all' ? (await platform.tenants.list()).map((tenant) => tenant.id) : [target];
      for (const tenantId of tenants) {
        print(await provisionTenantStorage(media, tenantId));
      }
      return 0;
    }

    case 'maintain': {
      const report = await runMediaMaintenance({
        media,
        ...(target === undefined ? {} : { tenantIds: [target] }),
      });
      print(report);
      return report.failures.length === 0 ? 0 : 1;
    }

    case 'verify': {
      if (target === undefined) {
        break;
      }
      const location = await platform.storage.find(target);
      if (location === undefined) {
        console.error(`Company ${target} has no storage.`);
        return 1;
      }
      const ledger = await withTenant(target, (tx) => tx.files.usage());
      let bucketBytes = 0;
      let bucketObjects = 0;
      if (location.purgedAt === null) {
        for await (const object of media.open(location.bucket).list()) {
          bucketBytes += object.byteSize;
          bucketObjects += 1;
        }
      }
      const cloudflare =
        media.provider === 'r2' &&
        config.CLOUDFLARE_ACCOUNT_ID !== undefined &&
        config.CLOUDFLARE_API_TOKEN !== undefined
          ? await fetchBucketAnalytics({
              accountId: config.CLOUDFLARE_ACCOUNT_ID,
              apiToken: config.CLOUDFLARE_API_TOKEN,
              bucket: location.bucket,
            })
          : undefined;
      const matches = ledger.totalBytes === bucketBytes && ledger.totalObjects === bucketObjects;
      print({
        bucket: location.bucket,
        ledger: { bytes: ledger.totalBytes, objects: ledger.totalObjects },
        bucketListing: { bytes: bucketBytes, objects: bucketObjects },
        cloudflare:
          cloudflare === undefined
            ? null
            : {
                bytes: cloudflare.payloadSize,
                objects: cloudflare.objectCount,
                sampledAt: cloudflare.sampledAt.toISOString(),
                matchesLedger:
                  cloudflare.payloadSize === ledger.totalBytes &&
                  cloudflare.objectCount === ledger.totalObjects,
              },
        ledgerMatchesBucket: matches,
      });
      return matches ? 0 : 1;
    }

    case 'purge': {
      if (target === undefined) {
        break;
      }
      if (flag !== '--yes-delete-every-file') {
        console.error(
          'Purging deletes every file this company has, from storage and from the ledger, and cannot be undone.\nRun again with --yes-delete-every-file.',
        );
        return 1;
      }
      print(await purgeTenantStorage(media, target));
      return 0;
    }
  }

  console.error(USAGE);
  return 2;
}

main(process.argv.slice(2))
  .then(async (code) => {
    await closeDatabase();
    process.exitCode = code;
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    await closeDatabase();
    process.exitCode = 1;
  });
