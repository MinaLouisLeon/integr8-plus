/**
 * Why a `.integr8form` file was refused. The codes are stable: the API turns
 * them into its own error codes, the staff screens into sentences, and the
 * forms AI tool into instructions for the model writing the file. The message
 * on the error is for a person; each problem says exactly where.
 */
export const FORM_PACKAGE_ERROR_CODES = [
  /** Not a ZIP this format allows, or a manifest that disagrees with what is in it. */
  'package_invalid',
  /** Past a size or count limit (the file, an entry, everything inflated, entries). */
  'package_too_large',
  /** Made by a newer Integr8 Plus: a newer file format, form format or design format. */
  'package_too_new',
  /** An entry the format has no place for, a stray picture, a path that leaves the package. */
  'package_entry_unexpected',
  /** A picture that differs from what the manifest says, or one a template needs that is missing. */
  'package_file_mismatch',
  /** A picture that is not a real PNG, JPEG or WebP, or not the one its name says. */
  'package_image_invalid',
  /** `form.json` is not a form definition with its settings, even as a draft. */
  'package_form_invalid',
  /** A PDF template whose design is not one Integr8 Plus can read. */
  'package_template_invalid',
] as const;

export type FormPackageErrorCode = (typeof FORM_PACKAGE_ERROR_CODES)[number];

/**
 * One thing wrong, with where: the package entry (`manifest.json`,
 * `form.json`, `templates/2.json`, `files/<id>.png`, or `` for the ZIP
 * itself) and the place inside that entry's JSON, in the dotted form the
 * form engine and the PDF designer use (`definition.pages[0].title`,
 * `design.blocks.heading_1`); empty when the whole entry is meant.
 */
export interface PackageProblem {
  entry: string;
  path: string;
  /** Machine-readable: the package's own code, or the engine's or designer's issue code. */
  code: string;
  message: string;
  /** For a form problem: the question, section or block ids involved. */
  elements?: string[];
}

/** At most this many problems travel on one error; the first ones are the useful ones. */
export const MAX_PROBLEMS = 50;

export class FormPackageError extends Error {
  override readonly name = 'FormPackageError';
  readonly code: FormPackageErrorCode;
  readonly problems: PackageProblem[];

  constructor(
    code: FormPackageErrorCode,
    message: string,
    problems: readonly PackageProblem[] = [],
  ) {
    super(message);
    this.code = code;
    this.problems = problems.slice(0, MAX_PROBLEMS);
  }
}

export function isFormPackageError(error: unknown): error is FormPackageError {
  return error instanceof FormPackageError;
}

/** Refuses with one problem, whose message is also the error's. */
export function refuse(
  code: FormPackageErrorCode,
  message: string,
  where: { entry?: string; path?: string; problem?: string } = {},
): never {
  throw new FormPackageError(code, message, [
    { entry: where.entry ?? '', path: where.path ?? '', code: where.problem ?? code, message },
  ]);
}
