import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { currentHost } from '../host.js';
import { findBrowser } from '../preview/browser.js';
import { findExample, type FormExample, type TemplateExample } from './examples.js';
import { previewTemplate } from './preview.js';

const scratch = mkdtempSync(join(tmpdir(), 'forms-ai-preview-'));
afterAll(() => {
  if (process.env.FORMS_AI_KEEP_PREVIEWS === undefined) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

const form = (key: string) => (findExample(key) as FormExample).definition;
const template = (key: string) => {
  const example = findExample(key) as TemplateExample;
  return { name: example.name, design: example.design };
};

/** A 2 × 2 PNG, red. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
);

describe('preview_pdf without a browser', () => {
  it('checks, explains and makes no PDF', async () => {
    const result = await previewTemplate(
      { definition: form('boiler_service'), template: template('boiler_service_report') },
      { browser: undefined, scratch },
    );
    expect(result.check.ok).toBe(true);
    expect(result.pdfPath).toBeUndefined();
    expect(result.skipped).toMatch(/No Chrome, Edge or Chromium was found/u);
    expect(result.pageImages).toEqual([]);
  });

  it('says why when the form does not compile', async () => {
    const result = await previewTemplate(
      {
        definition: { schemaVersion: 1, title: { en: 'x' }, pages: [] },
        template: template('boiler_service_report'),
      },
      { browser: undefined, scratch },
    );
    expect(result.check.ok).toBe(false);
    expect(result.skipped).toMatch(/form has problems/u);
  });
});

// Runs where Chrome, Edge or Chromium is installed (developer machines, CI's ubuntu image).
const browser = findBrowser(currentHost());
describe.skipIf(browser === undefined)('preview_pdf with the machine’s browser', () => {
  it('prints a portrait template with a signature picture to PDF and page images', async () => {
    const signature = join(scratch, 'signature.png');
    writeFileSync(signature, PNG);
    const result = await previewTemplate(
      {
        definition: form('boiler_service'),
        template: template('boiler_service_report'),
        answers: { result: 'fail', failure_reason: 'Flue blocked by debris at the terminal.' },
        answerPictures: { customer_signature: [signature] },
        pages: 1,
      },
      { browser, scratch },
    );
    expect(result.skipped).toBeUndefined();
    expect(result.pageCount).toBeGreaterThanOrEqual(1);
    expect(
      readFileSync(result.pdfPath ?? '')
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
    expect(result.pageImages).toHaveLength(1);
    expect(
      Buffer.from(result.pageImages[0]?.png ?? [])
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
  });

  it('prints a landscape template in Arabic with the website font and a background', async () => {
    const id = '0b5f3c2e-8f4d-4a1b-9c3e-2d7f6a5b4c3d';
    const example = template('cooling_plant_landscape');
    const design = {
      ...example.design,
      page: { ...(example.design.page as object), background: { fileId: id } },
    };
    const result = await previewTemplate(
      {
        definition: form('cooling_plant_inspection'),
        template: { name: example.name, design },
        pictures: [{ id, base64: PNG.toString('base64') }],
        language: 'ar',
        pages: 2,
      },
      { browser, scratch },
    );
    expect(result.check.ok).toBe(true);
    expect(result.pageImages.length).toBeGreaterThanOrEqual(1);
    // Landscape: wider than tall.
    const png = Buffer.from(result.pageImages[0]?.png ?? []);
    expect(png.readUInt32BE(16)).toBeGreaterThan(png.readUInt32BE(20));
  });
});
