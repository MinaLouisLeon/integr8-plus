import { getPlatformDataSource, withTenant } from '@integr8/db';
import {
  type HrKeyring,
  openWithKeyring,
  SEALED_FIELDS,
  type SealedFieldName,
  sealField,
} from './sealed-fields.js';

/**
 * Re-seals every company's sensitive HR numbers under the current key, after
 * a rotation (`admin-cli hr-reseal`).
 *
 * Company by company, each in its own tenant transaction over the runtime
 * role, so RLS holds the work to one company at a time exactly as a request
 * would. A field already under the current key is left alone; one under an
 * older key is opened and sealed again, and written back only if nobody
 * changed it meanwhile. One that no configured key opens is counted and named
 * by employee and field — never by value — and left as it is: deleting it
 * would lose the number for good, and the missing key may yet turn up.
 *
 * Safe to run again: a second run finds everything current. When it reports
 * nothing left under an older key and nothing unreadable, the older keys can
 * come out of HR_DATA_KEYS_PREVIOUS.
 */

export interface ResealReport {
  companies: number;
  /** Fields already sealed under the current key. */
  current: number;
  /** Fields moved from an older key to the current one. */
  resealed: number;
  /** Fields that changed between reading and writing; they are current already. */
  changedMeanwhile: number;
  /** Fields no configured key opens. */
  unreadable: { tenantId: string; employeeId: string; field: SealedFieldName }[];
  /** How many fields each older key still had, by key fingerprint. */
  byOldKey: Record<string, number>;
}

export async function resealHrFields(options: {
  keyring: HrKeyring;
  /** One company, or every company when absent. */
  tenantIds?: readonly string[];
  onCompany?: (tenantId: string, resealed: number) => void;
}): Promise<ResealReport> {
  const report: ResealReport = {
    companies: 0,
    current: 0,
    resealed: 0,
    changedMeanwhile: 0,
    unreadable: [],
    byOldKey: {},
  };
  const tenantIds =
    options.tenantIds ?? (await getPlatformDataSource().tenants.list()).map((tenant) => tenant.id);

  for (const tenantId of tenantIds) {
    const resealed = await withTenant(tenantId, async (tx) => {
      let count = 0;
      for (const employee of await tx.hrEmployees.sealedValues()) {
        for (const field of SEALED_FIELDS) {
          const sealed = employee[field];
          if (sealed === null) {
            continue;
          }
          const context = { tenantId, employeeId: employee.id, field };
          let opened;
          try {
            opened = openWithKeyring(sealed, options.keyring, context);
          } catch {
            report.unreadable.push({ tenantId, employeeId: employee.id, field });
            continue;
          }
          if (opened.current) {
            report.current += 1;
            continue;
          }
          report.byOldKey[opened.keyId] = (report.byOldKey[opened.keyId] ?? 0) + 1;
          const again = sealField(opened.plaintext, options.keyring.current.key, context);
          if (await tx.hrEmployees.replaceSealed(employee.id, field, sealed, again)) {
            count += 1;
          } else {
            report.changedMeanwhile += 1;
          }
        }
      }
      if (count > 0) {
        await tx.auditLog.append({
          actorKind: 'system',
          actorLabel: 'admin-cli hr-reseal',
          action: 'hr.fields_resealed',
          resourceType: 'tenant',
          resourceId: tenantId,
          metadata: { fields: count, key: options.keyring.current.id },
        });
      }
      return count;
    });
    report.companies += 1;
    report.resealed += resealed;
    options.onCompany?.(tenantId, resealed);
  }

  return report;
}
