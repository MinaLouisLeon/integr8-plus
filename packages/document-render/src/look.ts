import { localizedTextSchema } from '@integr8/form-engine';
import { z } from 'zod';
import { documentFont, type DocumentFontKey } from './fonts.js';
import { type DocumentLocale, wordsFor } from './words.js';

/**
 * A document's look (docs/documents ADR-0001, addendum 1.3.0): a brand colour,
 * a font, and a header and footer with three places each. PDF templates
 * carry one in their design; the server's other branded PDFs (quotes,
 * invoices, purchase orders, job reports) build one from the company's
 * settings. Either way {@link documentLook} turns it into what Chromium needs:
 * base CSS for the page, and the header and footer templates.
 *
 * Chromium draws headers and footers as separate little pages: they see none
 * of the document's styles, so everything they need — fonts included — is
 * inlined here, and images are data URIs. A band set "not on the first page"
 * cannot be expressed in a template at all (there is no script and no
 * selector for a page number), so {@link LookParts.firstPage} carries the
 * first page's own templates and the printer prints that page separately.
 */

const millimetres = (min: number, max: number) => z.number().min(min).max(max);

export const marginsSchema = z.object({
  top: millimetres(0, 60),
  end: millimetres(0, 60),
  bottom: millimetres(0, 60),
  start: millimetres(0, 60),
});
export type Margins = z.infer<typeof marginsSchema>;

export const hexColourSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/u);

/** One of the three places of a header or footer. */
export const headerFooterSlotSchema = z.discriminatedUnion('kind', [
  /** The company's logo, this tall in millimetres. */
  z.object({ kind: z.literal('logo'), height: millimetres(4, 40).default(12) }),
  /**
   * Text with placeholders: `{{page.number}}`, `{{page.count}}`, and whatever
   * the document fills (`{{field.<key>}}`, `{{work_order.reference}}`,
   * `{{document.date}}`, `{{company.name}}`, …).
   */
  z.object({
    kind: z.literal('text'),
    text: localizedTextSchema,
    bold: z.boolean().default(false),
  }),
  /** "Page 2 of 5", in the document's language. */
  z.object({ kind: z.literal('page') }),
]);
export type HeaderFooterSlot = z.infer<typeof headerFooterSlotSchema>;

/** A header or a footer: start, centre and end, mirrored in Arabic. */
export const headerFooterSchema = z.object({
  start: headerFooterSlotSchema.nullable().default(null),
  center: headerFooterSlotSchema.nullable().default(null),
  end: headerFooterSlotSchema.nullable().default(null),
  /** Left off the first page, for a cover or a letterhead that has its own. */
  notOnFirstPage: z.boolean().default(false),
});
export type HeaderFooterSpec = z.infer<typeof headerFooterSchema>;

/** What a branded document looks like. The shape other workers build on: keep it stable. */
export interface DocumentLook {
  /** `#rrggbb` for headings, table header rows and dividers; null for plain black. */
  brandColour: string | null;
  fontKey: DocumentFontKey;
  /** The company's logo as a data URI, for a `logo` place; nothing is drawn without one. */
  logo?: string | null;
  header?: HeaderFooterSpec | null;
  footer?: HeaderFooterSpec | null;
}

export interface LookContext {
  locale: DocumentLocale;
  margins: Margins;
  orientation?: 'portrait' | 'landscape';
  /** Base text size in points; 10 when absent. */
  fontSize?: number;
  /** `@font-face` rules for the look's font (the API's `documentFontFaces`), inlined everywhere. */
  fontFaceCss?: string;
  /** Fills `{{scope.name}}` in header and footer texts. Page numbers are filled here. */
  placeholder?: (scope: string, name: string | undefined) => string | undefined;
  /**
   * `pdf` makes Chromium templates; `preview` makes the same bands as parts of
   * an on-screen page (`previewHeaderHtml`, `previewFooterHtml`), with page 1 of 1.
   */
  mode?: 'pdf' | 'preview';
}

/** The page settings a printer needs besides the HTML. Matches the API's `PrintJob`. */
export interface PrintParts {
  headerHtml: string;
  footerHtml: string;
  hasHeader: boolean;
  hasFooter: boolean;
  landscape: boolean;
  margins: Margins;
  /** Present when the first page's header or footer differs from the others. */
  firstPage?: { headerHtml: string; footerHtml: string; hasHeader: boolean; hasFooter: boolean };
}

export interface LookColours {
  /** Headings and dividers. */
  brand: string;
  /** A light tint of the brand for table header rows and shaded blocks. */
  tint: string;
  /** A lighter tint, for striped rows. */
  stripe: string;
  text: string;
  muted: string;
}

export interface LookParts extends PrintParts {
  /** Base CSS for the page: `@page`, fonts, colours as custom properties, headings, tables, dividers. */
  css: string;
  colours: LookColours;
  /** In preview mode, the bands as they sit on the sheet; empty otherwise. */
  previewHeaderHtml: string;
  previewFooterHtml: string;
}

const TEXT = '#111418';
const MUTED = '#3b4450';
/** Integr8's blue, for a company that never chose a colour. */
export const DEFAULT_BRAND_COLOUR = '#2563eb';

/** A colour `amount` of the way to white. */
export function tintOf(hex: string, amount: number): string {
  const match = /^#([0-9a-f]{6})$/iu.exec(hex);
  if (match === null) {
    return '#ffffff';
  }
  const value = Number.parseInt(match[1] ?? '0', 16);
  const channel = (shift: number) => {
    const c = (value >> shift) & 0xff;
    return Math.round(c + (255 - c) * amount)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

export function lookColours(brandColour: string | null): LookColours {
  if (brandColour === null || !hexColourSchema.safeParse(brandColour).success) {
    return { brand: TEXT, tint: '#eef1f4', stripe: '#f6f7f9', text: TEXT, muted: MUTED };
  }
  const brand = brandColour.toLowerCase();
  return {
    brand,
    tint: tintOf(brand, 0.86),
    stripe: tintOf(brand, 0.94),
    text: TEXT,
    muted: MUTED,
  };
}

/** Text made safe for HTML. */
function escape(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function say(text: Readonly<Record<string, string>>, locale: DocumentLocale): string {
  const own = text[locale];
  if (own !== undefined && own.trim() !== '') {
    return own;
  }
  return Object.values(text).find((value) => value.trim() !== '') ?? '';
}

const DATA_IMAGE = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/u;

/** Whether a band has anything in it. */
export function bandIsEmpty(spec: HeaderFooterSpec | null | undefined): boolean {
  return spec == null || (spec.start === null && spec.center === null && spec.end === null);
}

interface BandInput {
  spec: HeaderFooterSpec | null | undefined;
  which: 'header' | 'footer';
  firstPage: boolean;
}

class Bands {
  readonly #look: DocumentLook;
  readonly #context: LookContext;
  readonly #preview: boolean;

  constructor(look: DocumentLook, context: LookContext) {
    this.#look = look;
    this.#context = context;
    this.#preview = context.mode === 'preview';
  }

  #pageNumber(): string {
    return this.#preview ? '1' : '<span class="pageNumber"></span>';
  }

  #pageCount(): string {
    return this.#preview ? '1' : '<span class="totalPages"></span>';
  }

  /** A text place: placeholders filled, everything escaped, line breaks kept. */
  #text(template: string): string {
    const placeholder = /\{\{\s*([a-z_]+)(?:\.([a-z0-9_]+))?\s*\}\}/gu;
    let out = '';
    let from = 0;
    for (const match of template.matchAll(placeholder)) {
      const scope = match[1] ?? '';
      const name = match[2];
      let value: string;
      if (scope === 'page' && name === 'number') {
        value = this.#pageNumber();
      } else if (scope === 'page' && name === 'count') {
        value = this.#pageCount();
      } else {
        value = escape(this.#context.placeholder?.(scope, name) ?? match[0]);
      }
      out += escape(template.slice(from, match.index)) + value;
      from = match.index + match[0].length;
    }
    out += escape(template.slice(from));
    return out.replace(/\n/gu, '<br>');
  }

  slot(slot: HeaderFooterSlot | null): string {
    if (slot === null) {
      return '';
    }
    switch (slot.kind) {
      case 'logo': {
        const logo = this.#look.logo ?? null;
        if (logo === null || !DATA_IMAGE.test(logo)) {
          return this.#preview
            ? `<span style="display:inline-flex;align-items:center;justify-content:center;height:${String(slot.height)}mm;min-width:${String(slot.height * 2)}mm;border:0.3mm dashed #9aa3ad;color:#5b6977;font-size:7pt;">${escape(wordsFor(this.#context.locale).imagePlaceholder)}</span>`
            : '';
        }
        return `<img src="${logo}" alt="" style="height:${String(slot.height)}mm;width:auto;max-width:100%;display:inline-block;vertical-align:middle;">`;
      }
      case 'text': {
        const text = this.#text(say(slot.text, this.#context.locale));
        return slot.bold ? `<b>${text}</b>` : text;
      }
      case 'page':
        return escape(wordsFor(this.#context.locale).page)
          .replace('{{page}}', this.#pageNumber())
          .replace('{{pages}}', this.#pageCount());
    }
  }

  /** How tall a band's tallest place is, in millimetres, for placing it in the margin. */
  height(spec: HeaderFooterSpec): number {
    const places = [spec.start, spec.center, spec.end];
    return Math.max(4, ...places.map((slot) => (slot?.kind === 'logo' ? slot.height : 0)));
  }

  /** The band's inner HTML and its box style, or null when it prints nothing. */
  band({ spec, which, firstPage }: BandInput): string | null {
    if (spec == null || bandIsEmpty(spec) || (firstPage && spec.notOnFirstPage)) {
      return null;
    }
    const { margins, locale } = this.#context;
    const direction = locale === 'ar' ? 'rtl' : 'ltr';
    const font = documentFont(this.#look.fontKey).text;
    const faces =
      this.#context.fontFaceCss === undefined || this.#context.fontFaceCss === '' || this.#preview
        ? ''
        : `<style>${this.#context.fontFaceCss}</style>`;
    const place = this.#preview
      ? ''
      : which === 'footer'
        ? `margin-bottom:${String(Math.max(0, margins.bottom - 10))}mm;`
        : `margin-top:${String(Math.max(3, margins.top - 5 - this.height(spec)))}mm;`;
    const box = `width:100%;font-family:${font};font-size:8pt;color:${MUTED};padding-inline-start:${String(margins.start)}mm;padding-inline-end:${String(margins.end)}mm;box-sizing:border-box;`;
    if (spec.center === null) {
      // Two places, as every footer was before 1.3.0: the same markup, so an
      // older template prints exactly as it did.
      return `${faces}<div dir="${direction}" style="${box}display:flex;justify-content:space-between;gap:4mm;${which === 'header' ? 'align-items:center;' : ''}${place}"><span>${this.slot(spec.start)}</span><span>${this.slot(spec.end)}</span></div>`;
    }
    return `${faces}<div dir="${direction}" style="${box}display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:4mm;align-items:center;${place}"><span style="text-align:start">${this.slot(spec.start)}</span><span style="text-align:center">${this.slot(spec.center)}</span><span style="text-align:end">${this.slot(spec.end)}</span></div>`;
  }
}

/** Chromium's empty template: without one it prints the title and the date. */
const EMPTY_TEMPLATE = '<span></span>';

/** The CSS a look gives a page: fonts, colours, headings, tables and dividers. */
export function lookCss(look: DocumentLook, context: LookContext): string {
  const font = documentFont(look.fontKey);
  const colours = lookColours(look.brandColour);
  const { margins } = context;
  const rtl = context.locale === 'ar';
  const orientation = context.orientation ?? 'portrait';
  return `
    ${context.fontFaceCss ?? ''}
    @page { size: A4 ${orientation}; margin: ${String(margins.top)}mm ${String(rtl ? margins.start : margins.end)}mm ${String(margins.bottom)}mm ${String(rtl ? margins.end : margins.start)}mm; }
    :root { --doc-brand: ${colours.brand}; --doc-tint: ${colours.tint}; --doc-stripe: ${colours.stripe}; --doc-text: ${colours.text}; --doc-muted: ${colours.muted}; }
    *, *::before, *::after { box-sizing: border-box; }
    html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { margin: 0; font-family: ${font.text}; font-size: ${String(context.fontSize ?? 10)}pt; line-height: 1.4; color: var(--doc-text); }
    h1, h2, h3 { font-family: ${font.heading}; color: var(--doc-brand); margin: 0 0 2.5mm; line-height: 1.25; break-after: avoid; }
    hr { border: 0; border-top: 0.3mm solid var(--doc-brand); margin: 2mm 0 3mm; }
    table { border-collapse: collapse; }
    thead { display: table-header-group; }
    thead th { background: var(--doc-tint); }
    tr { break-inside: avoid; }
  `;
}

/**
 * Everything a look prints with: base CSS, and the header and footer
 * templates for Chromium (or, in preview mode, the bands as page parts).
 */
export function documentLook(look: DocumentLook, context: LookContext): LookParts {
  const bands = new Bands(look, context);
  const header = (firstPage: boolean) =>
    bands.band({ spec: look.header, which: 'header', firstPage });
  const footer = (firstPage: boolean) =>
    bands.band({ spec: look.footer, which: 'footer', firstPage });
  const [headerHtml, footerHtml, firstHeader, firstFooter] = [
    header(false),
    footer(false),
    header(true),
    footer(true),
  ];
  const differs = firstHeader !== headerHtml || firstFooter !== footerHtml;
  const preview = context.mode === 'preview';
  return {
    css: lookCss(look, context),
    colours: lookColours(look.brandColour),
    headerHtml: headerHtml ?? EMPTY_TEMPLATE,
    footerHtml: footerHtml ?? EMPTY_TEMPLATE,
    hasHeader: headerHtml !== null,
    hasFooter: footerHtml !== null,
    landscape: (context.orientation ?? 'portrait') === 'landscape',
    margins: context.margins,
    ...(differs && !preview
      ? {
          firstPage: {
            headerHtml: firstHeader ?? EMPTY_TEMPLATE,
            footerHtml: firstFooter ?? EMPTY_TEMPLATE,
            hasHeader: firstHeader !== null,
            hasFooter: firstFooter !== null,
          },
        }
      : {}),
    // On screen the bands as most pages have them, even one left off the first page.
    previewHeaderHtml: preview ? (headerHtml ?? '') : '',
    previewFooterHtml: preview ? (footerHtml ?? '') : '',
  };
}
