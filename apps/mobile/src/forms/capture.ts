import {
  fitWithin,
  geoPointFrom,
  PHOTO_QUALITY,
  THUMBNAIL_MAX_EDGE,
  THUMBNAIL_QUALITY,
} from '@integr8/form-input';
import type { GeoPoint } from '@integr8/form-engine';
import type { SubmitLocation } from '@integr8/offline';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { filesDirectory } from '~/local/device';

/**
 * What a form takes from the phone itself: photos, files, a drawn signature and
 * where the phone is (P13).
 *
 * **A photo is made smaller before it is queued, not before it is uploaded.** A
 * 12 MP photo waiting in the queue is space on the phone as well as on the bill,
 * so the original is replaced as soon as it is taken: longest edge 2048 pixels,
 * JPEG at 0.82 (`@integr8/form-input` fixes those numbers for every renderer),
 * plus a 320-pixel thumbnail so a form with thirty photos scrolls without
 * decoding thirty full-size images.
 *
 * Everything is kept under `captures/` in the files directory, by a path
 * relative to it, so an app update that moves the container keeps every file,
 * and a wipe deletes them with everything else.
 */

const CAPTURES = 'captures';

export interface CapturedFile {
  /** What the person would call it: the file's own name, or "Photo". */
  name: string;
  /** Relative to the files directory. */
  localPath: string;
  thumbnailPath?: string;
  contentType: string;
  byteSize: number;
}

function capturesDirectory(): Directory {
  const directory = new Directory(filesDirectory(), CAPTURES);
  if (!directory.exists) {
    directory.create({ intermediates: true });
  }
  return directory;
}

async function keep(uri: string, name: string): Promise<{ path: string; size: number }> {
  const target = new File(capturesDirectory(), name);
  await new File(uri).move(target);
  return { path: `${CAPTURES}/${name}`, size: target.size };
}

/** Deletes captured files the form will not use after all: too large, or replaced. */
export function discardCaptured(file: Pick<CapturedFile, 'localPath' | 'thumbnailPath'>): void {
  for (const path of [file.localPath, file.thumbnailPath]) {
    if (path === undefined) {
      continue;
    }
    try {
      const stored = new File(filesDirectory(), path);
      if (stored.exists) {
        stored.delete();
      }
    } catch {
      // Best effort; a wipe removes the directory.
    }
  }
}

function forget(uri: string): void {
  try {
    const original = new File(uri);
    if (original.exists) {
      original.delete();
    }
  } catch {
    // The picker's own cache; the system clears it eventually.
  }
}

async function shrink(asset: ImagePicker.ImagePickerAsset): Promise<CapturedFile> {
  const key = Crypto.randomUUID();
  const png = asset.mimeType === 'image/png';
  const size = fitWithin(asset.width, asset.height);
  let context = ImageManipulator.manipulate(asset.uri);
  if (size.scaled) {
    context = context.resize({ width: size.width, height: size.height });
  }
  const image = await context.renderAsync();
  const saved = await image.saveAsync({
    format: png ? SaveFormat.PNG : SaveFormat.JPEG,
    compress: PHOTO_QUALITY,
  });
  const small = fitWithin(saved.width, saved.height, THUMBNAIL_MAX_EDGE);
  const thumbnail = await (
    await ImageManipulator.manipulate(saved.uri)
      .resize({ width: small.width, height: small.height })
      .renderAsync()
  ).saveAsync({ format: SaveFormat.JPEG, compress: THUMBNAIL_QUALITY });

  const extension = png ? 'png' : 'jpg';
  const kept = await keep(saved.uri, `${key}.${extension}`);
  const keptThumbnail = await keep(thumbnail.uri, `${key}.thumb.jpg`);
  return {
    name: asset.fileName ?? `${key}.${extension}`,
    localPath: kept.path,
    thumbnailPath: keptThumbnail.path,
    contentType: png ? 'image/png' : 'image/jpeg',
    byteSize: kept.size,
  };
}

export type Captured<T> = { outcome: 'captured'; files: T } | { outcome: 'cancelled' | 'denied' };

/** A photo from the camera, made smaller. The camera's original is deleted. */
export async function takePhoto(): Promise<Captured<CapturedFile[]>> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    return { outcome: 'denied' };
  }
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    quality: 1,
    exif: false,
  });
  if (result.canceled) {
    return { outcome: 'cancelled' };
  }
  const files: CapturedFile[] = [];
  for (const asset of result.assets) {
    files.push(await shrink(asset));
    forget(asset.uri);
  }
  return { outcome: 'captured', files };
}

/** Photos already on the phone, made smaller. The phone's own copies are left alone. */
export async function choosePhotos(limit: number): Promise<Captured<CapturedFile[]>> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: limit > 1,
    selectionLimit: Number.isFinite(limit) ? Math.max(1, limit) : 0,
    quality: 1,
    exif: false,
  });
  if (result.canceled) {
    return { outcome: 'cancelled' };
  }
  const files: CapturedFile[] = [];
  for (const asset of result.assets) {
    files.push(await shrink(asset));
  }
  return { outcome: 'captured', files };
}

/** Any file, as it is. The question's types and size limit are checked by the caller. */
export async function chooseFiles(
  acceptedTypes: readonly string[] | undefined,
): Promise<Captured<CapturedFile[]>> {
  const result = await DocumentPicker.getDocumentAsync({
    type: acceptedTypes === undefined ? '*/*' : [...acceptedTypes],
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) {
    return { outcome: 'cancelled' };
  }
  const files: CapturedFile[] = [];
  for (const asset of result.assets) {
    const key = Crypto.randomUUID();
    const extension = /\.([a-z0-9]{1,8})$/iu.exec(asset.name)?.[1] ?? 'bin';
    const kept = await keep(asset.uri, `${key}.${extension}`);
    files.push({
      name: asset.name,
      localPath: kept.path,
      contentType: asset.mimeType ?? 'application/octet-stream',
      byteSize: kept.size,
    });
  }
  return { outcome: 'captured', files };
}

/** A signature snapshot (a PNG in the cache) kept with the form's other captures. */
export async function keepSignature(uri: string): Promise<CapturedFile> {
  const key = Crypto.randomUUID();
  const kept = await keep(uri, `${key}.png`);
  return {
    name: 'signature.png',
    localPath: kept.path,
    contentType: 'image/png',
    byteSize: kept.size,
  };
}

const FIX_TIMEOUT_MS = 20_000;

type Fix =
  | { status: 'captured'; point: GeoPoint; capturedAt: string }
  | { status: 'denied' | 'unavailable' };

/**
 * Where the phone is. A recent fix that is good enough is used at once; otherwise
 * the GPS is asked, for up to twenty seconds. GPS needs no signal, but a plant
 * room or a basement may never give a fix — which is recorded, not waited on.
 */
export async function locate(signal?: AbortSignal): Promise<Fix> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) {
    return { status: 'denied' };
  }
  const toFix = (position: Location.LocationObject): Fix => ({
    status: 'captured',
    point: geoPointFrom(position.coords),
    capturedAt: new Date(position.timestamp).toISOString(),
  });
  try {
    const recent = await Location.getLastKnownPositionAsync({
      maxAge: 60_000,
      requiredAccuracy: 50,
    });
    if (recent !== null) {
      return toFix(recent);
    }
    const position = await new Promise<Location.LocationObject | undefined>((resolve, reject) => {
      const timer = setTimeout(() => resolve(undefined), FIX_TIMEOUT_MS);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }).then(
        (found) => {
          clearTimeout(timer);
          resolve(found);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
    return position === undefined ? { status: 'unavailable' } : toFix(position);
  } catch {
    return { status: 'unavailable' };
  }
}

/** The location recorded with a submission. */
export async function submitLocation(signal?: AbortSignal): Promise<SubmitLocation> {
  const fix = await locate(signal);
  if (fix.status !== 'captured') {
    return { status: fix.status };
  }
  const { latitude, longitude, accuracyMeters } = fix.point;
  return {
    status: 'captured',
    latitude,
    longitude,
    ...(accuracyMeters === undefined ? {} : { accuracyMeters }),
    capturedAt: fix.capturedAt,
  };
}
