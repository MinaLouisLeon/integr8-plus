import { ROLES, type Role, roleSchema } from '@integr8/core';
import { localizedTextSchema, type LocalizedText } from '@integr8/form-engine';
import { z } from 'zod';
import { PACKAGE_IMAGE_TYPES, type PackageImageType } from './images.js';
import { FORM_PACKAGE_APPS, FORM_PACKAGE_FORMAT, type FormPackageApp } from './limits.js';

/**
 * The JSON entries of a `.integr8form` file. Every object is strict: a key
 * this version does not know is refused rather than dropped, so nothing in a
 * file is silently lost on the way into a company — a newer file says so with
 * its `formatVersion` instead.
 */

/** A template's name, as the PDF designer limits it. */
export const TEMPLATE_NAME_MAX = 120;

/** The roles a new form may be filled by when nothing says otherwise: the database's default. */
export const DEFAULT_FILL_ROLES: readonly Role[] = Object.freeze([
  'owner',
  'admin',
  'dispatcher',
  'engineer',
  'viewer',
]);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u, 'A sha256 in lower-case hexadecimal');

export const manifestTemplateSchema = z.strictObject({
  path: z.string(),
  name: z.string().trim().min(1).max(TEMPLATE_NAME_MAX),
});

export const manifestFileSchema = z.strictObject({
  /** The id the templates' designs use for this picture (`fileId`). */
  id: z.uuid().regex(/^[0-9a-f-]+$/u, 'A UUID in lower case'),
  path: z.string(),
  contentType: z.enum(PACKAGE_IMAGE_TYPES),
  bytes: z.number().int().min(1),
  sha256: sha256Schema,
});

export const manifestSchema = z.strictObject({
  format: z.literal(FORM_PACKAGE_FORMAT),
  formatVersion: z.number().int().min(1),
  createdBy: z.strictObject({
    app: z.enum(FORM_PACKAGE_APPS),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?$/u, 'A version like 1.3.0'),
  }),
  createdAt: z.iso.datetime({ offset: true }),
  form: z.strictObject({
    title: localizedTextSchema,
    schemaVersion: z.number().int().min(1),
    source: z.enum(['published', 'draft']),
    versionNumber: z.number().int().min(1).optional(),
  }),
  templates: z.array(manifestTemplateSchema),
  files: z.array(manifestFileSchema),
});

export interface FormPackageManifest {
  format: typeof FORM_PACKAGE_FORMAT;
  formatVersion: number;
  createdBy: { app: FormPackageApp; version: string };
  /** ISO 8601 with an offset, e.g. `2026-11-01T09:30:00.000Z`. */
  createdAt: string;
  form: {
    title: LocalizedText;
    schemaVersion: number;
    /** Exported from the last published version, or from the draft. */
    source: 'published' | 'draft';
    /** The published version's number, when `source` is `published`. */
    versionNumber?: number;
  };
  templates: { path: string; name: string }[];
  files: {
    id: string;
    path: string;
    contentType: PackageImageType;
    bytes: number;
    sha256: string;
  }[];
}

/**
 * What travels with a form besides its definition: the settings a form has
 * outside its versions, exactly those Copy to another company copies. Nothing
 * about the company it came from — no job type links, no ids.
 */
export interface FormPackageSettings {
  /** Who may fill the form. Never empty. */
  fillRoles: Role[];
  /** Whether a job using this form needs a signature before it can close. */
  signatureRequired: boolean;
}

export const settingsSchema = z.strictObject({
  fillRoles: z
    .array(roleSchema)
    .min(1)
    .max(ROLES.length)
    .refine((roles) => new Set(roles).size === roles.length, 'A role is listed twice'),
  signatureRequired: z.boolean(),
});

/**
 * `form.json`. The definition is checked here only as far as a draft must be
 * (an object with a whole-number `schemaVersion` this engine reads): a draft
 * may be half-built. {@link checkFormPackage} runs the full publish check.
 */
export const formEntrySchema = z.strictObject({
  definition: z.record(z.string(), z.unknown()),
  settings: settingsSchema,
});

/** `templates/<n>.json`. The design is checked by the PDF designer's own rules. */
export const templateEntrySchema = z.strictObject({
  name: z.string().trim().min(1).max(TEMPLATE_NAME_MAX),
  design: z.record(z.string(), z.unknown()),
});

/** Zod's issue path as the engine writes paths: `a.b[0].c`. */
export function pathText(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') {
      out += `[${String(part)}]`;
    } else {
      out += out === '' ? String(part) : `.${String(part)}`;
    }
  }
  return out;
}
