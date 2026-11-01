import { describe, expect, it } from 'vitest';
import { defaultLook, DEFAULT_BRAND_COLOUR, lookTemplates, safeColour } from './look.js';
import type { BusinessDocumentKind, BusinessLocale, BusinessRenderInput } from './model.js';
import { renderBusinessDocumentHtml } from './render.js';
import {
  sampleDocument,
  sampleInvoice,
  sampleJobReport,
  samplePurchaseOrder,
  sampleQuote,
} from './samples.js';

/**
 * The business layouts without a browser: what each page says, in which
 * language and direction, and that nothing anyone typed becomes markup. The
 * PDF itself is printed by the server's own test and by the sample command.
 */

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function input(
  overrides: Partial<BusinessRenderInput> & { data: BusinessRenderInput['data'] },
): BusinessRenderInput {
  return {
    locale: 'en',
    timeZone: 'Africa/Cairo',
    qrUrl: 'https://app.example.com/d/abcdefghijklmnopqrstuv',
    images: { logo: null, media: {} },
    look: defaultLook({ brandColour: '#0e7490' }),
    ...overrides,
  };
}

const KINDS: readonly BusinessDocumentKind[] = ['quote', 'invoice', 'purchase_order', 'job_report'];
const LOCALES: readonly BusinessLocale[] = ['en', 'ar'];

describe('every business layout', () => {
  for (const kind of KINDS) {
    for (const locale of LOCALES) {
      it(`prints a ${kind} in ${locale}, with its reference, a QR code and page numbers`, () => {
        const data = sampleDocument(kind, locale);
        const page = renderBusinessDocumentHtml(input({ data, locale }));
        expect(page.html).toContain(`lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`);
        expect(page.html).toContain(data.reference);
        expect(page.html).toContain('<svg');
        expect(page.footerHtml).toContain('<span class="pageNumber"></span>');
        expect(page.footerHtml).toContain('<span class="totalPages"></span>');
        expect(page.footerHtml).toContain(data.reference);
        expect(page.headerHtml).toContain(data.issuer.name);
        expect(page.html).toContain('--brand: #0e7490');
        // Logical sides only, so Arabic mirrors.
        expect(page.html).not.toMatch(/text-align:\s*(left|right)/u);
      });
    }
  }
});

describe('the quote', () => {
  it('carries what the browser-printed quote carries', () => {
    const data = sampleQuote('en');
    const page = renderBusinessDocumentHtml(input({ data }));
    for (const text of [
      'Quote',
      'Valid until 27 November 2026',
      'Horizon Business Park',
      'Mona Adel',
      'Thank you for your enquiry',
      'Terms',
      'Gross',
      'Net',
      '10%',
      '14%',
    ]) {
      expect(page.html).toContain(text);
    }
    // Intl puts a no-break space between the currency and the amount.
    expect(page.html).toMatch(/EGP\s22,537\.80/u);
    expect(page.title).toBe('Quote QT-000042-R2');
  });

  it('says how it was answered, and that it was withdrawn', () => {
    const answered = renderBusinessDocumentHtml(
      input({
        data: {
          ...sampleQuote('en'),
          status: 'accepted',
          answer: { status: 'accepted', at: '2026-10-29T08:00:00Z', name: 'Mona Adel' },
        },
      }),
    );
    expect(answered.html).toContain('Accepted on');
    expect(answered.html).toContain('by Mona Adel');
    const withdrawn = renderBusinessDocumentHtml(
      input({ data: { ...sampleQuote('en'), status: 'cancelled' } }),
    );
    expect(withdrawn.html).toContain('class="stamp">Withdrawn');
  });

  it('says what its QR code opens', () => {
    const toQuote = renderBusinessDocumentHtml(
      input({
        data: sampleQuote('en'),
        qrUrl: 'https://app.example.com/q/token',
        qrOpensQuote: true,
      }),
    );
    expect(toQuote.html).toContain('Scan to read and answer this quote online.');
    const none = renderBusinessDocumentHtml(input({ data: sampleQuote('en'), qrUrl: null }));
    expect(none.html).not.toContain('<svg');
  });

  it('leaves out discount columns when no line has one', () => {
    const data = sampleQuote('en');
    const page = renderBusinessDocumentHtml(
      input({ data: { ...data, lines: data.lines.map((line) => ({ ...line, discountBp: 0 })) } }),
    );
    expect(page.html).not.toContain('>Discount<');
    expect(page.html).not.toContain('>Gross<');
  });
});

describe('the invoice', () => {
  it('shows credits, payments, the balance and how to pay', () => {
    const page = renderBusinessDocumentHtml(input({ data: sampleInvoice('en') }));
    for (const text of [
      'Invoice',
      'Bill to',
      'Due 29 November 2026',
      'Credited',
      'Paid',
      'Balance due',
      'CN-000021',
      'RCPT-000140',
      'How to pay',
      'National Bank of Egypt',
      'Tax number',
    ]) {
      expect(page.html).toContain(text);
    }
    expect(page.html).toMatch(/Balance due<\/th><td class="num">EGP\s12,037\.80/u);
  });

  it('marks a void invoice', () => {
    const page = renderBusinessDocumentHtml(
      input({ data: { ...sampleInvoice('en'), status: 'void' } }),
    );
    expect(page.html).toContain('class="stamp">Void');
  });

  it('is in Arabic, right to left, with Arabic words', () => {
    const page = renderBusinessDocumentHtml(input({ data: sampleInvoice('ar'), locale: 'ar' }));
    expect(page.html).toContain('dir="rtl"');
    expect(page.html).toContain('فاتورة');
    expect(page.html).toContain('الرصيد المستحق');
    expect(page.footerHtml).toContain('صفحة');
    // A reference reads left to right inside Arabic.
    expect(page.html).toContain('<bdi dir="ltr" class="nowrap">INV-000317</bdi>');
  });
});

describe('the purchase order', () => {
  it('names the supplier, delivery, codes and totals', () => {
    const page = renderBusinessDocumentHtml(input({ data: samplePurchaseOrder('en') }));
    for (const text of [
      'Purchase order',
      'Delta HVAC Parts',
      'orders@deltahvac.example',
      'Deliver to',
      'Main warehouse',
      'FLT-G4-592',
      'Expected 5 November 2026',
    ]) {
      expect(page.html).toContain(text);
    }
    expect(page.html).toMatch(/EGP\s45,155\.40/u);
  });

  it('prints no prices when the snapshot has none', () => {
    const data = samplePurchaseOrder('en');
    const page = renderBusinessDocumentHtml(
      input({
        data: {
          ...data,
          totals: null,
          lines: data.lines.map((line) => ({ ...line, unitPrice: null, subtotal: null })),
        },
      }),
    );
    expect(page.html).not.toContain('Unit price');
    expect(page.html).not.toContain('EGP');
  });
});

describe('the job report', () => {
  it('covers the job from the customer to the sign-off', () => {
    const page = renderBusinessDocumentHtml(
      input({
        data: sampleJobReport('en', ['p1', 'p2', 'p4', 'p5'], 'sig'),
        images: { logo: PNG, media: { p1: PNG, p2: PNG, p5: PNG, sig: PNG } },
      }),
    );
    for (const text of [
      'Job report',
      'WO-000512',
      'Horizon Business Park',
      'Building B2',
      'Coordinates: 30.019874, 31.491302',
      'https://www.google.com/maps/search/?api=1&amp;query=30.019874,31.491302',
      'Planned maintenance',
      'Complete',
      'Visits',
      'Omar Khaled, Youssef Ibrahim',
      'Time on site',
      '8 h 50 min',
      'Parts used',
      'Serial numbers: ',
      'PS-88213, PS-88214',
      'Batches: ',
      'Planned maintenance checklist',
      'Service certificate',
      'Checklist',
      'Before',
      'After',
      'Signed by Hassan Farouk, Facilities manager',
      'Notes for the customer',
    ]) {
      expect(page.html).toContain(text);
    }
    // Three photos had pictures; the third had none and is left out.
    expect(page.html.match(/class="photo"/gu)).toHaveLength(3);
    expect(page.html).toContain('class="signature"');
    expect(page.html).toContain('class="logo"');
  });

  it('says how many photos were left out, with Arabic plurals', () => {
    const many = renderBusinessDocumentHtml(
      input({ data: { ...sampleJobReport('en'), morePhotos: 4 } }),
    );
    expect(many.html).toContain('4 more photos are kept with the job');
    const two = renderBusinessDocumentHtml(
      input({ data: { ...sampleJobReport('ar'), morePhotos: 2 }, locale: 'ar' }),
    );
    expect(two.html).toContain('صورتان أخريان');
  });

  it('says why the customer could not sign, and when nobody has', () => {
    const data = sampleJobReport('en');
    const unavailable = renderBusinessDocumentHtml(
      input({
        data: {
          ...data,
          signoff: {
            signedAt: '2026-10-30T13:41:00Z',
            name: null,
            role: null,
            signatureFileId: null,
            unavailableReason: 'Nobody on site',
          },
        },
      }),
    );
    expect(unavailable.html).toContain('The customer could not sign: Nobody on site');
    const none = renderBusinessDocumentHtml(input({ data: { ...data, signoff: null } }));
    expect(none.html).toContain('Not signed off yet.');
  });
});

describe('safety', () => {
  it('escapes everything anyone typed', () => {
    const data = sampleQuote('en');
    const page = renderBusinessDocumentHtml(
      input({
        data: {
          ...data,
          title: '<script>alert(1)</script>',
          customerName: '"><img src=x onerror=alert(1)>',
          lines: [{ ...data.lines[0]!, description: '<b>bold</b>' }],
        },
      }),
    );
    expect(page.html).not.toContain('<script>');
    expect(page.html).not.toContain('<img src=x');
    expect(page.html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('prints only pictures inlined as data, never a link', () => {
    const page = renderBusinessDocumentHtml(
      input({
        data: sampleJobReport('en', ['p1'], null),
        images: { logo: 'https://evil.example/logo.png', media: { p1: 'javascript:alert(1)' } },
        look: defaultLook({ brandColour: null, logo: 'https://evil.example/logo.png' }),
      }),
    );
    expect(page.html).not.toContain('evil.example');
    expect(page.html).not.toContain('javascript:');
  });

  it('takes only a colour as the brand colour', () => {
    expect(safeColour('#ABCDEF')).toBe('#abcdef');
    expect(safeColour('red; background: url(x)')).toBe(DEFAULT_BRAND_COLOUR);
    expect(safeColour(null)).toBe(DEFAULT_BRAND_COLOUR);
  });
});

describe('the look', () => {
  it('puts the bands in three places, page numbers included, escaped', () => {
    const templates = lookTemplates(
      {
        brandColour: '#123456',
        fontKey: 'noto-naskh',
        header: { start: '<Company>', centre: '{{reference}}', end: 'Page {{page}} of {{pages}}' },
        footer: null,
      },
      {
        direction: 'rtl',
        margins: { top: 20, bottom: 20, start: 15, end: 15 },
        values: { reference: 'INV-1' },
      },
    );
    expect(templates.headerHtml).toContain('&lt;Company&gt;');
    expect(templates.headerHtml).toContain('INV-1');
    expect(templates.headerHtml).toContain('<span class="pageNumber"></span>');
    expect(templates.headerHtml).toContain('dir="rtl"');
    expect(templates.footerHtml).toBe('<span></span>');
    expect(templates.css).toContain('Noto Naskh Arabic');
  });
});
