import { getPlatformDataSource, withTenant } from '@integr8/db';

/**
 * Keeps the sync change log from growing forever (P12).
 *
 * Touches older than the retention window are removed, company by company, and
 * the boundary remembered; a phone whose cursor is older than that downloads its
 * work afresh on its next pull. Safe to run on several workers at once.
 */
export async function runSyncMaintenance(options: {
  retentionDays: number;
}): Promise<{ touchesPruned: number; failures: { tenantId: string; message: string }[] }> {
  const report = { touchesPruned: 0, failures: [] as { tenantId: string; message: string }[] };
  for (const tenant of await getPlatformDataSource().tenants.list()) {
    try {
      report.touchesPruned += await withTenant(tenant.id, (tx) =>
        tx.sync.prune(options.retentionDays),
      );
    } catch (error) {
      report.failures.push({
        tenantId: tenant.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}
