import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  checkFormPackage,
  FORM_PACKAGE_EXTENSION,
  FORM_PACKAGE_LIMITS,
  type FormPackageCheck,
  type FormPackageSettings,
  type PackageImageType,
  packFormPackage,
  sniffImage,
  unpackFormPackage,
  type UnpackedFormPackage,
} from '@integr8/form-package';
import { VERSION } from '../version.js';

/**
 * Pictures, saving and opening: the only places the tool touches files. It
 * reads only paths the AI passes (pictures, a package to open) and writes only
 * into the output folder (packages) and the temporary folder (opened
 * pictures, previews).
 */

/** A picture as the AI gives it: by the path of a local file, or as base64. */
export interface PictureInput {
  id: string;
  path?: string | undefined;
  base64?: string | undefined;
}

export interface Picture {
  id: string;
  contentType: PackageImageType;
  bytes: Uint8Array;
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/** Reads one picture and makes sure it is a PNG, JPEG or WebP. */
export function loadPicture(input: PictureInput): Picture {
  if ((input.path === undefined) === (input.base64 === undefined)) {
    throw new ToolInputError(
      `Picture ${input.id}: give either "path" or "base64", not both or neither.`,
    );
  }
  let bytes: Uint8Array;
  if (input.path !== undefined) {
    const path = input.path;
    if (!isAbsolute(path)) {
      throw new ToolInputError(
        `Picture ${input.id}: "${path}" is not a full path; give the absolute path.`,
      );
    }
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      throw new ToolInputError(`Picture ${input.id}: no file at ${path}.`);
    }
    if (size > FORM_PACKAGE_LIMITS.imageBytes) {
      throw new ToolInputError(
        `Picture ${input.id}: ${path} is ${String(size)} bytes; a picture may be at most ${String(FORM_PACKAGE_LIMITS.imageBytes)}.`,
      );
    }
    bytes = new Uint8Array(readFileSync(path));
  } else {
    const text = (input.base64 ?? '').replace(/^data:[^;,]+;base64,/u, '').replace(/\s+/gu, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) {
      throw new ToolInputError(`Picture ${input.id}: "base64" is not base64 text.`);
    }
    bytes = new Uint8Array(Buffer.from(text, 'base64'));
  }
  const info = sniffImage(bytes);
  if (info === null) {
    throw new ToolInputError(
      `Picture ${input.id}: not a readable PNG, JPEG or WebP image. Convert it to PNG or JPEG first (SVG, GIF and HEIC are not accepted).`,
    );
  }
  return { id: input.id, contentType: info.contentType, bytes };
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu;

/**
 * A file name from a form's title that every operating system accepts:
 * Arabic letters are kept, characters Windows forbids and control characters
 * become spaces, and the result is never empty, never a reserved device name
 * and at most 80 characters.
 */
export function safeFileName(title: string): string {
  let name = title
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/u, '')
    .replace(/^[. ]+/u, '');
  if ([...name].length > 80) {
    name = [...name].slice(0, 80).join('').trim();
  }
  if (name === '') {
    name = 'form';
  }
  if (WINDOWS_RESERVED.test(name)) {
    name = `${name} form`;
  }
  return name;
}

/** The title to name a file after: English first, then Arabic, then anything. */
export function titleOf(definition: unknown): string {
  const title = (definition as { title?: unknown } | null)?.title;
  if (typeof title === 'object' && title !== null) {
    const texts = title as Record<string, unknown>;
    for (const key of ['en', 'ar', ...Object.keys(texts)]) {
      const value = texts[key];
      if (typeof value === 'string' && value.trim() !== '') {
        return value;
      }
    }
  }
  return 'form';
}

export interface SaveInput {
  definition: unknown;
  settings?: Partial<FormPackageSettings> | undefined;
  templates?: readonly { name: string; design: unknown }[] | undefined;
  pictures?: readonly PictureInput[] | undefined;
  /** Without the extension; defaults to the form's title. */
  fileName?: string | undefined;
  /** Defaults to the configured output folder. */
  folder: string;
  overwrite?: boolean | undefined;
  source?: 'draft' | 'published' | undefined;
}

export interface SaveResult {
  path: string;
  bytes: number;
  check: FormPackageCheck;
  replaced: boolean;
}

export class FileExistsError extends Error {
  constructor(readonly path: string) {
    super(
      `${path} already exists. Ask the user whether to replace it, then call save_package again with "overwrite": true, or choose another "fileName".`,
    );
    this.name = 'FileExistsError';
  }
}

/** Packs and writes a package. A file already there is refused unless `overwrite`. */
export function savePackage(input: SaveInput): SaveResult {
  const pictures = (input.pictures ?? []).map(loadPicture);
  const templates = input.templates ?? [];
  const check = checkFormPackage({ form: input.definition, templates, files: pictures });
  const bytes = packFormPackage({
    createdBy: { app: 'integr8-forms-ai', version: VERSION },
    definition: input.definition,
    source: input.source ?? 'draft',
    ...(input.settings === undefined ? {} : { settings: input.settings }),
    templates,
    files: pictures,
  });
  const name = safeFileName(
    input.fileName === undefined || input.fileName.trim() === ''
      ? titleOf(input.definition)
      : input.fileName.replace(/\.integr8form$/iu, ''),
  );
  const folder = resolve(input.folder);
  const path = join(folder, `${name}${FORM_PACKAGE_EXTENSION}`);
  const exists = existsSync(path);
  if (exists && input.overwrite !== true) {
    throw new FileExistsError(path);
  }
  mkdirSync(folder, { recursive: true });
  if (!exists) {
    // Exclusive create: a file that appeared since the check above is not replaced.
    try {
      writeFileSync(path, bytes, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new FileExistsError(path);
      }
      throw error;
    }
    return { path, bytes: bytes.length, check, replaced: false };
  }
  // Replacing: written beside it and moved over it, so a failure never leaves half a file.
  const temporary = join(folder, `.${name}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { path, bytes: bytes.length, check, replaced: true };
}

export interface OpenedPicture {
  id: string;
  contentType: string;
  width: number | null;
  height: number | null;
  /** Where the picture was written, to pass back to save_package as "path". */
  path: string;
}

export interface OpenResult {
  manifest: UnpackedFormPackage['manifest'];
  definition: UnpackedFormPackage['form'];
  settings: FormPackageSettings;
  templates: { name: string; design: unknown }[];
  pictures: OpenedPicture[];
  folder: string;
  check: FormPackageCheck;
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Reads a package for editing; its pictures are written under `scratch`. */
export function openPackage(path: string, scratch: string): OpenResult {
  if (!isAbsolute(path)) {
    throw new ToolInputError(
      `"${path}" is not a full path; give the absolute path of the .integr8form file.`,
    );
  }
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new ToolInputError(`No file at ${path}.`);
  }
  if (size > FORM_PACKAGE_LIMITS.fileBytes) {
    throw new ToolInputError(
      `${path} is ${String(size)} bytes; a .integr8form file is at most ${String(FORM_PACKAGE_LIMITS.fileBytes)}.`,
    );
  }
  const unpacked = unpackFormPackage(new Uint8Array(readFileSync(path)));
  const folder = join(
    scratch,
    'opened',
    `${safeFileName(titleOf(unpacked.form))}-${new Date().toISOString().replace(/[:.]/gu, '-')}`,
  );
  const pictures = unpacked.files.map((file) => {
    const target = join(folder, 'pictures', `${file.id}.${EXTENSIONS[file.contentType] ?? 'bin'}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
    const info = sniffImage(file.bytes);
    return {
      id: file.id,
      contentType: file.contentType,
      width: info?.width ?? null,
      height: info?.height ?? null,
      path: target,
    };
  });
  const check = checkFormPackage({
    form: unpacked.form,
    templates: unpacked.templates,
    files: unpacked.files,
    manifest: unpacked.manifest,
  });
  return {
    manifest: unpacked.manifest,
    definition: unpacked.form,
    settings: unpacked.settings,
    templates: unpacked.templates.map((template) => ({
      name: template.name,
      design: template.design,
    })),
    pictures,
    folder,
    check,
  };
}
