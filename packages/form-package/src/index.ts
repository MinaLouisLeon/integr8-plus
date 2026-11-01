/**
 * `@integr8/form-package` — the `.integr8form` file: one form, its PDF
 * templates and their pictures, packed to move between companies and servers
 * (form builder decision 14) and written by the forms AI tool (decision 15).
 * The format is described for people and tools in
 * `docs/form-engine/package-format.md`.
 *
 *   const bytes = packFormPackage({ createdBy, definition, source: 'published', templates, files });
 *   const unpacked = unpackFormPackage(bytes);      // throws FormPackageError on anything wrong
 *   const check = checkFormPackage(unpacked);       // would it publish? { ok, problems, warnings }
 *
 * Node only (zlib and crypto); no I/O of its own.
 */

export { checkFormPackage, type FormPackageCheck, type FormPackageCheckInput } from './check.js';
export {
  type DraftDefinition,
  filePath as packageFilePath,
  type PackageFile,
  type PackageTemplate,
  templatePath as packageTemplatePath,
} from './contents.js';
export {
  FORM_PACKAGE_ERROR_CODES,
  FormPackageError,
  type FormPackageErrorCode,
  isFormPackageError,
  MAX_PROBLEMS,
  type PackageProblem,
} from './errors.js';
export {
  type ImageInfo,
  PACKAGE_IMAGE_EXTENSIONS,
  PACKAGE_IMAGE_TYPES,
  type PackageImageType,
  sniffImage,
} from './images.js';
export {
  FORM_PACKAGE_APPS,
  FORM_PACKAGE_EXTENSION,
  FORM_PACKAGE_FORMAT,
  FORM_PACKAGE_FORMAT_VERSION,
  FORM_PACKAGE_LIMITS,
  FORM_PACKAGE_MEDIA_TYPE,
  type FormPackageApp,
  type FormPackageLimits,
} from './limits.js';
export { type FormPackageInput, packFormPackage } from './pack.js';
export {
  DEFAULT_FILL_ROLES,
  type FormPackageManifest,
  type FormPackageSettings,
  TEMPLATE_NAME_MAX,
} from './schema.js';
export { type UnpackedFormPackage, type UnpackOptions, unpackFormPackage } from './unpack.js';
