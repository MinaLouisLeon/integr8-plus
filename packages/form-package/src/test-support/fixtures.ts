/**
 * Packages for tests: a well-formed one (the boiler service library form with
 * a template and two pictures) and its raw parts to tamper with. Exported as
 * `@integr8/form-package/testing` so the API's import suites refuse exactly
 * the files this package's own suites do.
 */
import { createHash } from 'node:crypto';
import { emptyDesign, type TemplateDesign } from '@integr8/document-render';
import type { FormDefinition } from '@integr8/form-engine';
import { FORM_TEMPLATES } from '@integr8/form-engine/templates';
import type { FormPackageInput } from '../pack.js';
import { writeZip, type ZipEntryInput } from '../zip.js';

/** Real pictures, 3 × 2 pixels, made with an image library. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR4nGM8ISfHwMDAwMDAxAADABMuAQhqwGVhAAAAAElFTkSuQmCC',
  'base64',
);
export const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDHooorhPqD/9k=',
  'base64',
);
export const WEBP_LOSSLESS = Buffer.from(
  'UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAAAdQjyLXo/+BiOh/AAA=',
  'base64',
);
export const WEBP_LOSSY = Buffer.from(
  'UklGRjYAAABXRUJQVlA4ICoAAACQAQCdASoDAAIAAsBMJaACdLoAA5gA/u2QP4hd7G2//PTP62/j/xkAAAA=',
  'base64',
);
export const WEBP_EXTENDED = Buffer.from(
  'UklGRlgAAABXRUJQVlA4WAoAAAAQAAAAAgAAAQAAQUxQSAcAAAAAgICAgICAAFZQOCAqAAAAkAEAnQEqAwACAALATCWgAnS6AAOYAP7tkD+IXextv/z0z+tv4/8ZAAAA',
  'base64',
);

export const BACKGROUND_ID = '0b5f3c2e-8f4d-4a1b-9c3e-2d7f6a5b4c3d';
export const LOGO_ID = '7e6d5c4b-3a29-4817-a6b5-c4d3e2f1a0b9';

/** The boiler service library form: English and Arabic, published format 1. */
export function boilerDefinition(): FormDefinition {
  const template = FORM_TEMPLATES.find((entry) => entry.key === 'boiler_service');
  if (template === undefined) {
    throw new Error('The boiler service template is gone');
  }
  return structuredClone(template.definition);
}

/** A template naming two of the boiler form's questions, with a background and a picture. */
export function boilerDesign(): TemplateDesign {
  const design = emptyDesign();
  design.page.background = { fileId: BACKGROUND_ID };
  design.blocks.push(
    {
      type: 'field',
      id: 'serial',
      fieldId: 'serial_number',
      layout: 'inline',
    },
    {
      type: 'heading',
      id: 'arabic_heading',
      text: { en: 'Service report', ar: 'تقرير الصيانة' },
      level: 2,
      align: 'start',
    },
    {
      type: 'image',
      id: 'stamp',
      source: { kind: 'file', fileId: LOGO_ID },
      width: 30,
      align: 'end',
    },
    {
      type: 'field',
      id: 'pressure',
      fieldId: 'gas_pressure',
      layout: 'inline',
    },
  );
  return design;
}

export function boilerInput(overrides: Partial<FormPackageInput> = {}): FormPackageInput {
  return {
    createdBy: { app: 'integr8-plus', version: '1.3.0' },
    createdAt: new Date('2026-11-01T09:30:00.000Z'),
    definition: boilerDefinition(),
    source: 'published',
    versionNumber: 3,
    settings: { fillRoles: ['owner', 'engineer'], signatureRequired: true },
    templates: [{ name: 'Service report', design: boilerDesign() }],
    files: [
      { id: BACKGROUND_ID, contentType: 'image/png', bytes: PNG },
      { id: LOGO_ID, contentType: 'image/jpeg', bytes: JPEG },
    ],
    ...overrides,
  };
}

const encoder = new TextEncoder();
export const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value));
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The entries of a package as JSON values and bytes, for tests that tamper with them. */
export interface RawPackage {
  manifest: Record<string, unknown>;
  form: unknown;
  templates: unknown[];
  files: { path: string; bytes: Uint8Array }[];
  /** Anything else to put in the ZIP, as it is. */
  extra?: ZipEntryInput[];
}

/** A well-formed package's raw parts, matching {@link boilerInput}. */
export function rawBoiler(): RawPackage {
  const design = boilerDesign();
  const definition = boilerDefinition();
  return {
    manifest: {
      format: 'integr8form',
      formatVersion: 1,
      createdBy: { app: 'integr8-forms-ai', version: '1.3.0' },
      createdAt: '2026-11-01T09:30:00.000Z',
      form: { title: definition.title, schemaVersion: 1, source: 'draft' },
      templates: [{ path: 'templates/1.json', name: 'Service report' }],
      files: [
        {
          id: BACKGROUND_ID,
          path: `files/${BACKGROUND_ID}.png`,
          contentType: 'image/png',
          bytes: PNG.length,
          sha256: sha256(PNG),
        },
        {
          id: LOGO_ID,
          path: `files/${LOGO_ID}.jpg`,
          contentType: 'image/jpeg',
          bytes: JPEG.length,
          sha256: sha256(JPEG),
        },
      ],
    },
    form: { definition, settings: { fillRoles: ['owner'], signatureRequired: false } },
    templates: [{ name: 'Service report', design }],
    files: [
      { path: `files/${BACKGROUND_ID}.png`, bytes: PNG },
      { path: `files/${LOGO_ID}.jpg`, bytes: JPEG },
    ],
  };
}

export function zipRaw(raw: RawPackage): Uint8Array {
  return writeZip(
    [
      { name: 'manifest.json', data: jsonBytes(raw.manifest), compress: true },
      { name: 'form.json', data: jsonBytes(raw.form), compress: true },
      ...raw.templates.map((template, index) => ({
        name: `templates/${String(index + 1)}.json`,
        data: jsonBytes(template),
        compress: true,
      })),
      ...raw.files.map((file) => ({ name: file.path, data: file.bytes, compress: false })),
      ...(raw.extra ?? []),
    ],
    new Date('2026-11-01T09:30:00.000Z'),
  );
}
