import type { WorkOrderState } from '@integr8/core';
import {
  type AccessValues,
  type ChangeContext,
  type ConditionValue,
  downloadedFiles,
  fetchAssetFile,
  fetchAttachment,
  markOpened,
  recordPhoto,
  recordAssetCondition,
  recordAssetLink,
  recordAccessChange,
  recordAssetRegistered,
  recordComment,
  recordMaterial,
  recordPhotoRemoved,
  recordPurchase,
  recordPurchaseReceipt,
  recordShiftEnd,
  recordShiftStart,
  recordSignoff,
  recordTransition,
  recordVisitDone,
  type SubmitLocation,
  syncApiFor,
  type WorkOrderDetail,
} from '@integr8/offline';
import * as Sharing from 'expo-sharing';
import {
  type Captured,
  type CapturedFile,
  choosePhotos,
  discardCaptured,
  keepSignature,
  submitLocation,
  takePhoto,
} from '~/forms/capture';
import { session } from '~/lib/session';
import { deleteLocalFiles } from './device';
import { localData } from './local-data';
import { deviceTransport, localFile } from './sync-device';

/**
 * What the engineer does to a job and to their day from the phone (P14). Each
 * is recorded on the phone first and shown at once; the sync engine sends it
 * when it can, with the moment it happened.
 */

function context(): ChangeContext {
  const opened = localData.changeContext();
  if (opened === undefined) {
    throw new Error('The phone’s database is not open.');
  }
  return opened;
}

function sent(): void {
  void localData.sync('change');
}

/** Where the phone is, if it knows within a few seconds: clocking in never waits on a GPS fix. */
async function quickLocation(): Promise<SubmitLocation> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8_000);
  try {
    return await submitLocation(abort.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function clockIn(): Promise<void> {
  await recordShiftStart(context(), { location: await quickLocation() });
  sent();
}

export async function clockOut(shiftId: string): Promise<void> {
  await recordShiftEnd(context(), { shiftId, location: await quickLocation() });
  sent();
}

/** A part used on the job, from the engineer's van (CRM/ERP plan, phase E2). */
export async function recordPart(input: {
  workOrderId: string;
  itemId: string;
  quantity: string;
  note?: string;
  /** The serial numbers or batch chosen from the van (ADR-0013). */
  lots?: { lotId: string; quantity: string }[];
  /** An expired batch confirmed; the note says why. */
  allowExpired?: boolean;
}): Promise<void> {
  await recordMaterial(context(), input);
  sent();
}

/**
 * A part bought from a merchant for the job, with a photo of each receipt
 * (ADR-0012). Recorded on the phone and sent with the job, the receipts after
 * it; the photos are dropped if the purchase cannot be recorded.
 */
export async function recordBought(input: {
  workOrderId: string;
  description: string;
  merchant: string;
  quantity: string;
  unitPrice: string;
  note: string;
  receipts: readonly CapturedFile[];
  receiptTitle: (index: number) => string;
}): Promise<string> {
  try {
    const { purchaseId } = await recordPurchase(context(), {
      workOrderId: input.workOrderId,
      description: input.description,
      merchant: input.merchant,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      note: input.note,
      receipts: input.receipts.map((file, index) => ({
        file: capturedInput(file),
        title: input.receiptTitle(index + 1),
      })),
    });
    sent();
    return purchaseId;
  } catch (error) {
    input.receipts.forEach(discardCaptured);
    throw error;
  }
}

/** Another receipt photo for a purchase recorded on this phone. */
export async function addBoughtReceipt(purchaseId: string, file: CapturedFile, title: string) {
  try {
    await recordPurchaseReceipt(context(), { purchaseId, file: capturedInput(file), title });
  } catch (error) {
    discardCaptured(file);
    throw error;
  }
  sent();
}

/** An asset found on site, registered on the job (CRM/ERP plan, phase E3). Resolves its id. */
export async function registerAsset(input: {
  workOrderId: string;
  name: string;
  make?: string;
  model?: string;
  serialNumber?: string;
  locationNote?: string;
  condition?: ConditionValue;
}): Promise<string> {
  const id = await recordAssetRegistered(context(), input);
  sent();
  return id;
}

export async function recordCondition(input: {
  assetId: string;
  condition: ConditionValue;
  note?: string;
  workOrderId?: string;
}): Promise<void> {
  await recordAssetCondition(context(), input);
  sent();
}

export async function linkAsset(input: { workOrderId: string; assetId: string }): Promise<void> {
  await recordAssetLink(context(), input);
  sent();
}

/** Opens a photo or document from an asset's history: from the phone, or fetched now. */
export async function openAssetFile(
  siteId: string,
  file: { fileId: string; title: string; contentType: string; byteSize: number },
): Promise<boolean> {
  const status = localData.status();
  if (status.phase !== 'open') {
    return false;
  }
  const { db } = status;
  let path = (await db.read((sql) => downloadedFiles(sql, [file.fileId]))).get(file.fileId);
  if (path === undefined) {
    const fetched = await fetchAssetFile(
      db,
      syncApiFor(session().client),
      deviceTransport,
      { ...file, siteId },
      new Date(),
    ).catch(() => false);
    if (!fetched) {
      return false;
    }
    path = (await db.read((sql) => downloadedFiles(sql, [file.fileId]))).get(file.fileId);
  }
  if (path === undefined || !localFile(path).exists) {
    return false;
  }
  await markOpened(db, file.fileId, new Date());
  await Sharing.shareAsync(localFile(path).uri, {
    mimeType: file.contentType,
    dialogTitle: file.title,
  });
  return true;
}

/** A visit marked done (P25): recorded now, sent when there is signal. */
export async function markVisitDone(workOrderId: string, visitId: string): Promise<void> {
  if ((await recordVisitDone(context(), { workOrderId, visitId })) !== undefined) {
    sent();
  }
}

export async function moveJob(workOrderId: string, to: WorkOrderState): Promise<void> {
  await recordTransition(context(), { workOrderId, to });
  sent();
}

/** A note on the job (P12): on the job at once, sent when there is signal. */
export async function addNote(input: {
  workOrderId: string;
  body: string;
  visibility: 'internal' | 'customer';
}): Promise<void> {
  await recordComment(context(), input);
  sent();
}

/**
 * A corrected gate code, parking or hazard (P12): on the site and its jobs at
 * once. Only the fields that changed are sent, so a colleague's correction to
 * another field offline is not overwritten, and a field nobody touched is
 * never part of a conflict.
 */
export async function correctAccess(siteId: string, changes: AccessValues): Promise<void> {
  if (Object.keys(changes).length === 0) {
    return;
  }
  await recordAccessChange(context(), { siteId, changes });
  sent();
}

/** Photographs the job from the camera or the phone's photos; resolves how many were added. */
export async function addJobPhotos(
  workOrderId: string,
  stage: 'before' | 'after',
  source: 'camera' | 'library',
): Promise<Captured<number>> {
  const captured = source === 'camera' ? await takePhoto() : await choosePhotos(10);
  if (captured.outcome !== 'captured') {
    return captured;
  }
  const changes = context();
  for (const [index, file] of captured.files.entries()) {
    try {
      await recordPhoto(changes, { workOrderId, stage, file: capturedInput(file) });
    } catch (error) {
      captured.files.slice(index).forEach(discardCaptured);
      throw error;
    }
  }
  sent();
  return { outcome: 'captured', files: captured.files.length };
}

export async function removeJobPhoto(workOrderId: string, attachmentId: string): Promise<void> {
  deleteLocalFiles(await recordPhotoRemoved(context(), { workOrderId, attachmentId }));
  sent();
}

/** The customer's drawn signature, from the pad's snapshot, with who signed. */
export async function signOffJob(
  workOrderId: string,
  signed: { snapshotUri: string; name: string; role: string },
): Promise<void> {
  const file = await keepSignature(signed.snapshotUri);
  try {
    await recordSignoff(context(), {
      workOrderId,
      signoff: { signature: capturedInput(file), name: signed.name, role: signed.role },
    });
  } catch (error) {
    discardCaptured(file);
    throw error;
  }
  sent();
}

export async function recordNobodyToSign(workOrderId: string, reason: string): Promise<void> {
  await recordSignoff(context(), { workOrderId, signoff: { unavailableReason: reason } });
  sent();
}

type Attachment = WorkOrderDetail['attachments'][number];

/**
 * Opens a job's file in whatever the phone opens it with. A file not on the
 * phone yet — too large for the background, or added since — is fetched first,
 * which needs signal. Resolves false when it could not be had.
 */
export async function openAttachment(
  workOrderId: string,
  attachment: Attachment,
): Promise<boolean> {
  const status = localData.status();
  if (status.phase !== 'open') {
    return false;
  }
  const { db } = status;
  let path = (await db.read((sql) => downloadedFiles(sql, [attachment.fileId]))).get(
    attachment.fileId,
  );
  if (path === undefined) {
    const fetched = await fetchAttachment(
      db,
      syncApiFor(session().client),
      deviceTransport,
      {
        fileId: attachment.fileId,
        workOrderId,
        title: attachment.title,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
      },
      new Date(),
    ).catch(() => false);
    if (!fetched) {
      return false;
    }
    path = (await db.read((sql) => downloadedFiles(sql, [attachment.fileId]))).get(
      attachment.fileId,
    );
  }
  if (path === undefined || !localFile(path).exists) {
    return false;
  }
  await markOpened(db, attachment.fileId, new Date());
  await Sharing.shareAsync(localFile(path).uri, {
    mimeType: attachment.contentType,
    dialogTitle: attachment.title,
  });
  return true;
}

function capturedInput(file: CapturedFile) {
  return {
    localPath: file.localPath,
    ...(file.thumbnailPath === undefined ? {} : { thumbnailPath: file.thumbnailPath }),
    contentType: file.contentType,
    byteSize: file.byteSize,
  };
}
