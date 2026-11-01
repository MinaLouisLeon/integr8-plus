/** What the manifest's `format` says: this is a form package. */
export const FORM_PACKAGE_FORMAT = 'integr8form';

/**
 * The newest file format this code reads and the one it writes. A file with a
 * higher number was made by a newer Integr8 Plus and is refused as too new;
 * an older number would be upgraded on reading, as form and design formats are.
 * Raised only when the layout or the manifest changes in a way an older reader
 * would misunderstand: a new optional field the reader does not know is
 * refused too (the manifest is strict), so a new manifest field means a new
 * format version.
 */
export const FORM_PACKAGE_FORMAT_VERSION = 1;

/** The file name's extension. */
export const FORM_PACKAGE_EXTENSION = '.integr8form';

/** The media type to send and receive it with. It is a ZIP underneath. */
export const FORM_PACKAGE_MEDIA_TYPE = 'application/vnd.integr8.form+zip';

/** The apps that write these files. */
export const FORM_PACKAGE_APPS = ['integr8-plus', 'integr8-forms-ai'] as const;
export type FormPackageApp = (typeof FORM_PACKAGE_APPS)[number];

/**
 * Limits for an untrusted file. The whole file is capped at 50 MB (owner's
 * decision 14) and what it inflates to at three times that, so a ZIP bomb is
 * refused from the sizes it declares and, if it lies, stopped while inflating
 * at the size it declared. The counts match what a form can have: the API
 * keeps PDF templates per form well under 50, and a template's pictures are
 * a background or two and a few image blocks.
 */
export interface FormPackageLimits {
  /** The `.integr8form` file itself. */
  fileBytes: number;
  /** Every entry inflated, together. */
  totalBytes: number;
  /** Entries in the ZIP, directories included. */
  entries: number;
  manifestBytes: number;
  formBytes: number;
  templateBytes: number;
  imageBytes: number;
  templates: number;
  files: number;
  /** A picture's longest side, in pixels: a small file can still be a huge picture. */
  imageSide: number;
  /** How deeply any JSON entry may nest. */
  jsonDepth: number;
}

const MB = 1024 * 1024;

export const FORM_PACKAGE_LIMITS: Readonly<FormPackageLimits> = Object.freeze({
  fileBytes: 50 * MB,
  totalBytes: 150 * MB,
  entries: 260,
  manifestBytes: 256 * 1024,
  formBytes: 4 * MB,
  templateBytes: 2 * MB,
  imageBytes: 25 * MB,
  templates: 50,
  files: 200,
  imageSide: 10_000,
  jsonDepth: 200,
});
