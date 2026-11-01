import { escapeHtml } from '../html.js';

/**
 * The company's look on a printed page: its colour, its typeface, its logo, and
 * what runs along the top and the bottom of every page.
 *
 * Business PDFs are written against this small shape so that they wear the
 * same look as the form documents' templates (decisions 6 and 9 of the 1.3.0
 * round): when the shared one lands in this package, these layouts take it
 * instead and nothing about them changes. Until then the defaults are the
 * company's accent colour, Noto Sans (which every server printer has, in both
 * scripts) and the company's logo.
 */

/** The typefaces a document may be printed in, by key. */
export type DocumentFontKey = 'noto-sans' | 'noto-naskh' | 'integr8-display' | 'integr8-text';

/**
 * Each key as a CSS font stack. Arabic always falls back to the two Noto
 * faces the printer image carries, so an Arabic page never prints in boxes.
 */
export const LOOK_FONT_STACKS: Readonly<Record<DocumentFontKey, string>> = {
  'noto-sans':
    "'Noto Sans', 'Noto Sans Arabic', 'Noto Naskh Arabic', 'DejaVu Sans', 'Segoe UI', Tahoma, Arial, sans-serif",
  'noto-naskh':
    "'Noto Serif', 'Noto Naskh Arabic', 'Noto Sans Arabic', 'DejaVu Serif', 'Times New Roman', serif",
  'integr8-display':
    "'Unbounded', 'Alexandria', 'Noto Sans', 'Noto Sans Arabic', 'Noto Naskh Arabic', sans-serif",
  'integr8-text':
    "'Inter', 'IBM Plex Sans Arabic', 'Noto Sans', 'Noto Sans Arabic', 'Noto Naskh Arabic', sans-serif",
};

/** Three places along a running band: the start, the centre and the end. */
export interface DocumentLookBand {
  start?: string | null;
  centre?: string | null;
  end?: string | null;
}

export interface DocumentLook {
  /** `#rrggbb`: headings, table headers and rules. */
  brandColour: string;
  fontKey: DocumentFontKey;
  /** The company's logo, as a data URI the caller made; null or absent for none. */
  logo?: string | null;
  /**
   * Text along the top and the bottom of every page. `{{page}}` and
   * `{{pages}}` become the page numbers; other `{{name}}`s are filled from the
   * values given to {@link lookTemplates}.
   */
  header?: DocumentLookBand | null;
  footer?: DocumentLookBand | null;
}

/** Integr8's own blue, for a company that has not chosen a colour. */
export const DEFAULT_BRAND_COLOUR = '#1d4ed8';

/** A colour safe to put in CSS: `#rrggbb` (or `#rgb`), else the default. */
export function safeColour(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return DEFAULT_BRAND_COLOUR;
  }
  const trimmed = value.trim();
  return /^#(?:[0-9a-fA-F]{3}){1,2}$/u.test(trimmed) ? trimmed.toLowerCase() : DEFAULT_BRAND_COLOUR;
}

/** The look a company gets when nothing else is chosen. */
export function defaultLook(input: {
  brandColour: string | null | undefined;
  logo?: string | null;
}): DocumentLook {
  return {
    brandColour: safeColour(input.brandColour),
    fontKey: 'noto-sans',
    logo: input.logo ?? null,
  };
}

export interface LookMargins {
  top: number;
  bottom: number;
  start: number;
  end: number;
}

export interface LookTemplates {
  /** For Chromium's `headerTemplate`; it shares nothing with the page's styles. */
  headerHtml: string;
  /** For Chromium's `footerTemplate`. */
  footerHtml: string;
  /** The base styles a page in this look starts from. */
  css: string;
}

/** A band's text as HTML for a running header or footer: escaped, with page numbers. */
function bandText(text: string, values: Readonly<Record<string, string>>): string {
  let out = '';
  let from = 0;
  for (const match of text.matchAll(/\{\{\s*(\w+)\s*\}\}/gu)) {
    out += escapeHtml(text.slice(from, match.index));
    const name = match[1] ?? '';
    out +=
      name === 'page'
        ? '<span class="pageNumber"></span>'
        : name === 'pages'
          ? '<span class="totalPages"></span>'
          : escapeHtml(values[name] ?? '');
    from = match.index + match[0].length;
  }
  return out + escapeHtml(text.slice(from));
}

function band(
  content: DocumentLookBand | null | undefined,
  input: {
    direction: 'ltr' | 'rtl';
    fontStack: string;
    margins: LookMargins;
    values: Readonly<Record<string, string>>;
    edge: 'top' | 'bottom';
    colour: string;
  },
): string {
  const parts = [content?.start, content?.centre, content?.end].map((text) =>
    text === null || text === undefined || text.trim() === '' ? '' : bandText(text, input.values),
  );
  if (parts.every((part) => part === '')) {
    return '<span></span>';
  }
  // Chromium draws the template in its own small page, without the
  // document's styles, at a scale where 8pt reads as 8pt.
  const offset =
    input.edge === 'top'
      ? `margin-top:${String(Math.max(0, input.margins.top - 12))}mm;border-bottom:0.3mm solid ${input.colour};padding-bottom:1.5mm;`
      : `margin-bottom:${String(Math.max(0, input.margins.bottom - 12))}mm;border-top:0.3mm solid ${input.colour};padding-top:1.5mm;`;
  return (
    `<div dir="${input.direction}" style="width:100%;box-sizing:border-box;font-family:${input.fontStack};font-size:7.5pt;color:#3b4450;` +
    `margin-inline-start:${String(input.margins.start)}mm;margin-inline-end:${String(input.margins.end)}mm;${offset}` +
    `display:grid;grid-template-columns:1fr auto 1fr;gap:4mm;align-items:end;width:calc(100% - ${String(input.margins.start + input.margins.end)}mm);">` +
    `<span style="text-align:start">${parts[0] ?? ''}</span>` +
    `<span style="text-align:center">${parts[1] ?? ''}</span>` +
    `<span style="text-align:end">${parts[2] ?? ''}</span>` +
    `</div>`
  );
}

/** The running header and footer, and the page's base styles, for a look. */
export function lookTemplates(
  look: DocumentLook,
  input: {
    direction: 'ltr' | 'rtl';
    margins: LookMargins;
    values?: Readonly<Record<string, string>>;
  },
): LookTemplates {
  const fontStack = LOOK_FONT_STACKS[look.fontKey];
  const colour = safeColour(look.brandColour);
  const values = input.values ?? {};
  const shared = { direction: input.direction, fontStack, margins: input.margins, values, colour };
  const { margins } = input;
  const left = input.direction === 'rtl' ? margins.end : margins.start;
  const right = input.direction === 'rtl' ? margins.start : margins.end;
  const css = `
    @page { size: A4 portrait; margin: ${String(margins.top)}mm ${String(right)}mm ${String(margins.bottom)}mm ${String(left)}mm; }
    *, *::before, *::after { box-sizing: border-box; }
    html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    :root { --brand: ${colour}; }
    body { margin: 0; font-family: ${fontStack}; font-size: 9.5pt; line-height: 1.45; color: #111418; background: #ffffff; }
  `;
  return {
    headerHtml: band(look.header, { ...shared, edge: 'top' }),
    footerHtml: band(look.footer, { ...shared, edge: 'bottom' }),
    css,
  };
}
