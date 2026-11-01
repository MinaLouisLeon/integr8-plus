import { compileDefinition, type CompiledForm } from '@integr8/form-engine';
import { describe, expect, it } from 'vitest';
import {
  checkDesignAgainstForm,
  designFileIds,
  designMediaFields,
  emptyDesign,
  parseDesign,
  type TemplateDesign,
} from './design.js';
import { resolveDocumentFields, type SubmissionFacts } from './fields.js';
import { escapeHtml, renderDocumentHtml } from './html.js';
import { qrSvg } from './qr.js';

/**
 * The template format and the renderer, without a browser: what a design may
 * say, what it may name in its form, and what the HTML it prints contains.
 * The PDF itself is the server's test.
 */

function compile(): CompiledForm {
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
              { id: 'safe', type: 'yes_no', label: { en: 'Safe to use', ar: 'آمن للاستخدام' } },
              {
                id: 'gas_off',
                type: 'checkbox',
                label: { en: 'Gas turned off', ar: 'تم إغلاق الغاز' },
              },
              {
                id: 'kind',
                type: 'radio',
                label: { en: 'Kind', ar: 'النوع' },
                options: [
                  { value: 'combi', label: { en: 'Combi', ar: 'مدمجة' } },
                  { value: 'system', label: { en: 'System', ar: 'نظام' } },
                ],
              },
              {
                id: 'pressure',
                type: 'decimal',
                decimalPlaces: 1,
                unit: 'bar',
                label: { en: 'Pressure', ar: 'الضغط' },
              },
              { id: 'photos', type: 'photo', label: { en: 'Photos', ar: 'الصور' } },
              {
                id: 'serviced_on',
                type: 'date',
                label: { en: 'Serviced on', ar: 'تاريخ الصيانة' },
              },
            ],
          },
          {
            id: 'parts',
            repeat: { maxEntries: 20, entryLabel: { en: 'Part', ar: 'قطعة' } },
            fields: [
              { id: 'part_name', type: 'text', label: { en: 'Part', ar: 'القطعة' } },
              { id: 'quantity', type: 'number', label: { en: 'Qty', ar: 'الكمية' } },
            ],
          },
        ],
      },
    ],
  });
  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }
  return result.form;
}

const form = compile();
const PHOTO = '00000000-0000-4000-8000-0000000000a1';
const BACKGROUND = '00000000-0000-4000-8000-0000000000b1';

const answers = {
  customer: 'Riverside <Housing> & Co',
  safe: 'yes',
  gas_off: true,
  kind: 'combi',
  pressure: '1.5',
  photos: [{ mediaId: PHOTO, contentType: 'image/jpeg', byteSize: 1000 }],
  serviced_on: '2026-10-16',
  parts: [
    { id: 'e1', values: { part_name: 'Valve', quantity: 2 } },
    { id: 'e2', values: { part_name: 'Seal', quantity: 1 } },
  ],
};

const facts: SubmissionFacts = {
  companyName: 'Acme Heating',
  formTitle: 'Boiler service',
  submittedAt: '2026-10-16T09:30:00.000Z',
  submittedBy: 'Sam Engineer',
  workOrderReference: 'WO-000042',
  assetReference: null,
  documentDate: '2026-10-16T10:00:00.000Z',
  timeZone: 'Africa/Cairo',
};

function design(overrides: Partial<TemplateDesign> = {}): TemplateDesign {
  const base = emptyDesign();
  return {
    ...base,
    page: { ...base.page, background: { fileId: BACKGROUND } },
    fields: [
      {
        key: 'certificate',
        label: { en: 'Certificate number', ar: 'رقم الشهادة' },
        source: { kind: 'typed', required: true, maxLength: 40 },
        lookup: 'key',
      },
      {
        key: 'customer',
        label: { en: 'Customer', ar: 'العميل' },
        source: { kind: 'answer', fieldId: 'customer' },
        lookup: 'none',
      },
    ],
    blocks: [
      {
        type: 'heading',
        id: 'title',
        text: { en: '{{form.title}} — {{field.certificate}}' },
        level: 1,
        align: 'start',
      },
      {
        type: 'text',
        id: 'intro',
        text: { en: 'For {{answer.customer}} by {{company.name}}' },
        align: 'start',
        size: 'normal',
        bold: false,
      },
      { type: 'checkbox', id: 'safe', fieldId: 'safe', align: 'start' } as never,
      { type: 'options', id: 'kind', fieldId: 'kind', columns: 2 },
      {
        type: 'fields_table',
        id: 'facts',
        rows: [{ fieldId: 'pressure' }, { fieldId: 'serviced_on' }],
      },
      {
        type: 'repeat_table',
        id: 'parts',
        sectionId: 'parts',
        numbered: true,
        columns: [{ fieldId: 'part_name' }, { fieldId: 'quantity', width: 20 }],
      },
      {
        type: 'image',
        id: 'photos',
        source: { kind: 'answer', fieldId: 'photos' },
        width: 40,
        align: 'start',
      },
      {
        type: 'row',
        id: 'foot',
        columns: [
          {
            width: 2,
            blocks: [{ type: 'field', id: 'gas', fieldId: 'gas_off', layout: 'inline' }],
          },
          { width: 1, blocks: [{ type: 'qr', id: 'qr', size: 30, align: 'end' }] },
        ],
      },
    ],
    ...overrides,
  };
}

function parsed(input: unknown): TemplateDesign {
  const result = parseDesign(input);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }
  return result.design;
}

describe('parseDesign', () => {
  it('accepts a new template and fills in the defaults', () => {
    const result = parseDesign({
      schemaVersion: 1,
      page: { margins: { top: 20, end: 15, bottom: 20, start: 15 } },
      blocks: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.design.page).toMatchObject({
        size: 'A4',
        background: null,
        firstPage: null,
        fontSize: 10,
      });
      // A version 1 design, upgraded: page numbers at the end of the footer, the classic look.
      expect(result.design.schemaVersion).toBe(2);
      expect(result.design.page.footer.end).toEqual({ kind: 'page' });
      expect(result.design.page.orientation).toBe('portrait');
      expect(result.design.style.brandColour).toBeNull();
    }
  });

  it('refuses a landscape page, a margin past 60 mm and an unknown block', () => {
    expect(
      parseDesign({ ...emptyDesign(), page: { ...emptyDesign().page, size: 'A4-landscape' } }).ok,
    ).toBe(false);
    expect(
      parseDesign({
        ...emptyDesign(),
        page: { ...emptyDesign().page, margins: { top: 61, end: 0, bottom: 0, start: 0 } },
      }).ok,
    ).toBe(false);
    expect(parseDesign({ ...emptyDesign(), blocks: [{ type: 'script', id: 'x' }] }).ok).toBe(false);
  });

  it('refuses two blocks with one id, and a second lookup field with no first', () => {
    const twice = parseDesign({
      ...emptyDesign(),
      blocks: [
        { type: 'divider', id: 'a' },
        { type: 'divider', id: 'a' },
      ],
    });
    expect(twice.ok === false && twice.issues[0]?.code).toBe('duplicate_block_id');
    const lonely = parseDesign({
      ...emptyDesign(),
      fields: [{ key: 'pin', label: { en: 'PIN' }, source: { kind: 'typed' }, lookup: 'confirm' }],
    });
    expect(lonely.ok === false && lonely.issues[0]?.code).toBe('lookup_roles');
  });

  it('lets the first page differ, with its own image or none', () => {
    const own = parsed({
      ...emptyDesign(),
      page: { ...emptyDesign().page, firstPage: { background: { fileId: PHOTO } } },
    });
    expect(own.page.firstPage).toEqual({ background: { fileId: PHOTO }, topMargin: null });
    const plain = parsed({
      ...emptyDesign(),
      page: { ...emptyDesign().page, firstPage: { background: null } },
    });
    expect(plain.page.firstPage).toEqual({ background: null, topMargin: null });
    const taller = parsed({
      ...emptyDesign(),
      page: { ...emptyDesign().page, firstPage: { background: null, topMargin: 45 } },
    });
    expect(taller.page.firstPage?.topMargin).toBe(45);
    expect(() =>
      parsed({
        ...emptyDesign(),
        page: { ...emptyDesign().page, firstPage: { background: null, topMargin: 200 } },
      }),
    ).toThrow();
  });
});

describe('checkDesignAgainstForm', () => {
  it('accepts a design that names the form as it is', () => {
    expect(checkDesignAgainstForm(parsed(design()), form)).toEqual([]);
  });

  it('names a missing field, the wrong kind, an unknown option and a section that does not repeat', () => {
    const wrong = parsed({
      ...emptyDesign(),
      blocks: [
        { type: 'field', id: 'a', fieldId: 'nope' },
        { type: 'options', id: 'b', fieldId: 'customer' },
        { type: 'checkbox', id: 'c', fieldId: 'kind', option: 'boiler' },
        { type: 'repeat_table', id: 'd', sectionId: 'details', columns: [{ fieldId: 'customer' }] },
        { type: 'field', id: 'e', fieldId: 'part_name' },
        { type: 'image', id: 'f', source: { kind: 'answer', fieldId: 'customer' } },
      ],
    });
    expect(checkDesignAgainstForm(wrong, form).map((issue) => issue.code)).toEqual([
      'unknown_field',
      'wrong_field_type',
      'unknown_option',
      'not_repeating',
      'outside_section',
      'wrong_field_type',
    ]);
  });

  it('lists the images and the photo fields a design needs', () => {
    const value = parsed(design());
    expect(designFileIds(value)).toEqual([BACKGROUND]);
    expect(designMediaFields(value, form)).toEqual(['photos']);
  });
});

describe('resolveDocumentFields', () => {
  it('takes typed values and answers, and keeps the lookup role', () => {
    const result = resolveDocumentFields({
      design: parsed(design()),
      form,
      answers,
      typed: { certificate: '  CERT-0042 ' },
      facts,
      locale: 'en',
    });
    expect(result).toEqual({
      ok: true,
      fields: [
        {
          key: 'certificate',
          label: { en: 'Certificate number', ar: 'رقم الشهادة' },
          value: 'CERT-0042',
          lookupRole: 'key',
        },
        {
          key: 'customer',
          label: { en: 'Customer', ar: 'العميل' },
          value: 'Riverside <Housing> & Co',
          lookupRole: null,
        },
      ],
    });
  });

  it('refuses a required field left empty, a value too long, and a key the template has not', () => {
    const empty = resolveDocumentFields({
      design: parsed(design()),
      form,
      answers,
      typed: {},
      facts,
      locale: 'en',
    });
    expect(empty).toEqual({ ok: false, problems: [{ key: 'certificate', code: 'required' }] });
    const long = resolveDocumentFields({
      design: parsed(design()),
      form,
      answers,
      typed: { certificate: 'x'.repeat(41), other: 'y' },
      facts,
      locale: 'en',
    });
    expect(long.ok === false && long.problems).toEqual([
      { key: 'other', code: 'unknown' },
      { key: 'certificate', code: 'too_long' },
    ]);
  });
});

describe('renderDocumentHtml', () => {
  const render = (overrides: Partial<Parameters<typeof renderDocumentHtml>[0]> = {}) =>
    renderDocumentHtml({
      design: parsed(design()),
      form,
      answers,
      locale: 'en',
      facts,
      fields: [
        { key: 'certificate', label: { en: 'Certificate' }, value: 'CERT-0042', lookupRole: 'key' },
      ],
      qrUrl: 'https://app.example/d/AbCdEfGhIjKlMnOpQrStUv',
      images: { logo: null, files: {}, media: { [PHOTO]: 'data:image/jpeg;base64,AAAA' } },
      mode: 'pdf',
      ...overrides,
    });

  it('fills placeholders and escapes everything anyone typed', () => {
    const { html } = render();
    expect(html).toContain('Boiler service — CERT-0042');
    expect(html).toContain('For Riverside &lt;Housing&gt; &amp; Co by Acme Heating');
    expect(html).not.toContain('<Housing>');
  });

  it('ticks the boxes the answers tick, and leaves the others empty', () => {
    const { html } = render();
    expect(html.match(/class="box on"/gu)).toHaveLength(2);
    expect(html).toContain('Combi');
    expect(html).toContain('System');
  });

  it('prints one numbered row per repeating entry, and formats numbers with their unit', () => {
    const { html } = render();
    expect(html).toMatch(/<td class="num">1<\/td><td dir="auto">Valve<\/td>/u);
    expect(html).toMatch(/<td class="num">2<\/td><td dir="auto">Seal<\/td>/u);
    expect(html).toContain('1.5 bar');
    expect(html).toContain('October 16, 2026');
  });

  it('draws the photo and the QR code, and keeps the page transparent for the backgrounds', () => {
    const { html, margins, hasFooter, footerHtml } = render();
    expect(html).toContain('src="data:image/jpeg;base64,AAAA"');
    expect(html).toContain('<path d="M');
    expect(html).toContain('background: transparent');
    expect(html).toContain('@page { size: A4 portrait; margin: 20mm 15mm 20mm 15mm; }');
    expect(margins).toEqual({ top: 20, end: 15, bottom: 20, start: 15 });
    expect(hasFooter).toBe(true);
    expect(footerHtml).toContain('<span class="pageNumber"></span>');
  });

  it('gives the first page its own top margin when the template asks', () => {
    const base = design();
    const { html } = render({
      design: {
        ...base,
        page: { ...base.page, firstPage: { background: null, topMargin: 45 } },
      },
    });
    expect(html).toContain('@page :first { margin-top: 45mm; }');
    expect(render().html).not.toContain('@page :first');
  });

  it('writes Arabic right to left, in Arabic words', () => {
    const { html, footerHtml } = render({ locale: 'ar' });
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('مدمجة');
    expect(footerHtml).toContain('صفحة');
  });

  it('drops an image source that is not a data URI or an https or same-origin URL', () => {
    const { html } = render({
      images: { logo: null, files: {}, media: { [PHOTO]: 'javascript:alert(1)' } },
    });
    expect(html).not.toContain('javascript:');
  });

  it('shows placeholders and the backgrounds in a preview made before there is a link', () => {
    const { html } = render({
      mode: 'preview',
      qrUrl: null,
      images: { logo: null, files: { [BACKGROUND]: 'data:image/png;base64,BBBB' }, media: {} },
    });
    expect(html).toContain('class="qr placeholder"');
    expect(html).toContain('url("data:image/png;base64,BBBB")');
    expect(html).toContain('class="sheet"');
  });
});

describe('qrSvg and escapeHtml', () => {
  it('draws a square code on white', () => {
    const svg = qrSvg('https://app.example/d/AbCdEfGhIjKlMnOpQrStUv');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('fill="#ffffff"');
  });

  it('escapes every character that could start markup', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});

describe('Information blocks (form schema version 2)', () => {
  const withInformation = (() => {
    const result = compileDefinition({
      schemaVersion: 2,
      title: { en: 'Boiler service' },
      pages: [
        {
          id: 'main',
          sections: [
            {
              id: 'details',
              fields: [
                { id: 'safe', type: 'yes_no', label: { en: 'Safe to use' } },
                {
                  id: 'warning',
                  type: 'information',
                  heading: { en: 'Do not use', ar: 'لا تستخدم' },
                  body: { en: 'Capped off.\nCall <us>.', ar: 'مغلق.' },
                  style: 'warning',
                  visibleWhen: {
                    kind: 'compare',
                    operator: 'eq',
                    left: { kind: 'answer', field: 'safe' },
                    right: { kind: 'text', value: 'no' },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    if (!result.ok) {
      throw new Error(JSON.stringify(result.issues));
    }
    return result.form;
  })();
  const printed = (answered: Record<string, unknown>) =>
    renderDocumentHtml({
      design: parsed(
        design({
          fields: [],
          blocks: [{ type: 'information', id: 'b1', informationId: 'warning' }],
        }),
      ),
      form: withInformation,
      answers: answered,
      locale: 'en',
      facts,
      fields: [],
      qrUrl: null,
      images: { logo: null, files: {}, media: {} },
      mode: 'pdf',
    }).html;

  it('prints a block the template places, when the form shows it, as plain text', () => {
    const html = printed({ safe: 'no' });
    expect(html).toContain('class="info info-warning"');
    expect(html).toContain('Do not use');
    expect(html).toContain('Capped off.<br>Call &lt;us&gt;.');
    expect(printed({ safe: 'yes' })).not.toContain('Do not use');
  });

  it('names a block that is not one of the form’s Information blocks', () => {
    const checked = checkDesignAgainstForm(
      parsed(
        design({
          fields: [],
          blocks: [
            { type: 'information', id: 'b1', informationId: 'safe' },
            { type: 'information', id: 'b2', informationId: 'warning' },
          ],
        }),
      ),
      withInformation,
    );
    expect(checked).toEqual([
      expect.objectContaining({ path: 'blocks.b1', code: 'unknown_field' }),
    ]);
  });
});
