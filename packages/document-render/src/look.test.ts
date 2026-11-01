import { compileDefinition, type CompiledForm } from '@integr8/form-engine';
import { describe, expect, it } from 'vitest';
import {
  checkDesignAgainstForm,
  designUsesLogo,
  emptyDesign,
  issueTargets,
  parseDesign,
  type TemplateDesign,
  upgradeDesign,
} from './design.js';
import { DOCUMENT_FONTS, fontFaceRules } from './fonts.js';
import { renderDocumentHtml, type RenderInput } from './html.js';
import { documentLook, lookColours, tintOf } from './look.js';
import { sampleAnswers } from './sample.js';

/**
 * 1.3.0: the shared document look (header, footer, colour, font), landscape
 * pages, the template's style, the upgrade from version 1 designs, missing
 * questions, and sample answers.
 */

function compile(withPressure = true): CompiledForm {
  const result = compileDefinition({
    schemaVersion: 1,
    title: { en: 'Boiler service', ar: 'صيانة الغلاية' },
    pages: [
      {
        id: 'main',
        sections: [
          {
            id: 'details',
            fields: [
              { id: 'customer', type: 'text', label: { en: 'Customer', ar: 'العميل' } },
              ...(withPressure
                ? [
                    {
                      id: 'pressure',
                      type: 'decimal' as const,
                      decimalPlaces: 1,
                      label: { en: 'Pressure', ar: 'الضغط' },
                    },
                  ]
                : []),
              {
                id: 'kind',
                type: 'radio',
                label: { en: 'Kind', ar: 'النوع' },
                options: [
                  { value: 'combi', label: { en: 'Combi', ar: 'مدمجة' } },
                  { value: 'system', label: { en: 'System', ar: 'نظام' } },
                ],
              },
            ],
          },
          ...(withPressure
            ? [
                {
                  id: 'parts',
                  repeat: { maxEntries: 20, entryLabel: { en: 'Part', ar: 'قطعة' } },
                  fields: [{ id: 'part_name', type: 'text' as const, label: { en: 'Part' } }],
                },
              ]
            : []),
        ],
      },
    ],
  });
  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }
  return result.form;
}

const facts = {
  companyName: 'Acme Heating',
  formTitle: 'Boiler service',
  submittedAt: '2026-10-16T09:30:00.000Z',
  submittedBy: 'Sam Engineer',
  workOrderReference: 'WO-000042',
  assetReference: null,
  documentDate: '2026-10-16T10:00:00.000Z',
  timeZone: 'Africa/Cairo',
};

const LOGO = 'data:image/png;base64,iVBORw0KGgo=';

function input(design: TemplateDesign, overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    design,
    form: compile(),
    answers: { customer: 'Riverside', pressure: '1.5', kind: 'combi' },
    locale: 'en',
    facts,
    fields: [],
    qrUrl: null,
    images: { logo: LOGO, files: {}, media: {} },
    mode: 'pdf',
    ...overrides,
  };
}

function parsed(value: unknown): TemplateDesign {
  const result = parseDesign(value);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }
  return result.design;
}

const V1 = {
  schemaVersion: 1,
  page: {
    margins: { top: 20, end: 15, bottom: 20, start: 15 },
    footer: { pageNumbers: true, text: { en: 'Gas Safe 123456' } },
  },
  blocks: [{ type: 'heading', id: 'title', text: { en: '{{form.title}}' }, level: 1 }],
};

describe('version 1 designs', () => {
  it('upgrade to version 2 with the classic look and their footer in two places', () => {
    const design = parsed(V1);
    expect(design.schemaVersion).toBe(2);
    expect(design.style).toEqual({
      brandColour: null,
      font: 'noto-sans',
      tableLines: 'light',
      stripedRows: false,
      headerShading: true,
    });
    expect(design.page.header).toBeNull();
    expect(design.page.footer).toEqual({
      start: { kind: 'text', text: { en: 'Gas Safe 123456' }, bold: false },
      center: null,
      end: { kind: 'page' },
      notOnFirstPage: false,
    });
    const off = parsed({ ...V1, page: { ...V1.page, footer: { pageNumbers: false } } });
    expect(off.page.footer.start).toBeNull();
    expect(off.page.footer.end).toBeNull();
    // A version 2 design is left alone.
    expect(upgradeDesign(emptyDesign())).toEqual(emptyDesign());
  });

  it('print as they always did: no colour rules, no header, the same footer markup', () => {
    const rendered = renderDocumentHtml(input(parsed(V1)));
    expect(rendered.hasHeader).toBe(false);
    expect(rendered.firstPage).toBeUndefined();
    expect(rendered.landscape).toBe(false);
    expect(rendered.html).toContain('@page { size: A4 portrait;');
    expect(rendered.html).not.toContain('.blk');
    expect(rendered.html).not.toContain('h1, h2, h3 { color');
    expect(rendered.footerHtml).toBe(
      `<div dir="ltr" style="width:100%;font-family:${DOCUMENT_FONTS['noto-sans'].text};font-size:8pt;color:#3b4450;padding-inline-start:15mm;padding-inline-end:15mm;box-sizing:border-box;display:flex;justify-content:space-between;gap:4mm;margin-bottom:10mm;"><span>Gas Safe 123456</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
    );
  });
});

describe('the document look', () => {
  const header = {
    start: { kind: 'logo' as const, height: 12 },
    center: { kind: 'text' as const, text: { en: 'Job {{work_order.reference}}' }, bold: true },
    end: { kind: 'page' as const },
    notOnFirstPage: false,
  };

  it('makes a header with three places, placeholders filled and page numbers left to Chromium', () => {
    const parts = documentLook(
      { brandColour: '#0e7490', fontKey: 'integr8-text', logo: LOGO, header },
      {
        locale: 'en',
        margins: { top: 25, end: 15, bottom: 20, start: 15 },
        placeholder: (scope, name) =>
          scope === 'work_order' && name === 'reference' ? 'WO-000042' : undefined,
      },
    );
    expect(parts.hasHeader).toBe(true);
    expect(parts.hasFooter).toBe(false);
    expect(parts.headerHtml).toContain(`<img src="${LOGO}"`);
    expect(parts.headerHtml).toContain('<b>Job WO-000042</b>');
    expect(parts.headerHtml).toContain('<span class="pageNumber"></span>');
    expect(parts.headerHtml).toContain('grid-template-columns');
    expect(parts.css).toContain('--doc-brand: #0e7490');
    expect(parts.css).toContain("'Inter Variable'");
  });

  it('mirrors in Arabic and leaves a band off the first page through its own templates', () => {
    const parts = documentLook(
      {
        brandColour: null,
        fontKey: 'noto-naskh',
        header: { ...header, notOnFirstPage: true },
        footer: { start: null, center: { kind: 'page' }, end: null, notOnFirstPage: false },
      },
      { locale: 'ar', margins: { top: 25, end: 15, bottom: 20, start: 15 } },
    );
    expect(parts.headerHtml).toContain('dir="rtl"');
    expect(parts.footerHtml).toContain('صفحة');
    expect(parts.firstPage).toEqual({
      headerHtml: '<span></span>',
      hasHeader: false,
      footerHtml: parts.footerHtml,
      hasFooter: true,
    });
  });

  it('escapes what people typed and never takes an image that is not a data URI', () => {
    const parts = documentLook(
      {
        brandColour: null,
        fontKey: 'noto-sans',
        logo: 'https://evil.example/logo.png',
        header: {
          start: { kind: 'text', text: { en: '<script>x</script>' }, bold: false },
          center: { kind: 'logo', height: 10 },
          end: null,
          notOnFirstPage: false,
        },
      },
      { locale: 'en', margins: { top: 20, end: 15, bottom: 20, start: 15 } },
    );
    expect(parts.headerHtml).toContain('&lt;script&gt;');
    expect(parts.headerHtml).not.toContain('evil.example');
  });

  it('tints the brand colour for shading and falls back to black', () => {
    expect(tintOf('#000000', 0.5)).toBe('#808080');
    expect(lookColours('#2563eb').brand).toBe('#2563eb');
    expect(lookColours(null).brand).toBe('#111418');
    expect(lookColours('red').brand).toBe('#111418');
  });

  it('embeds a website font from the files the caller resolves, leaving out those it cannot', () => {
    const rules = fontFaceRules('integr8-display', (face) =>
      face.family === 'Unbounded Variable' ? null : `data:font/woff2;base64,AA${face.weight}`,
    );
    expect(rules).toContain("font-family:'Inter Variable'");
    expect(rules).toContain("font-family:'Alexandria Variable'");
    expect(rules).not.toContain('Unbounded');
    expect(fontFaceRules('noto-sans', () => 'x')).toBe('');
  });
});

describe('the template style', () => {
  it('prints the company colour, a landscape page, table lines and block colours', () => {
    const base = emptyDesign();
    const design = parsed({
      ...base,
      page: { ...base.page, orientation: 'landscape', header: null },
      style: { ...base.style, tableLines: 'none', stripedRows: true, font: 'integr8-display' },
      blocks: [
        { type: 'heading', id: 'title', text: { en: 'Report' }, level: 1, colour: 'red' },
        { type: 'text', id: 'note', text: { en: 'Note' }, shaded: true },
        { type: 'fields_table', id: 'facts', rows: [{ fieldId: 'customer' }] },
      ],
    });
    const rendered = renderDocumentHtml(
      input(design, { companyBrandColour: '#0e7490', fontFaceCss: '@font-face{}' }),
    );
    expect(rendered.landscape).toBe(true);
    expect(rendered.html).toContain('@page { size: A4 landscape;');
    expect(rendered.html).toContain('h1, h2, h3, .table-title { color: #0e7490; }');
    expect(rendered.html).toContain('table.t th, table.t td { border: 0; }');
    expect(rendered.html).toContain('nth-child(even)');
    expect(rendered.html).toContain("h1, h2, h3 { font-family: 'Unbounded Variable'");
    expect(rendered.html).toContain('@font-face{}');
    expect(rendered.html).toContain('<div class="blk c-red"><h1');
    expect(rendered.html).toContain('<div class="blk shaded"><p');
  });

  it('draws the header and footer on the preview sheet, landscape sized', () => {
    const base = emptyDesign();
    const design = parsed({
      ...base,
      page: {
        ...base.page,
        orientation: 'landscape',
        header: {
          start: { kind: 'text', text: { en: '{{company.name}}' } },
          notOnFirstPage: true,
        },
      },
    });
    const rendered = renderDocumentHtml(input(design, { mode: 'preview' }));
    expect(rendered.html).toContain('width: 297mm; min-height: 210mm;');
    expect(rendered.html).toContain('<div class="band" style="top:');
    expect(rendered.html).toContain('Acme Heating');
    expect(rendered.html).toContain('Page 1 of 1');
  });

  it('knows when a design uses the logo', () => {
    const base = emptyDesign();
    expect(designUsesLogo(base)).toBe(false);
    expect(
      designUsesLogo(
        parsed({
          ...base,
          page: { ...base.page, footer: { ...base.page.footer, start: { kind: 'logo' } } },
        }),
      ),
    ).toBe(true);
  });
});

describe('questions the form no longer has', () => {
  const design = parsed({
    ...emptyDesign(),
    blocks: [
      { type: 'field', id: 'pressure', fieldId: 'pressure' },
      { type: 'fields_table', id: 'only_gone', rows: [{ fieldId: 'pressure' }] },
      {
        type: 'fields_table',
        id: 'mixed',
        rows: [{ fieldId: 'pressure' }, { fieldId: 'customer' }],
      },
      {
        type: 'repeat_table',
        id: 'parts',
        sectionId: 'parts',
        columns: [{ fieldId: 'part_name' }],
      },
      { type: 'text', id: 'line', text: { en: 'P: {{answer.pressure}}.' } },
    ],
  });

  it('are named by block, for the designer to mark', () => {
    const issues = checkDesignAgainstForm(design, compile(false));
    expect([...issueTargets(issues).blocks].sort()).toEqual([
      'mixed',
      'only_gone',
      'parts',
      'pressure',
    ]);
  });

  it('never stop a document: blocks are left out, rows dropped, placeholders blank', () => {
    const rendered = renderDocumentHtml(input(design, { form: compile(false) }));
    expect(rendered.html).not.toContain('Pressure');
    expect(rendered.html).toContain('Customer');
    expect(rendered.html).toContain('P: .');
    expect(rendered.html).not.toContain('class="t grid"');
  });

  it('still print for a submission made on the version that had them', () => {
    const rendered = renderDocumentHtml(input(design));
    expect(rendered.html).toContain('Pressure');
    expect(rendered.html).toContain('P: 1.5.');
  });
});

describe('sample answers', () => {
  it('give every question a value of its kind, and repeating sections three entries', () => {
    const answers = sampleAnswers(compile(), 'ar', '2026-11-01');
    expect(answers.customer).toBe('إجابة تجريبية');
    expect(answers.pressure).toBe('2.5');
    expect(answers.kind).toBe('combi');
    expect(Array.isArray(answers.parts) && answers.parts.length).toBe(3);
  });
});
