import type { WorkOrderState } from '@integr8/core';
import {
  type ChangeContext,
  downloadedFiles,
  fetchAttachment,
  markOpened,
  recordPhoto,
  recordPhotoRemoved,
  recordShiftEnd,
  recordShiftStart,
  recordSignoff,
  recordTransition,
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

export async function moveJob(workOrderId: string, to: WorkOrderState): Promise<void> {
  await recordTransition(context(), { workOrderId, to });
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
