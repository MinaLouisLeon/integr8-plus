import { escapeHtml } from '../html.js';

/**
 * TEMPORARY SHIM — delete this file when the shared document look (the PDF
 * template builder's, 1.3.0 decisions 6 and 9) is in this package, and import
 * the same names from it in `business/render.ts` and `business/model.ts`.
 *
 * It copies the shared contract's names and shapes exactly
 * (`DocumentFontKey`, `DocumentLook`, `HeaderFooterSpec`, `HeaderFooterSlot`,
 * `documentLook`, `LookParts`, `PrintParts`) with just enough behaviour for the
 * business PDFs: Noto stacks for every key, running bands with text, logo and
 * page-number slots, A4 portrait. It is not exported from the package, so it
 * cannot clash with the shared one.
 */

export const DOCUMENT_FONT_KEYS = [
  'noto-sans',
  'noto-naskh',
  'integr8-display',
  'integr8-text',
] as const;
export type DocumentFontKey = (typeof DOCUMENT_FONT_KEYS)[number];

/** Each key's text stack; Arabic always falls back to the Noto faces the printer image carries. */
const FONT_STACKS: Readonly<Record<DocumentFontKey, string>> = {
  'noto-sans':
    "'Noto Sans', 'Noto Sans Arabic', 'Noto Naskh Arabic', 'DejaVu Sans', 'Segoe UI', Tahoma, Arial, sans-serif",
  'noto-naskh':
    "'Noto Serif', 'Noto Naskh Arabic', 'Noto Sans Arabic', 'DejaVu Serif', 'Times New Roman', serif",
  'integr8-display':
    "'Unbounded', 'Alexandria', 'Noto Sans', 'Noto Sans Arabic', 'Noto Naskh Arabic', sans-serif",
  'integr8-text':
    "'Inter', 'IBM Plex Sans Arabic', 'Noto Sans', 'Noto Sans Arabic', 'Noto Naskh Arabic', sans-serif",
};

export type LocalizedText = Readonly<Record<string, string>>;

export type HeaderFooterSlot =
  | { kind: 'logo'; height: number }
  | { kind: 'text'; text: LocalizedText; bold: boolean }
  | { kind: 'page' };

export interface HeaderFooterSpec {
  start: HeaderFooterSlot | null;
  center: HeaderFooterSlot | null;
  end: HeaderFooterSlot | null;
  notOnFirstPage: boolean;
}

export interface DocumentLook {
  /** `#rrggbb`, or null for Integr8's default. */
  brandColour: string | null;
  fontKey: DocumentFontKey;
  /** The company's logo as a data URI the caller made. */
  logo?: string | null;
  header?: HeaderFooterSpec | null;
  footer?: HeaderFooterSpec | null;
}

export interface LookMargins {
  top: number;
  end: number;
  bottom: number;
  start: number;
}

export interface LookParts {
  css: string;
  colours: { brand: string };
  headerHtml: string;
  footerHtml: string;
  hasHeader: boolean;
  hasFooter: boolean;
  landscape: boolean;
  margins: LookMargins;
  previewHeaderHtml: string;
  previewFooterHtml: string;
}

/** What the printer takes beside the page's HTML. */
export type PrintParts = Omit<LookParts, 'css'>;

export const DEFAULT_BRAND_COLOUR = '#1d4ed8';

function colourOf(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? '';
  return /^#(?:[0-9a-fA-F]{3}){1,2}$/u.test(trimmed) ? trimmed.toLowerCase() : DEFAULT_BRAND_COLOUR;
}

/** Text with `{{page.number}}` and `{{page.count}}` as Chromium's page counters, the rest escaped. */
function slotText(text: string): string {
  let out = '';
  let from = 0;
  for (const match of text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/gu)) {
    out += escapeHtml(text.slice(from, match.index));
    const name = match[1] ?? '';
    out +=
      name === 'page.number'
        ? '<span class="pageNumber"></span>'
        : name === 'page.count'
          ? '<span class="totalPages"></span>'
          : escapeHtml(match[0]);
    from = match.index + match[0].length;
  }
  return out + escapeHtml(text.slice(from));
}

function slotHtml(
  slot: HeaderFooterSlot | null,
  look: DocumentLook,
  locale: string,
  pageWords: string,
): string {
  if (slot === null) {
    return '';
  }
  switch (slot.kind) {
    case 'logo':
      return look.logo != null && /^data:image\/(png|jpeg|webp);base64,/u.test(look.logo)
        ? `<img src="${look.logo}" alt="" style="height:${String(slot.height)}mm;width:auto">`
        : '';
    case 'page':
      return slotText(pageWords);
    case 'text': {
      const text = slot.text[locale] ?? slot.text.en ?? Object.values(slot.text)[0] ?? '';
      const html = slotText(text);
      return slot.bold ? `<b>${html}</b>` : html;
    }
  }
}

function band(
  spec: HeaderFooterSpec | null | undefined,
  look: DocumentLook,
  input: { locale: string; margins: LookMargins; edge: 'top' | 'bottom'; pageWords: string },
): string | null {
  if (spec == null) {
    return null;
  }
  const parts = [spec.start, spec.center, spec.end].map((slot) =>
    slotHtml(slot, look, input.locale, input.pageWords),
  );
  if (parts.every((part) => part === '')) {
    return null;
  }
  const direction = input.locale === 'ar' ? 'rtl' : 'ltr';
  const colour = colourOf(look.brandColour);
  const { margins } = input;
  const edge =
    input.edge === 'top'
      ? `margin-top:${String(Math.max(0, margins.top - 12))}mm;border-bottom:0.3mm solid ${colour};padding-bottom:1.5mm;`
      : `margin-bottom:${String(Math.max(0, margins.bottom - 12))}mm;border-top:0.3mm solid ${colour};padding-top:1.5mm;`;
  // Chromium draws a band in its own small page, without the document's styles.
  return (
    `<div dir="${direction}" style="box-sizing:border-box;font-family:${FONT_STACKS[look.fontKey]};font-size:7.5pt;color:#3b4450;` +
    `margin-inline-start:${String(margins.start)}mm;margin-inline-end:${String(margins.end)}mm;${edge}` +
    `width:calc(100% - ${String(margins.start + margins.end)}mm);display:grid;grid-template-columns:1fr auto 1fr;gap:4mm;align-items:end;">` +
    `<span style="text-align:start">${parts[0] ?? ''}</span>` +
    `<span style="text-align:center">${parts[1] ?? ''}</span>` +
    `<span style="text-align:end">${parts[2] ?? ''}</span></div>`
  );
}

/** The page's base styles and its running header and footer, in a look. */
export function documentLook(
  look: DocumentLook,
  options: {
    locale: string;
    margins: LookMargins;
    fontSize?: number;
    fontFaceCss?: string;
    /** The page-number slot's words, `{{page.number}}` and `{{page.count}}` in them. */
    pageWords?: string;
  },
): LookParts {
  const { margins } = options;
  const rtl = options.locale === 'ar';
  const brand = colourOf(look.brandColour);
  const pageWords = options.pageWords ?? '{{page.number}} / {{page.count}}';
  const header = band(look.header, look, { ...options, edge: 'top', pageWords });
  const footer = band(look.footer, look, { ...options, edge: 'bottom', pageWords });
  const left = rtl ? margins.end : margins.start;
  const right = rtl ? margins.start : margins.end;
  const css = `
    ${options.fontFaceCss ?? ''}
    @page { size: A4 portrait; margin: ${String(margins.top)}mm ${String(right)}mm ${String(margins.bottom)}mm ${String(left)}mm; }
    *, *::before, *::after { box-sizing: border-box; }
    html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { margin: 0; font-family: ${FONT_STACKS[look.fontKey]}; font-size: ${String(options.fontSize ?? 9.5)}pt; line-height: 1.45; color: #111418; background: #ffffff; }
  `;
  return {
    css,
    colours: { brand },
    headerHtml: header ?? '<span></span>',
    footerHtml: footer ?? '<span></span>',
    hasHeader: header !== null,
    hasFooter: footer !== null,
    landscape: false,
    margins,
    previewHeaderHtml: header ?? '',
    previewFooterHtml: footer ?? '',
  };
}
