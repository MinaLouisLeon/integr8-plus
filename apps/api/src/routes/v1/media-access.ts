import { holds, type Principal } from '@integr8/core';
import type { FileRecord, FileUse, TenantTransaction } from '@integr8/db';
import { ApiError } from '../../http/errors.js';
import { isFeatureEnabled } from '../../http/features.js';
import { readableAsset } from './assets.js';
import { readableClaim } from './expenses.js';
import { readableWorkOrder } from './operations.js';
import { mayRead } from './submissions.js';

/**
 * Who may read a stored file (docs/media, "Who may read a file").
 *
 * A file id is unguessable, but ids travel: in a submission's answers, on a
 * job's attachments, inside an exported document. Knowing one is not a right
 * to read it. A file follows the record that uses it, and is readable by
 * whoever may see that record:
 *
 * | Used by                          | Readable by                                        |
 * | -------------------------------- | -------------------------------------------------- |
 * | a submission (answers, history)  | whoever may read the submission                    |
 * | a job (attachment, sign-off)     | whoever may see the job                            |
 * | a customer or site               | whoever reads customers                            |
 * | an expense claim (receipt)       | its claimant and expense approvers                 |
 * | a document's PDF                 | document readers, and whoever made it              |
 * | a PDF template's picture         | Integr8 staff designing documents                  |
 * | an item (picture, datasheet)     | inventory readers                                  |
 * | an asset                         | whoever may read the asset                         |
 * | a part bought for a job          | inventory readers who may see the job              |
 * | a certificate scan               | its holder and qualification readers               |
 * | the company's logo or app icon   | every member                                       |
 * | nothing yet                      | only whoever uploaded it                           |
 *
 * An asset's history shows, to everyone who may read the asset, the forms
 * filled and the files attached on jobs whose only asset it is (product
 * decision, 2026-10-11); its files follow it there, so an engineer at the
 * machine sees the photos of every visit before theirs, as the phone does.
 *
 * Any one use that lets the reader in is enough. Everyone else is told the
 * file does not exist.
 */
export async function mayReadFile(
  tx: TenantTransaction,
  principal: Principal,
  file: FileRecord,
): Promise<boolean> {
  const uses = await tx.files.uses(file);
  if (uses.length === 0) {
    return file.uploadedBy === principal.userId;
  }
  const features = new Map<string, Promise<boolean>>();
  const featureOn = (key: 'assets' | 'documents' | 'hr' | 'inventory') => {
    let enabled = features.get(key);
    if (enabled === undefined) {
      enabled = isFeatureEnabled(principal.tenantId, key);
      features.set(key, enabled);
    }
    return enabled;
  };
  for (const use of uses) {
    if (await useAllows(tx, principal, use, featureOn)) {
      return true;
    }
  }
  return false;
}

type FeatureCheck = (key: 'assets' | 'documents' | 'hr' | 'inventory') => Promise<boolean>;

/** Runs a check that answers "not found" by throwing, as a yes or no. */
async function found(check: () => Promise<unknown>): Promise<boolean> {
  try {
    await check();
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return false;
    }
    throw error;
  }
}

/** Whether this person may read the asset, where the company keeps assets. */
async function seesAsset(
  tx: TenantTransaction,
  principal: Principal,
  assetId: string | undefined,
  featureOn: FeatureCheck,
): Promise<boolean> {
  return (
    assetId !== undefined &&
    holds(principal, 'asset.read') &&
    (await featureOn('assets')) &&
    (await found(() => readableAsset(tx, principal, assetId)))
  );
}

/** Whether this person may see the job, or the asset whose history shows what is on it. */
async function seesJob(
  tx: TenantTransaction,
  principal: Principal,
  workOrderId: string,
  featureOn: FeatureCheck,
): Promise<boolean> {
  return (
    (await found(() => readableWorkOrder(tx, principal, workOrderId))) ||
    (await seesAsset(tx, principal, await tx.assets.soleAssetOf(workOrderId), featureOn))
  );
}

async function useAllows(
  tx: TenantTransaction,
  principal: Principal,
  use: FileUse,
  featureOn: FeatureCheck,
): Promise<boolean> {
  switch (use.kind) {
    case 'branding':
      return true;
    case 'document_template':
      return holds(principal, 'document.design');
    case 'signoff':
      return found(() => readableWorkOrder(tx, principal, use.workOrderId));
    case 'document': {
      if (!(await featureOn('documents'))) {
        return false;
      }
      const document = await tx.documents.find(use.documentId);
      return (
        document !== undefined &&
        (holds(principal, 'document.read') || document.createdBy === principal.userId)
      );
    }
    case 'submission': {
      const submission = await tx.submissions.findById(use.submissionId);
      if (submission === undefined) {
        return false;
      }
      if (mayRead(principal, submission)) {
        return true;
      }
      // On an asset's history: the asset it names, or its job's only asset.
      if (submission.status === 'draft') {
        return false;
      }
      const assetId =
        submission.assetId ??
        (submission.workOrderId === null
          ? undefined
          : await tx.assets.soleAssetOf(submission.workOrderId));
      return seesAsset(tx, principal, assetId, featureOn);
    }
    case 'attachment':
      return attachmentAllows(tx, principal, use.owner, featureOn);
  }
}

async function attachmentAllows(
  tx: TenantTransaction,
  principal: Principal,
  owner: Extract<FileUse, { kind: 'attachment' }>['owner'],
  featureOn: FeatureCheck,
): Promise<boolean> {
  if ('workOrderId' in owner) {
    return seesJob(tx, principal, owner.workOrderId, featureOn);
  }
  if ('customerId' in owner || 'siteId' in owner) {
    return holds(principal, 'customer.read');
  }
  if ('assetId' in owner) {
    return seesAsset(tx, principal, owner.assetId, featureOn);
  }
  if ('expenseClaimId' in owner) {
    return (
      (await featureOn('hr')) &&
      (await found(() => readableClaim(tx, principal, owner.expenseClaimId)))
    );
  }
  if ('itemId' in owner) {
    return holds(principal, 'inventory.read') && (await featureOn('inventory'));
  }
  if ('workOrderPurchaseId' in owner) {
    if (
      !(holds(principal, 'inventory.read') || holds(principal, 'inventory.consume')) ||
      !(await featureOn('inventory'))
    ) {
      return false;
    }
    const purchase = await tx.workOrderPurchases.find(owner.workOrderPurchaseId);
    return (
      purchase !== undefined &&
      (await found(() => readableWorkOrder(tx, principal, purchase.workOrderId)))
    );
  }
  // A certificate's scan (P26): its holder, and whoever reads qualifications.
  const record = await tx.qualifications.findRecord(owner.memberQualificationId);
  return (
    record !== undefined &&
    (record.userId === principal.userId || holds(principal, 'qualification.read'))
  );
}
