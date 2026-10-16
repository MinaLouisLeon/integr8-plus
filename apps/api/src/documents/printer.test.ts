import { existsSync } from 'node:fs';
import { compileDefinition } from '@integr8/form-engine';
import { emptyDesign, renderDocumentHtml, type TemplateDesign } from '@integr8/document-render';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { underlayBackgrounds } from './backgrounds.js';
import { backgroundImage, inlineImage } from './images.js';
import { ChromiumPrinter, PrinterUnavailableError, RecordingPrinter } from './printer.js';

/**
 * The printer and the backgrounds (docs/documents ADR-0001 D3, D4).
 *
 * The Chromium half runs where a Chromium is installed — the API image, a CI
 * runner with one, a laptop with `PDF_CHROMIUM_PATH` set — and is skipped
 * elsewhere, saying so. Everything else runs everywhere.
 */

const CHROMIUM = [
  process.env.PDF_CHROMIUM_PATH,
  '/usr/bin/chromium',
  '/opt/pw-browsers/chromium',
  '/usr/bin/google-chrome',
].find((path): path is string => path !== undefined && path !== '' && existsSync(path));

const definition = {
  schemaVersion: 1,
  title: { en: 'Service report', ar: 'تقرير الصيانة' },
  pages: [
    {
      id: 'page_1',
      sections: [
        {
          id: 'section_1',
          fields: [
            { id: 'customer', type: 'text', label: { en: 'Customer', ar: 'العميل' } },
            { id: 'notes', type: 'long_text', label: { en: 'Notes', ar: 'ملاحظات' } },
          ],
        },
      ],
    },
  ],
};

function form() {
  const compiled = compileDefinition(definition);
  if (!compiled.ok) {
    throw new Error('the test form does not compile');
  }
  return compiled.form;
}

function design(language: 'en' | 'ar'): TemplateDesign {
  const base = emptyDesign();
  const rows = Array.from({ length: 70 }, (_unused, index) => [
    { en: `Line ${String(index + 1)}`, ar: `سطر ${String(index + 1)}` },
    { en: 'Checked', ar: 'تم الفحص' },
  ]);
  return {
    ...base,
    page: { ...base.page, language },
    blocks: [
      ...base.blocks,
      {
        type: 'field',
        id: 'customer',
        fieldId: 'customer',
        layout: 'inline',
      },
      {
        type: 'static_table',
        id: 'lines',
        header: [
          { en: 'Item', ar: 'البند' },
          { en: 'State', ar: 'الحالة' },
        ],
        rows,
      },
      { type: 'qr', id: 'qr', size: 30, align: 'end' },
    ],
  };
}

function render(language: 'en' | 'ar') {
  return renderDocumentHtml({
    design: design(language),
    form: form(),
    answers: { customer: language === 'ar' ? 'شركة النيل' : 'Nile Co.', notes: 'ok' },
    locale: language,
    facts: {
      companyName: 'Integr8 Test',
      formTitle: 'Service report',
      submittedAt: '2026-10-16T08:00:00.000Z',
      submittedBy: 'Sam',
      workOrderReference: null,
      assetReference: null,
      documentDate: '2026-10-16T09:00:00.000Z',
      timeZone: 'Africa/Cairo',
    },
    fields: [],
    qrUrl: 'https://app.integr8.example/d/abcdefghijklmnopqrstuv',
    images: { logo: null, files: {}, media: {} },
    mode: 'pdf',
  });
}

async function png(width: number, height: number, alpha = false): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: {
        width,
        height,
        channels: alpha ? 4 : 3,
        background: alpha ? { r: 0, g: 80, b: 160, alpha: 0.5 } : { r: 230, g: 240, b: 250 },
      },
    })
      .png()
      .toBuffer(),
  );
}

describe('the recording printer', () => {
  it('makes one A4 page per page break', async () => {
    const printer = new RecordingPrinter();
    const bytes = await printer.print({
      html: '<p>one</p><div class="page-break"></div><p>two</p>',
      footerHtml: '',
      margins: { top: 10, end: 10, bottom: 10, start: 10 },
      hasFooter: false,
    });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(2);
    expect(Math.round(pdf.getPage(0).getWidth())).toBe(595);
    expect(printer.printed).toHaveLength(1);
  });
});

describe('backgrounds under every page', () => {
  it('draws the repeating image and a different first page, keeping the page count', async () => {
    const printer = new RecordingPrinter();
    const printed = await printer.print({
      html: 'a<div class="page-break"></div>b<div class="page-break"></div>c',
      footerHtml: '',
      margins: { top: 10, end: 10, bottom: 10, start: 10 },
      hasFooter: false,
    });
    const every = await backgroundImage(await png(800, 1131));
    const first = await backgroundImage(await png(800, 1131, true));
    expect(every?.format).toBe('jpeg');
    expect(first?.format).toBe('png');
    const plain = await underlayBackgrounds(printed, { every: null }, { title: 't', author: 'a' });
    const drawn = await underlayBackgrounds(
      printed,
      { every: every!, first: first! },
      { title: 'Certificate', author: 'Integr8 Test' },
    );
    expect(plain.pageCount).toBe(3);
    expect(drawn.pageCount).toBe(3);
    const pdf = await PDFDocument.load(drawn.bytes);
    expect(pdf.getPageCount()).toBe(3);
    expect(pdf.getTitle()).toBe('Certificate');
    // Two pictures embedded once each, however many pages show them.
    expect(drawn.bytes.byteLength).toBeGreaterThan(plain.bytes.byteLength);
  });

  it('leaves a plain first page plain', async () => {
    const printed = await new RecordingPrinter().print({
      html: 'a<div class="page-break"></div>b',
      footerHtml: '',
      margins: { top: 10, end: 10, bottom: 10, start: 10 },
      hasFooter: false,
    });
    const every = await backgroundImage(await png(400, 566));
    const result = await underlayBackgrounds(
      printed,
      { every: every!, first: null },
      { title: 't', author: 'a' },
    );
    expect(result.pageCount).toBe(2);
  });

  it('turns pictures into data links, and refuses what is not a picture', async () => {
    expect(await inlineImage(await png(3000, 2000))).toMatch(/^data:image\/jpeg;base64,/u);
    expect(await inlineImage(await png(40, 40, true))).toMatch(/^data:image\/png;base64,/u);
    expect(await inlineImage(new TextEncoder().encode('not an image'))).toBeUndefined();
  });
});

describe('the Chromium printer', () => {
  const printers: ChromiumPrinter[] = [];
  afterAll(async () => {
    await Promise.all(printers.map((printer) => printer.close()));
  });

  it('says plainly when there is no Chromium to run', async () => {
    const printer = new ChromiumPrinter({
      executablePath: '/nowhere/chromium',
      timeoutMs: 5_000,
      maxConcurrent: 1,
    });
    printers.push(printer);
    const status = await printer.status();
    expect(status.ok).toBe(false);
    await expect(printer.print(render('en'))).rejects.toBeInstanceOf(PrinterUnavailableError);
  });

  it.skipIf(CHROMIUM === undefined)(
    'prints English and Arabic onto A4 pages, breaking a long table across them',
    { timeout: 60_000 },
    async () => {
      const printer = new ChromiumPrinter({
        executablePath: CHROMIUM!,
        timeoutMs: 30_000,
        maxConcurrent: 2,
      });
      printers.push(printer);
      const [english, arabic] = await Promise.all([
        printer.print(render('en')),
        printer.print(render('ar')),
      ]);
      for (const bytes of [english, arabic]) {
        expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
        const pdf = await PDFDocument.load(bytes);
        expect(pdf.getPageCount()).toBeGreaterThan(1);
        const { width, height } = pdf.getPage(0).getSize();
        expect(Math.round(width)).toBe(595);
        expect(Math.round(height)).toBe(842);
      }
      const background = await backgroundImage(await png(800, 1131));
      const final = await underlayBackgrounds(
        arabic,
        { every: background! },
        { title: 'تقرير', author: 'Integr8 Test' },
      );
      expect(final.pageCount).toBe((await PDFDocument.load(arabic)).getPageCount());
    },
  );
});
