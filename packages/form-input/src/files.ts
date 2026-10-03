/**
 * Photos and files, before they leave the device.
 *
 * Photos are made smaller on the device. This is the single decision that most
 * controls a company's storage bill, and how long an upload takes over a site's
 * weak signal, so it is fixed here for every renderer:
 *
 * - **Longest edge 2048 pixels.** Enough to read a gauge, a serial plate or a
 *   crack in a flue at full-screen size on a laptop; a modern phone's 4000-pixel
 *   photo is four times the pixels for detail nobody zooms into.
 * - **Quality 0.82**, JPEG or WebP. Artefacts are not visible at that size, and a
 *   typical site photo lands between 400 KB and 900 KB, against 3–6 MB straight
 *   from the camera.
 * - **Thumbnails 320 pixels**, the size the server's own thumbnails are, kept on
 *   the phone so a form with thirty photos scrolls without decoding thirty
 *   full-size images.
 */

export const PHOTO_MAX_EDGE = 2048;
export const PHOTO_QUALITY = 0.82;
export const THUMBNAIL_MAX_EDGE = 320;
export const THUMBNAIL_QUALITY = 0.7;

/** The size a photo is drawn at: its own, or scaled so the longest edge is `maxEdge`. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge = PHOTO_MAX_EDGE,
): { width: number; height: number; scaled: boolean } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) {
    return { width, height, scaled: false };
  }
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  };
}

/** Whether a media type is one a question accepts: `image/*` or an exact type. */
export function accepts(accepted: readonly string[] | undefined, type: string): boolean {
  if (accepted === undefined) {
    return true;
  }
  return accepted.some((pattern) =>
    pattern.endsWith('/*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type,
  );
}

export type FileProblem =
  | { code: 'too_many'; maximum: number }
  | { code: 'wrong_type'; name: string }
  | { code: 'too_large'; name: string; maximum: number };

/**
 * Which of the chosen files a question can take, and why the rest cannot —
 * checked on the device so a person learns a file is too large without waiting
 * for an upload. The limit applies to what will be sent: call this after a
 * photo has been made smaller. The server checks again at submit.
 */
export function checkChosenFiles<T extends { name: string; contentType: string; byteSize: number }>(
  field: {
    type: 'photo' | 'file';
    maxFiles?: number | undefined;
    maxFileBytes?: number | undefined;
    acceptedTypes?: readonly string[] | undefined;
  },
  alreadyChosen: number,
  chosen: readonly T[],
): { accepted: T[]; problems: FileProblem[] } {
  const problems: FileProblem[] = [];
  const room =
    field.maxFiles === undefined ? Number.POSITIVE_INFINITY : field.maxFiles - alreadyChosen;
  if (chosen.length > room) {
    problems.push({ code: 'too_many', maximum: field.maxFiles ?? 0 });
  }
  const types = field.type === 'photo' ? ['image/*'] : field.acceptedTypes;
  const accepted = chosen.slice(0, Math.max(0, room)).filter((file) => {
    if (!accepts(types, file.contentType)) {
      problems.push({ code: 'wrong_type', name: file.name });
      return false;
    }
    if (field.maxFileBytes !== undefined && file.byteSize > field.maxFileBytes) {
      problems.push({ code: 'too_large', name: file.name, maximum: field.maxFileBytes });
      return false;
    }
    return true;
  });
  return { accepted, problems };
}
