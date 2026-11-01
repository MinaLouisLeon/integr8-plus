import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  checkImage,
  checkReferences,
  type DraftDefinition,
  draftDefinition,
  filePath,
  jsonDepth,
  type PackageFile,
  type PackageTemplate,
  readDesign,
  templateName,
  templatePath,
} from './contents.js';
import { FormPackageError, type FormPackageErrorCode, refuse } from './errors.js';
import { PACKAGE_IMAGE_EXTENSIONS } from './images.js';
import {
  FORM_PACKAGE_FORMAT,
  FORM_PACKAGE_FORMAT_VERSION,
  FORM_PACKAGE_LIMITS,
  type FormPackageLimits,
} from './limits.js';
import {
  formEntrySchema,
  type FormPackageManifest,
  type FormPackageSettings,
  manifestSchema,
  pathText,
  templateEntrySchema,
} from './schema.js';
import { listZip, readEntry, type ZipRecord } from './zip.js';

export interface UnpackOptions {
  /** Tighter (or, in tests, looser) limits than {@link FORM_PACKAGE_LIMITS}. */
  limits?: Partial<FormPackageLimits>;
}

/** A package read and checked: everything an import needs, nothing it must look up. */
export interface UnpackedFormPackage {
  manifest: FormPackageManifest;
  /** The form definition as the file has it: draft-valid, not necessarily publishable. */
  form: DraftDefinition;
  settings: FormPackageSettings;
  /** In the manifest's order, each design at the current design version. */
  templates: PackageTemplate[];
  /** In the manifest's order. */
  files: PackageFile[];
}

/** The only entries a package has. Template numbers start at 1, without leading zeros. */
const TEMPLATE_ENTRY = /^templates\/[1-9][0-9]{0,3}\.json$/u;
const FILE_ENTRY =
  /^files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp)$/u;
/** Folders some ZIP tools add; nothing else may be a folder. */
const FOLDERS = new Set(['templates/', 'files/']);

type EntryKind = 'manifest' | 'form' | 'template' | 'file';

function kindOf(name: string): EntryKind | null {
  if (name === 'manifest.json') {
    return 'manifest';
  }
  if (name === 'form.json') {
    return 'form';
  }
  if (TEMPLATE_ENTRY.test(name)) {
    return 'template';
  }
  if (FILE_ENTRY.test(name)) {
    return 'file';
  }
  return null;
}

/** A name that could reach outside the package when unzipped by a careless tool. */
function unsafeName(name: string): boolean {
  return (
    name === '' ||
    name.startsWith('/') ||
    name.includes('\\') ||
    /^[A-Za-z]:/u.test(name) ||
    // Control characters, including NUL, which ends a name early in C.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(name) ||
    name.split('/').some((part, index, parts) => {
      const last = index === parts.length - 1;
      return part === '..' || part === '.' || (part === '' && !last);
    })
  );
}

function capFor(kind: EntryKind, limits: FormPackageLimits): number {
  switch (kind) {
    case 'manifest':
      return limits.manifestBytes;
    case 'form':
      return limits.formBytes;
    case 'template':
      return limits.templateBytes;
    case 'file':
      return limits.imageBytes;
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function readJson(
  bytes: Uint8Array,
  record: ZipRecord,
  limits: FormPackageLimits,
  code: FormPackageErrorCode,
): unknown {
  const data = readEntry(bytes, record);
  let text: string;
  try {
    text = decoder.decode(data);
  } catch {
    return refuse(code, `${record.name} is not UTF-8 text.`, { entry: record.name });
  }
  // A byte order mark, as some Windows editors write one.
  if (text.startsWith('﻿')) {
    text = text.slice(1);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return refuse(
      code,
      `${record.name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { entry: record.name },
    );
  }
  if (!jsonDepth(value, limits.jsonDepth)) {
    return refuse(code, `${record.name} nests deeper than ${String(limits.jsonDepth)} levels.`, {
      entry: record.name,
    });
  }
  return value;
}

function schemaRefused(
  code: FormPackageErrorCode,
  entry: string,
  message: string,
  error: z.ZodError,
): never {
  throw new FormPackageError(
    code,
    message,
    error.issues.map((issue) => ({
      entry,
      path: pathText(issue.path),
      code: issue.code,
      message: issue.message,
    })),
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readManifest(
  bytes: Uint8Array,
  record: ZipRecord,
  limits: FormPackageLimits,
): FormPackageManifest {
  const value = readJson(bytes, record, limits, 'package_invalid');
  if (!isRecord(value) || value.format !== FORM_PACKAGE_FORMAT) {
    return refuse(
      'package_invalid',
      'This is not a .integr8form file: its manifest says otherwise.',
      {
        entry: 'manifest.json',
        path: 'format',
      },
    );
  }
  const version = value.formatVersion;
  if (
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version > FORM_PACKAGE_FORMAT_VERSION
  ) {
    return refuse(
      'package_too_new',
      `This file was made by a newer Integr8 Plus (package format ${String(version)}; this one reads up to ${String(FORM_PACKAGE_FORMAT_VERSION)}). Update first.`,
      { entry: 'manifest.json', path: 'formatVersion' },
    );
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    return schemaRefused(
      'package_invalid',
      'manifest.json',
      'The package’s manifest is not one this format allows.',
      parsed.error,
    );
  }
  const manifest = parsed.data as FormPackageManifest;
  if (manifest.formatVersion !== FORM_PACKAGE_FORMAT_VERSION) {
    // Only version 1 exists; there is nothing older to upgrade from yet.
    return refuse(
      'package_invalid',
      `Package format ${String(manifest.formatVersion)} does not exist.`,
      {
        entry: 'manifest.json',
        path: 'formatVersion',
      },
    );
  }
  if (manifest.templates.length > limits.templates || manifest.files.length > limits.files) {
    return refuse(
      'package_too_large',
      `A package holds at most ${String(limits.templates)} PDF templates and ${String(limits.files)} pictures.`,
      { entry: 'manifest.json' },
    );
  }
  manifest.templates.forEach((template, index) => {
    if (template.path !== templatePath(index)) {
      refuse(
        'package_invalid',
        `The manifest’s template ${String(index + 1)} must be at ${templatePath(index)}, not ${template.path}.`,
        { entry: 'manifest.json', path: `templates[${String(index)}].path` },
      );
    }
  });
  const ids = new Set<string>();
  manifest.files.forEach((file, index) => {
    const where = { entry: 'manifest.json', path: `files[${String(index)}]` };
    if (ids.has(file.id)) {
      refuse('package_invalid', `The manifest lists the picture ${file.id} twice.`, where);
    }
    ids.add(file.id);
    const expected = filePath(file);
    if (file.path !== expected) {
      const extension = /\.([a-z]+)$/u.exec(file.path)?.[1];
      if (
        file.path.startsWith(`files/${file.id}.`) &&
        extension !== undefined &&
        Object.values(PACKAGE_IMAGE_EXTENSIONS).includes(extension)
      ) {
        refuse(
          'package_image_invalid',
          `${file.path} is named .${extension}, but the manifest says it is ${file.contentType}.`,
          where,
        );
      }
      refuse(
        'package_invalid',
        `The picture ${file.id} must be at ${expected}, not ${file.path}.`,
        where,
      );
    }
  });
  return manifest;
}

/**
 * Reads a `.integr8form` file from anyone, refusing anything that is not
 * exactly the format: the first thing wrong is thrown as a
 * {@link FormPackageError} with a stable code and the problems found. What
 * comes back is safe to import as a draft; run {@link checkFormPackage} to
 * know whether it would publish.
 */
export function unpackFormPackage(
  bytes: Uint8Array,
  options: UnpackOptions = {},
): UnpackedFormPackage {
  const limits: FormPackageLimits = { ...FORM_PACKAGE_LIMITS, ...options.limits };
  if (bytes.length > limits.fileBytes) {
    refuse(
      'package_too_large',
      `The file is ${String(bytes.length)} bytes; a .integr8form file may be at most ${String(limits.fileBytes)}.`,
    );
  }
  const records = listZip(bytes, limits.entries);

  // Names first, all of them, before anything is inflated.
  const entries = new Map<string, { record: ZipRecord; kind: EntryKind | null }>();
  const folded = new Set<string>();
  let total = 0;
  for (const record of records) {
    const name = record.name;
    if (unsafeName(name)) {
      refuse('package_entry_unexpected', `"${name}" is not a name a package may hold.`, {
        entry: name,
        problem: 'unsafe_path',
      });
    }
    if (folded.has(name.toLowerCase())) {
      refuse('package_entry_unexpected', `"${name}" is in the package twice.`, {
        entry: name,
        problem: 'duplicate_entry',
      });
    }
    folded.add(name.toLowerCase());
    if (FOLDERS.has(name) && record.size === 0) {
      continue;
    }
    const kind = kindOf(name);
    if (kind !== null && record.size > capFor(kind, limits)) {
      refuse(
        'package_too_large',
        `${name} is ${String(record.size)} bytes; it may be at most ${String(capFor(kind, limits))}.`,
        { entry: name },
      );
    }
    total += record.size;
    if (total > limits.totalBytes) {
      refuse(
        'package_too_large',
        `The package unpacks to more than ${String(limits.totalBytes)} bytes.`,
      );
    }
    entries.set(name, { record, kind });
  }

  const manifestEntry = entries.get('manifest.json');
  if (manifestEntry === undefined) {
    refuse('package_invalid', 'This is not a .integr8form file: it has no manifest.json.');
  }
  // The manifest's version decides how the rest is read, so it is read first:
  // a newer file is "too new", not a list of entries this version has never heard of.
  const manifest = readManifest(bytes, manifestEntry.record, limits);

  const listed = new Set<string>([
    'manifest.json',
    'form.json',
    ...manifest.templates.map((template) => template.path),
    ...manifest.files.map((file) => file.path),
  ]);
  for (const [name] of entries) {
    if (!listed.has(name)) {
      refuse(
        'package_entry_unexpected',
        kindOf(name) === null
          ? `"${name}" has no place in a .integr8form file.`
          : `${name} is in the package but not in its manifest.`,
        { entry: name, problem: kindOf(name) === null ? 'unknown_entry' : 'unlisted_entry' },
      );
    }
  }

  // form.json
  const formEntry = entries.get('form.json');
  if (formEntry === undefined) {
    return refuse('package_invalid', 'The package has no form.json.', { entry: 'form.json' });
  }
  const formJson = readJson(bytes, formEntry.record, limits, 'package_form_invalid');
  if (isRecord(formJson) && 'definition' in formJson) {
    draftDefinition(formJson.definition);
  }
  const formParsed = formEntrySchema.safeParse(formJson);
  if (!formParsed.success) {
    schemaRefused(
      'package_form_invalid',
      'form.json',
      'form.json is not a form definition with its settings.',
      formParsed.error,
    );
  }
  const definition = draftDefinition(formParsed.data.definition);
  if (definition.schemaVersion !== manifest.form.schemaVersion) {
    refuse(
      'package_invalid',
      `The manifest says form format ${String(manifest.form.schemaVersion)}, but form.json has ${String(definition.schemaVersion)}.`,
      { entry: 'manifest.json', path: 'form.schemaVersion' },
    );
  }

  // templates/<n>.json
  const templates: PackageTemplate[] = manifest.templates.map((listedTemplate, index) => {
    const entry = templatePath(index);
    const found = entries.get(entry);
    if (found === undefined) {
      return refuse(
        'package_invalid',
        `The manifest lists ${entry}, which the package does not have.`,
        {
          entry,
        },
      );
    }
    const json = readJson(bytes, found.record, limits, 'package_template_invalid');
    if (isRecord(json) && 'design' in json) {
      readDesign(json.design, entry);
    }
    const parsed = templateEntrySchema.safeParse(json);
    if (!parsed.success) {
      return schemaRefused(
        'package_template_invalid',
        entry,
        `${entry} is not a PDF template.`,
        parsed.error,
      );
    }
    const name = templateName(parsed.data.name, entry);
    if (name !== listedTemplate.name.trim()) {
      return refuse(
        'package_invalid',
        `${entry} is named "${name}", but the manifest calls it "${listedTemplate.name}".`,
        { entry: 'manifest.json', path: `templates[${String(index)}].name` },
      );
    }
    return { name, design: readDesign(parsed.data.design, entry) };
  });

  // files/<id>.<ext>
  const files: PackageFile[] = manifest.files.map((listedFile) => {
    const found = entries.get(listedFile.path);
    if (found === undefined) {
      return refuse(
        'package_file_mismatch',
        `The manifest lists ${listedFile.path}, which the package does not have.`,
        { entry: listedFile.path, problem: 'file_missing' },
      );
    }
    const data = readEntry(bytes, found.record);
    if (data.length !== listedFile.bytes) {
      refuse(
        'package_file_mismatch',
        `${listedFile.path} is ${String(data.length)} bytes, but the manifest says ${String(listedFile.bytes)}.`,
        { entry: listedFile.path, problem: 'file_size' },
      );
    }
    if (createHash('sha256').update(data).digest('hex') !== listedFile.sha256) {
      refuse(
        'package_file_mismatch',
        `${listedFile.path} is not the picture the manifest describes: its sha256 differs.`,
        { entry: listedFile.path, problem: 'file_hash' },
      );
    }
    const file: PackageFile = {
      id: listedFile.id,
      contentType: listedFile.contentType,
      // A copy, so the result does not keep the whole file alive.
      bytes: Uint8Array.from(data),
    };
    checkImage(file, limits);
    return file;
  });

  checkReferences(templates, files);

  return {
    manifest,
    form: definition,
    settings: {
      fillRoles: [...formParsed.data.settings.fillRoles],
      signatureRequired: formParsed.data.settings.signatureRequired,
    },
    templates,
    files,
  };
}
