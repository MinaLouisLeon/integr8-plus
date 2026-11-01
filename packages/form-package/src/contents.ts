import {
  DESIGN_SCHEMA_VERSION,
  parseDesign,
  referencedFileIds,
  type TemplateDesign,
} from '@integr8/document-render';
import { DEFINITION_SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS } from '@integr8/form-engine';
import { FormPackageError, type PackageProblem, refuse } from './errors.js';
import { PACKAGE_IMAGE_EXTENSIONS, type PackageImageType, sniffImage } from './images.js';
import type { FormPackageLimits } from './limits.js';
import { TEMPLATE_NAME_MAX } from './schema.js';

/**
 * What a package holds once its JSON is read, checked the same way whether
 * it is about to be written ({@link packFormPackage}) or was just read
 * ({@link unpackFormPackage}): so a file this code writes is always one it
 * reads back.
 */

/** A picture in a package: the id its templates use, its kind, its bytes. */
export interface PackageFile {
  id: string;
  contentType: PackageImageType;
  bytes: Uint8Array;
}

/** A PDF template in a package, its design at the current design version. */
export interface PackageTemplate {
  name: string;
  design: TemplateDesign;
}

/** The definition as a draft may be: an object with a whole-number `schemaVersion`. */
export type DraftDefinition = Record<string, unknown> & { schemaVersion: number };

export const templatePath = (index: number) => `templates/${String(index + 1)}.json`;
export const filePath = (file: { id: string; contentType: PackageImageType }) =>
  `files/${file.id}.${PACKAGE_IMAGE_EXTENSIONS[file.contentType]}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The definition, if a draft could hold it; refuses one too new or not a definition at all. */
export function draftDefinition(definition: unknown, entry = 'form.json'): DraftDefinition {
  if (!isRecord(definition)) {
    return refuse('package_form_invalid', 'The form definition must be a JSON object.', {
      entry,
      path: 'definition',
    });
  }
  const version = definition.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return refuse(
      'package_form_invalid',
      'The form definition must carry a whole-number schemaVersion.',
      { entry, path: 'definition.schemaVersion' },
    );
  }
  if (version > DEFINITION_SCHEMA_VERSION) {
    return refuse(
      'package_too_new',
      `This form uses form format ${String(version)}, made by a newer Integr8 Plus; this one reads up to ${String(DEFINITION_SCHEMA_VERSION)}. Update first.`,
      { entry, path: 'definition.schemaVersion' },
    );
  }
  if (!(SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(version)) {
    return refuse(
      'package_form_invalid',
      `Form format ${String(version)} does not exist; formats ${SUPPORTED_SCHEMA_VERSIONS.join(' and ')} do.`,
      { entry, path: 'definition.schemaVersion' },
    );
  }
  return definition as DraftDefinition;
}

/** A design read by the PDF designer's own rules, a version 1 design upgraded. */
export function readDesign(design: unknown, entry: string): TemplateDesign {
  const version = isRecord(design) ? design.schemaVersion : undefined;
  if (typeof version === 'number' && Number.isInteger(version) && version > DESIGN_SCHEMA_VERSION) {
    return refuse(
      'package_too_new',
      `This PDF template uses design format ${String(version)}, made by a newer Integr8 Plus; this one reads up to ${String(DESIGN_SCHEMA_VERSION)}. Update first.`,
      { entry, path: 'design.schemaVersion' },
    );
  }
  const parsed = parseDesign(design);
  if (!parsed.ok) {
    throw new FormPackageError(
      'package_template_invalid',
      `The PDF template in ${entry} has ${String(parsed.issues.length)} problem${parsed.issues.length === 1 ? '' : 's'}.`,
      parsed.issues.map((issue) => ({
        entry,
        path: issue.path === '' ? 'design' : `design.${issue.path}`,
        code: issue.code,
        message: issue.message,
      })),
    );
  }
  return parsed.design;
}

export function templateName(name: unknown, entry: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed === '' || trimmed.length > TEMPLATE_NAME_MAX) {
    return refuse(
      'package_template_invalid',
      `A PDF template needs a name of 1 to ${String(TEMPLATE_NAME_MAX)} characters.`,
      { entry, path: 'name' },
    );
  }
  return trimmed;
}

/** A picture checked to be what it says, within the limits. */
export function checkImage(file: PackageFile, limits: FormPackageLimits): void {
  const entry = filePath(file);
  if (file.bytes.length > limits.imageBytes) {
    refuse(
      'package_too_large',
      `${entry} is ${String(file.bytes.length)} bytes; a picture may be at most ${String(limits.imageBytes)}.`,
      { entry },
    );
  }
  const info = sniffImage(file.bytes);
  if (info === null) {
    refuse('package_image_invalid', `${entry} is not a readable PNG, JPEG or WebP picture.`, {
      entry,
    });
  }
  if (info.contentType !== file.contentType) {
    refuse(
      'package_image_invalid',
      `${entry} is said to be ${file.contentType}, but its contents are ${info.contentType}.`,
      { entry },
    );
  }
  if (info.width > limits.imageSide || info.height > limits.imageSide) {
    refuse(
      'package_image_invalid',
      `${entry} is ${String(info.width)} × ${String(info.height)} pixels; a side may be at most ${String(limits.imageSide)}.`,
      { entry },
    );
  }
}

/**
 * Every picture a template uses is in the package, and every picture in the
 * package is used: a package carries nothing a person cannot see in it.
 */
export function checkReferences(
  templates: readonly PackageTemplate[],
  files: readonly { id: string; contentType: PackageImageType }[],
): void {
  const present = new Set(files.map((file) => file.id));
  const used = new Set<string>();
  const missing: PackageProblem[] = [];
  templates.forEach((template, index) => {
    for (const id of referencedFileIds(template.design)) {
      used.add(id);
      if (!present.has(id)) {
        missing.push({
          entry: templatePath(index),
          path: 'design',
          code: 'file_missing',
          message: `The template uses the picture ${id}, which the package does not have.`,
        });
      }
    }
  });
  if (missing.length > 0) {
    throw new FormPackageError(
      'package_file_mismatch',
      'A PDF template uses a picture the package does not have.',
      missing,
    );
  }
  const strays: PackageProblem[] = files
    .filter((file) => !used.has(file.id))
    .map((file) => ({
      entry: filePath(file),
      path: '',
      code: 'file_unused',
      message: `${filePath(file)} is used by no PDF template.`,
    }));
  if (strays.length > 0) {
    throw new FormPackageError(
      'package_entry_unexpected',
      'The package has a picture no PDF template uses.',
      strays,
    );
  }
}

/** Depth of a JSON value, without recursing (a hostile file can nest deeper than the stack). */
export function jsonDepth(value: unknown, limit: number): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop() ?? [null, 0];
    if (typeof node !== 'object' || node === null) {
      continue;
    }
    if (depth > limit) {
      return false;
    }
    for (const child of Object.values(node)) {
      stack.push([child, depth + 1]);
    }
  }
  return true;
}
