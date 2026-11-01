import {
  checkFormPackage,
  FORM_PACKAGE_EXTENSION,
  FORM_PACKAGE_MEDIA_TYPE,
  type FormPackageCheck,
  FormPackageError,
  type PackageProblem,
  type UnpackedFormPackage,
  unpackFormPackage,
} from '@integr8/form-package';
import { z } from 'zod';
import { ApiError, conflict, type ErrorDetail, unprocessable } from '../http/errors.js';
import { contentDisposition, type ObjectStore } from '../media/storage.js';
import type { PictureSource } from './template-copies.js';

/**
 * Moving a form with its PDF templates in one `.integr8form` file (form
 * builder decision 14, 1.3.0): what the export and import routes share. The
 * file format, and every check made on a file from outside, are
 * `@integr8/form-package`'s; this turns its refusals into API errors and its
 * check into a response.
 */

/** Who wrote a file this server exports. */
export const EXPORTING_APP = 'integr8-plus';

/** One thing wrong or worth a look in a file, where the package says it is. */
export const packageProblemSchema = z.object({
  /** `manifest.json`, `form.json`, `templates/2.json`, `files/<id>.png`; empty for the file. */
  entry: z.string(),
  /** Where in that entry: `definition.pages[0].title`, `design.blocks.heading_1`. */
  path: z.string(),
  code: z.string(),
  /** In English, for the forms AI tool and the log; screens show their own words by `code`. */
  message: z.string(),
  elements: z.array(z.string()).optional(),
});

/** At most this many problems and warnings travel in a response; the counts say how many. */
const MAX_LISTED = 100;

export const packageCheckSchema = z.object({
  /** Whether the form would publish as it is, and every PDF template save against it. */
  ok: z.boolean(),
  problemCount: z.number().int(),
  warningCount: z.number().int(),
  problems: z.array(packageProblemSchema),
  warnings: z.array(packageProblemSchema),
});

export function checkBody(check: FormPackageCheck): z.infer<typeof packageCheckSchema> {
  return {
    ok: check.ok,
    problemCount: check.problems.length,
    warningCount: check.warnings.length,
    problems: check.problems.slice(0, MAX_LISTED),
    warnings: check.warnings.slice(0, MAX_LISTED),
  };
}

/** A problem as an error detail: `field` names the entry and the place in it. */
export function problemDetails(problems: readonly PackageProblem[]): ErrorDetail[] {
  return problems.slice(0, MAX_LISTED).map((problem) => ({
    field: problem.path === '' ? problem.entry : `${problem.entry}#${problem.path}`,
    code: problem.code,
    message: problem.message,
  }));
}

/**
 * A package refusal as an API error, keeping the package's code: a client
 * shows its own sentence for each of them, and the details say where.
 */
export function packageRefusal(error: FormPackageError, status: 409 | 422): ApiError {
  return new ApiError(status, error.code, error.message, problemDetails(error.problems));
}

/** The uploaded file, read with every check the format makes, or refused with the package's code. */
export function readUpload(bytes: Uint8Array | undefined): {
  unpacked: UnpackedFormPackage;
  check: FormPackageCheck;
} {
  if (bytes === undefined || bytes.length === 0) {
    throw unprocessable(
      'package_invalid',
      `Send the ${FORM_PACKAGE_EXTENSION} file itself as the request body, as ${FORM_PACKAGE_MEDIA_TYPE}.`,
    );
  }
  let unpacked: UnpackedFormPackage;
  try {
    unpacked = unpackFormPackage(bytes);
  } catch (error) {
    if (error instanceof FormPackageError) {
      throw packageRefusal(error, 422);
    }
    throw error;
  }
  return {
    unpacked,
    check: checkFormPackage({
      form: unpacked.form,
      templates: unpacked.templates,
      files: unpacked.files,
      manifest: unpacked.manifest,
    }),
  };
}

/** Where a file came from, for the response and the audit lines. */
export function packageOrigin(unpacked: UnpackedFormPackage) {
  return {
    app: unpacked.manifest.createdBy.app,
    version: unpacked.manifest.createdBy.version,
    createdAt: unpacked.manifest.createdAt,
    exportedFrom: unpacked.manifest.form.source,
    versionNumber: unpacked.manifest.form.versionNumber ?? null,
  };
}

export const packageOriginSchema = z.object({
  /** The app that wrote the file: `integr8-plus` or `integr8-forms-ai`. */
  app: z.string(),
  version: z.string(),
  createdAt: z.string(),
  /** Whether a published version or a draft was exported. */
  exportedFrom: z.enum(['published', 'draft']),
  versionNumber: z.number().int().nullable(),
});

/**
 * The file's name: the form's title without what Windows, macOS or a header
 * cannot carry, and the extension. Arabic stays (the header has a UTF-8 copy).
 */
export function packageFilename(title: string): string {
  const name = Array.from(title)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 0x1f && code !== 0x7f && !'<>:"/\\|?*'.includes(char);
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/u, '')
    .slice(0, 100)
    .trim();
  return `${name === '' ? 'form' : name}${FORM_PACKAGE_EXTENSION}`;
}

/** The headers a package download answers with. */
export function packageHeaders(title: string): Record<string, string> {
  return {
    'content-type': FORM_PACKAGE_MEDIA_TYPE,
    'content-disposition': contentDisposition({
      key: '',
      contentType: FORM_PACKAGE_MEDIA_TYPE,
      expiresInSeconds: 0,
      disposition: 'attachment',
      filename: packageFilename(title),
    }),
    'cache-control': 'no-store',
  };
}

/** The bytes of stored pictures, for a file. A picture gone from storage refuses the export. */
export async function readPictures(
  store: ObjectStore,
  pictures: readonly PictureSource[],
): Promise<{ id: string; contentType: string; bytes: Uint8Array }[]> {
  const read: { id: string; contentType: string; bytes: Uint8Array }[] = [];
  for (const picture of pictures) {
    const bytes = await store.get(picture.storageKey);
    if (bytes === undefined) {
      throw conflict(
        'document_template_image_missing',
        'A picture a PDF template uses is no longer in storage; upload it again before exporting.',
      );
    }
    read.push({ id: picture.id, contentType: picture.contentType, bytes });
  }
  return read;
}
