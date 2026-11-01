import { createHash } from 'node:crypto';
import { localizedTextSchema, withRequiredSchemaVersion } from '@integr8/form-engine';
import {
  checkImage,
  checkReferences,
  draftDefinition,
  filePath,
  type PackageFile,
  type PackageTemplate,
  readDesign,
  templateName,
  templatePath,
} from './contents.js';
import { FormPackageError, refuse } from './errors.js';
import { PACKAGE_IMAGE_TYPES, type PackageImageType } from './images.js';
import {
  FORM_PACKAGE_FORMAT,
  FORM_PACKAGE_FORMAT_VERSION,
  FORM_PACKAGE_LIMITS,
  type FormPackageApp,
  type FormPackageLimits,
} from './limits.js';
import {
  DEFAULT_FILL_ROLES,
  type FormPackageManifest,
  type FormPackageSettings,
  manifestSchema,
  pathText,
  settingsSchema,
} from './schema.js';
import { writeZip, type ZipEntryInput } from './zip.js';

/** What to put in a package. Everything is checked as {@link unpackFormPackage} would check it. */
export interface FormPackageInput {
  createdBy: { app: FormPackageApp; version: string };
  /** Defaults to now. */
  createdAt?: Date;
  /**
   * The form definition (form-engine `FormDefinition`, or a draft of one). Its
   * `schemaVersion` is set to the lowest format that has everything it uses,
   * as the API does when a draft is saved.
   */
  definition: unknown;
  /** Exported from the last published version (give its number) or from the draft. */
  source: 'published' | 'draft';
  versionNumber?: number | null;
  /** Defaults: the database's default roles, no signature required. */
  settings?: Partial<FormPackageSettings>;
  /** PDF templates; a version 1 design is upgraded to the current version. */
  templates?: readonly { name: string; design: unknown }[];
  /** The pictures the templates use, under the ids their designs name. */
  files?: readonly { id: string; contentType: PackageImageType; bytes: Uint8Array }[];
}

const encoder = new TextEncoder();
const json = (value: unknown) => encoder.encode(`${JSON.stringify(value, null, 2)}\n`);

/**
 * Writes a `.integr8form` file. Refuses (with the same errors and codes as
 * reading one) anything that would not read back: a definition that is not
 * even a draft, a design the designer refuses, a picture that is not the
 * image it says, a picture no template uses or one a template needs but
 * lacks, anything past the limits.
 */
export function packFormPackage(input: FormPackageInput): Uint8Array {
  const limits: FormPackageLimits = FORM_PACKAGE_LIMITS;
  // Too new is refused before the format is worked out, which would lower it.
  const definition = draftDefinition(withRequiredSchemaVersion(draftDefinition(input.definition)));
  const title = localizedTextSchema.safeParse(definition.title);
  if (!title.success) {
    refuse(
      'package_form_invalid',
      'The form needs a title in at least one language: it names the form in the package.',
      { entry: 'form.json', path: 'definition.title' },
    );
  }

  const settings = settingsSchema.safeParse({
    fillRoles: input.settings?.fillRoles ?? [...DEFAULT_FILL_ROLES],
    signatureRequired: input.settings?.signatureRequired ?? false,
  });
  if (!settings.success) {
    throw new FormPackageError(
      'package_form_invalid',
      'The form’s settings are not valid.',
      settings.error.issues.map((issue) => ({
        entry: 'form.json',
        path: pathText(['settings', ...issue.path]),
        code: issue.code,
        message: issue.message,
      })),
    );
  }

  const templatesIn = input.templates ?? [];
  const filesIn = input.files ?? [];
  if (templatesIn.length > limits.templates || filesIn.length > limits.files) {
    refuse(
      'package_too_large',
      `A package holds at most ${String(limits.templates)} PDF templates and ${String(limits.files)} pictures.`,
    );
  }
  const templates: PackageTemplate[] = templatesIn.map((template, index) => ({
    name: templateName(template.name, templatePath(index)),
    design: readDesign(template.design, templatePath(index)),
  }));

  const ids = new Set<string>();
  const files: PackageFile[] = filesIn.map((file) => {
    if (!(PACKAGE_IMAGE_TYPES as readonly string[]).includes(file.contentType)) {
      refuse(
        'package_image_invalid',
        `A picture must be PNG, JPEG or WebP, not ${String(file.contentType)}.`,
      );
    }
    if (ids.has(file.id)) {
      refuse('package_invalid', `The picture ${file.id} is given twice.`, {
        entry: filePath(file),
      });
    }
    ids.add(file.id);
    const copy: PackageFile = { id: file.id, contentType: file.contentType, bytes: file.bytes };
    checkImage(copy, limits);
    return copy;
  });
  checkReferences(templates, files);

  const manifest: FormPackageManifest = {
    format: FORM_PACKAGE_FORMAT,
    formatVersion: FORM_PACKAGE_FORMAT_VERSION,
    createdBy: input.createdBy,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    form: {
      title: title.data,
      schemaVersion: definition.schemaVersion,
      source: input.source,
      ...(input.versionNumber == null ? {} : { versionNumber: input.versionNumber }),
    },
    templates: templates.map((template, index) => ({
      path: templatePath(index),
      name: template.name,
    })),
    files: files.map((file) => ({
      id: file.id,
      path: filePath(file),
      contentType: file.contentType,
      bytes: file.bytes.length,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
    })),
  };
  // The manifest's own rules (a file id is a UUID, the version reads as one).
  const checked = manifestSchema.safeParse(manifest);
  if (!checked.success) {
    throw new FormPackageError(
      'package_invalid',
      'The package’s manifest would not be valid.',
      checked.error.issues.map((issue) => ({
        entry: 'manifest.json',
        path: pathText(issue.path),
        code: issue.code,
        message: issue.message,
      })),
    );
  }

  const entries: ZipEntryInput[] = [
    { name: 'manifest.json', data: json(manifest), compress: true },
    { name: 'form.json', data: json({ definition, settings: settings.data }), compress: true },
    ...templates.map((template, index) => ({
      name: templatePath(index),
      data: json({ name: template.name, design: template.design }),
      compress: true,
    })),
    ...files.map((file) => ({ name: filePath(file), data: file.bytes, compress: false })),
  ];
  for (const entry of entries) {
    const cap =
      entry.name === 'manifest.json'
        ? limits.manifestBytes
        : entry.name === 'form.json'
          ? limits.formBytes
          : entry.name.startsWith('templates/')
            ? limits.templateBytes
            : limits.imageBytes;
    if (entry.data.length > cap) {
      refuse(
        'package_too_large',
        `${entry.name} would be ${String(entry.data.length)} bytes; it may be at most ${String(cap)}.`,
        { entry: entry.name },
      );
    }
  }
  if (entries.reduce((sum, entry) => sum + entry.data.length, 0) > limits.totalBytes) {
    refuse(
      'package_too_large',
      `The package would unpack to more than ${String(limits.totalBytes)} bytes.`,
    );
  }
  const zip = writeZip(entries, new Date(manifest.createdAt));
  if (zip.length > limits.fileBytes) {
    refuse(
      'package_too_large',
      `The package would be ${String(zip.length)} bytes; a .integr8form file may be at most ${String(limits.fileBytes)}.`,
    );
  }
  return zip;
}
