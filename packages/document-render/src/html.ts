import {
  type CompiledForm,
  evaluateForm,
  type Field,
  type FormEvaluation,
} from '@integr8/form-engine';
import type { Block, BlockColour, LeafBlock, Margins, TemplateDesign } from './design.js';
import {
  type FieldProblem,
  factValue,
  type ResolvedField,
  type SubmissionFacts,
} from './fields.js';
import { documentFont } from './fonts.js';
import { type FormatContext, formatAnswer, isBlank, mediaIdsOf, say } from './format.js';
import {
  CHROMIUM_BAND_PADDING_MM,
  DEFAULT_BRAND_COLOUR,
  documentLook,
  headerOffset,
  type LookColours,
  lookColours,
  type PrintParts,
} from './look.js';
import { qrSvg } from './qr.js';
import { type DocumentLocale, wordsFor } from './words.js';

/**
 * A template and a submission as one HTML page (docs/documents/ADR-0001 D4).
 *
 * The server prints the page to PDF with Chromium; the designer shows the same
 * page as its live preview, so what staff see is what the PDF becomes. Every
 * piece of text is escaped: nothing anyone typed, in the form or the template,
 * is ever HTML. Images arrive as data URIs or same-origin URLs the caller
 * resolved, so printing never fetches anything from the network.
 *
 * The header and footer are Chromium's own templates, made by the shared
 * document look (`look.ts`); on screen they are drawn on the sheet instead.
 *
 * A block naming a question the form no longer has (the form was published
 * without it, 1.3.0 decision 13) never stops a document: a block that shows
 * one answer is left out, a table loses that row or keeps that column blank,
 * a placeholder prints nothing. The form given is the one the submission
 * answered, so an older submission still prints the answers it has.
 *
 * In `pdf` mode the page has no background of its own: the server draws the
 * template's backgrounds under each printed page afterwards, which is the only
 * way a background reaches the edge of the paper while the content keeps its
 * margins, and the only way the first page can differ. In `preview` mode the
 * backgrounds are painted behind an A4 sheet so the designer can place blocks
 * against them.
 */

export interface RenderImages {
  /** The company's logo. */
  logo: string | null;
  /** The template's uploaded images, by file id. */
  files: Readonly<Record<string, string>>;
  /** The submission's photos and signatures, by media id. */
  media: Readonly<Record<string, string>>;
}

export interface RenderInput {
  design: TemplateDesign;
  form: CompiledForm;
  answers: Readonly<Record<string, unknown>>;
  locale: DocumentLocale;
  facts: SubmissionFacts;
  /** The document fields as resolved for this document. */
  fields: readonly ResolvedField[];
  /** The link the QR code opens; null in a preview made before there is one. */
  qrUrl: string | null;
  images: RenderImages;
  mode: 'pdf' | 'preview';
  /** `YYYY-MM-DD`, for any calculation that reads today. */
  today?: string;
  /**
   * The company's accent colour, `#rrggbb`, for a template whose brand colour
   * is `company`; Integr8's blue when the company has none.
   */
  companyBrandColour?: string | null;
  /**
   * `@font-face` rules for the template's font, URLs resolved by the caller:
   * data URIs on the server, the app's own files in a preview.
   */
  fontFaceCss?: string;
}

/** The page as HTML, and what Chromium needs besides: its header and footer, size and margins. */
export interface RenderedDocument extends PrintParts {
  html: string;
  /** For Chromium's header: empty unless the template has one. */
  headerHtml: string;
  /** For Chromium's footer: the page numbers and the template's footer text. */
  footerHtml: string;
  margins: Margins;
  /** Whether a footer is printed at all. */
  hasFooter: boolean;
}

/** Text colours a block may choose (D9); `brand` is the template's own. */
const BLOCK_TEXT: Readonly<Record<Exclude<BlockColour, 'brand'>, string>> = {
  black: '#111418',
  grey: '#5b6977',
  red: '#b42318',
};

/** Text made safe for HTML, every character that could start markup escaped. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

/** An attribute value for a URL the caller resolved; anything but data, https or same-origin paths is dropped. */
function safeSource(url: string | undefined): string | null {
  if (url === undefined || url === '') {
    return null;
  }
  if (/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/u.test(url)) {
    return url;
  }
  if (/^(https:\/\/|\/)[^\s"'<>]*$/u.test(url)) {
    return escapeHtml(url);
  }
  return null;
}

const CHECK_SVG =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.5l2.5 2.5 4.5-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function box(ticked: boolean): string {
  return `<span class="box${ticked ? ' on' : ''}">${ticked ? CHECK_SVG : ''}</span>`;
}

class Renderer {
  readonly #input: RenderInput;
  readonly #evaluation: FormEvaluation;
  readonly #format: FormatContext;
  readonly #fieldValues: ReadonlyMap<string, string>;

  constructor(input: RenderInput) {
    this.#input = input;
    this.#evaluation = evaluateForm(
      input.form,
      input.answers,
      input.today === undefined ? {} : { today: input.today },
    );
    this.#format = {
      locale: input.locale,
      words: wordsFor(input.locale),
      timeZone: input.facts.timeZone,
    };
    this.#fieldValues = new Map(input.fields.map((field) => [field.key, field.value]));
  }

  get #locale(): DocumentLocale {
    return this.#input.locale;
  }

  #say(text: Readonly<Record<string, string>> | undefined): string {
    return say(text, this.#locale);
  }

  #field(id: string): Field | undefined {
    return this.#input.form.elements.get(id)?.field;
  }

  #value(id: string): unknown {
    return this.#evaluation.values.get(id);
  }

  #label(id: string, override: Readonly<Record<string, string>> | undefined): string {
    const own = this.#say(override);
    return own !== '' ? own : this.#say(this.#field(id)?.label);
  }

  /** A template text with its placeholders filled in, escaped, line breaks kept. */
  #text(template: string): string {
    const placeholder = /\{\{\s*([a-z_]+)(?:\.([a-z0-9_]+))?\s*\}\}/gu;
    let out = '';
    let from = 0;
    for (const match of template.matchAll(placeholder)) {
      const value = this.placeholder(match[1] ?? '', match[2]);
      out += escapeHtml(template.slice(from, match.index)) + escapeHtml(value ?? match[0]);
      from = match.index + match[0].length;
    }
    out += escapeHtml(template.slice(from));
    return out.replace(/\n/gu, '<br>');
  }

  placeholder(scope: string, name: string | undefined): string | undefined {
    const facts = this.#input.facts;
    switch (scope) {
      case 'answer': {
        if (name === undefined) {
          return undefined;
        }
        const field = this.#field(name);
        return field === undefined ? '' : formatAnswer(field, this.#value(name), this.#format);
      }
      case 'field':
        return name === undefined ? undefined : (this.#fieldValues.get(name) ?? '');
      case 'company':
        return name === 'name' ? facts.companyName : undefined;
      case 'form':
        return name === 'title' ? facts.formTitle : undefined;
      case 'submission':
        switch (name) {
          case 'date':
            return factValue('submitted_date', facts, this.#locale);
          case 'submitted_by':
            return facts.submittedBy ?? '';
          default:
            return undefined;
        }
      case 'document':
        return name === 'date' ? factValue('document_date', facts, this.#locale) : undefined;
      case 'work_order':
        return name === 'reference' ? (facts.workOrderReference ?? '') : undefined;
      case 'asset':
        return name === 'reference' ? (facts.assetReference ?? '') : undefined;
      default:
        return undefined;
    }
  }

  #answerText(field: Field, value: unknown): string {
    return escapeHtml(formatAnswer(field, value, this.#format)).replace(/\n/gu, '<br>');
  }

  /** A photo or signature answer as images, or the answer as text. */
  #answerHtml(field: Field, value: unknown, imageWidth?: number): string {
    if ((field.type === 'photo' || field.type === 'signature') && !isBlank(value)) {
      const images = mediaIdsOf(value)
        .map((id) => this.#image(this.#input.images.media[id], imageWidth))
        .join('');
      return images === ''
        ? this.#answerText(field, value)
        : `<span class="images">${images}</span>`;
    }
    return this.#answerText(field, value);
  }

  #image(source: string | undefined, width?: number): string {
    const src = safeSource(source);
    const style = width === undefined ? '' : ` style="width:${String(width)}mm"`;
    if (src === null) {
      return this.#input.mode === 'preview'
        ? `<span class="placeholder"${style}>${escapeHtml(this.#format.words.imagePlaceholder)}</span>`
        : '';
    }
    return `<img src="${src}" alt=""${style}>`;
  }

  /** A block as HTML, inside its colour and shading when it has either. */
  block(block: Block | LeafBlock): string {
    const html = this.#block(block);
    const colour = 'colour' in block ? block.colour : undefined;
    const shaded = 'shaded' in block ? block.shaded === true : false;
    if (html === '' || (colour === undefined && !shaded)) {
      return html;
    }
    const classes = [
      'blk',
      ...(colour === undefined ? [] : [`c-${colour}`]),
      ...(shaded ? ['shaded'] : []),
    ];
    return `<div class="${classes.join(' ')}">${html}</div>`;
  }

  #block(block: Block | LeafBlock): string {
    switch (block.type) {
      case 'heading': {
        const tag = `h${String(block.level)}`;
        return `<${tag} class="align-${block.align}" dir="auto">${this.#text(this.#say(block.text))}</${tag}>`;
      }
      case 'text':
        return `<p class="text align-${block.align} size-${block.size}${block.bold ? ' bold' : ''}" dir="auto">${this.#text(this.#say(block.text))}</p>`;
      case 'field': {
        const field = this.#field(block.fieldId);
        if (field === undefined) {
          return '';
        }
        const value = this.#answerHtml(field, this.#value(block.fieldId));
        if (block.layout === 'value_only') {
          return `<div class="field value-only" dir="auto">${value}</div>`;
        }
        return `<div class="field ${block.layout}"><span class="label" dir="auto">${escapeHtml(this.#label(block.fieldId, block.label))}</span><span class="value" dir="auto">${value}</span></div>`;
      }
      case 'checkbox': {
        const field = this.#field(block.fieldId);
        if (field === undefined) {
          return '';
        }
        const value = this.#value(block.fieldId);
        let ticked = false;
        let label = this.#say(block.label);
        if (field.type === 'checkbox') {
          ticked = value === true;
          label = label === '' ? this.#say(field.label) : label;
        } else if (field.type === 'yes_no') {
          ticked = value === (block.option ?? 'yes');
          label = label === '' ? this.#say(field.label) : label;
        } else if ('options' in field && block.option !== undefined) {
          ticked = Array.isArray(value) ? value.includes(block.option) : value === block.option;
          if (label === '') {
            const option = field.options.find((candidate) => candidate.value === block.option);
            label = option === undefined ? block.option : this.#say(option.label);
          }
        }
        return `<div class="check">${box(ticked)}<span dir="auto">${escapeHtml(label)}</span></div>`;
      }
      case 'options': {
        const field = this.#field(block.fieldId);
        if (field === undefined) {
          return '';
        }
        const value = this.#value(block.fieldId);
        const words = this.#format.words;
        let choices: { label: string; ticked: boolean }[] = [];
        if (field.type === 'checkbox') {
          choices = [{ label: this.#say(field.label), ticked: value === true }];
        } else if (field.type === 'yes_no') {
          choices = [
            { label: words.yes, ticked: value === 'yes' },
            { label: words.no, ticked: value === 'no' },
            ...(field.allowNotApplicable === true
              ? [{ label: words.notApplicable, ticked: value === 'not_applicable' }]
              : []),
          ];
        } else if ('options' in field) {
          choices = field.options.map((option) => ({
            label: this.#say(option.label),
            ticked: Array.isArray(value) ? value.includes(option.value) : value === option.value,
          }));
        }
        const heading = this.#label(block.fieldId, block.label);
        const items = choices
          .map(
            (choice) =>
              `<div class="check">${box(choice.ticked)}<span dir="auto">${escapeHtml(choice.label)}</span></div>`,
          )
          .join('');
        return `<div class="options">${heading === '' || field.type === 'checkbox' ? '' : `<div class="label" dir="auto">${escapeHtml(heading)}</div>`}<div class="grid cols-${String(block.columns)}">${items}</div></div>`;
      }
      case 'fields_table': {
        const rows = block.rows
          .map((row) => {
            const field = this.#field(row.fieldId);
            if (field === undefined) {
              return '';
            }
            return `<tr><th scope="row" dir="auto">${escapeHtml(this.#label(row.fieldId, row.label))}</th><td dir="auto">${this.#answerHtml(field, this.#value(row.fieldId), 30)}</td></tr>`;
          })
          .join('');
        if (rows === '') {
          // Every question it named is gone from the form: nothing to print.
          return '';
        }
        return `${this.#title(block.title)}<table class="t kv"><tbody>${rows}</tbody></table>`;
      }
      case 'repeat_table': {
        const section = this.#input.form.elements.get(block.sectionId);
        if (section?.kind !== 'section') {
          // The repeating section is gone from the form: the table is left out.
          return '';
        }
        const entries = this.#evaluation.entries.get(block.sectionId) ?? [];
        const widths = columnWidths(block.columns.map((column) => column.width));
        const header = [
          ...(block.numbered
            ? [`<th class="num">${escapeHtml(this.#format.words.number)}</th>`]
            : []),
          ...block.columns.map(
            (column, index) =>
              `<th style="width:${widths[index] ?? ''}" dir="auto">${escapeHtml(this.#label(column.fieldId, column.header))}</th>`,
          ),
        ].join('');
        const body = entries
          .map((entry, row) => {
            const cells = block.columns
              .map((column) => {
                const field = this.#field(column.fieldId);
                const visible = entry.visible.get(column.fieldId) !== false;
                return `<td dir="auto">${field === undefined || !visible ? '' : this.#answerHtml(field, entry.values.get(column.fieldId), 18)}</td>`;
              })
              .join('');
            return `<tr>${block.numbered ? `<td class="num">${String(row + 1)}</td>` : ''}${cells}</tr>`;
          })
          .join('');
        return `${this.#title(block.title)}<table class="t grid"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
      }
      case 'static_table': {
        const header =
          block.header.length === 0
            ? ''
            : `<thead><tr>${block.header.map((cell) => `<th dir="auto">${this.#text(this.#say(cell))}</th>`).join('')}</tr></thead>`;
        const body = block.rows
          .map(
            (row) =>
              `<tr>${row.map((cell) => `<td dir="auto">${this.#text(this.#say(cell))}</td>`).join('')}</tr>`,
          )
          .join('');
        return `${this.#title(block.title)}<table class="t grid">${header}<tbody>${body}</tbody></table>`;
      }
      case 'image': {
        const source = block.source;
        const images =
          source.kind === 'logo'
            ? this.#image(this.#input.images.logo ?? undefined, block.width)
            : source.kind === 'file'
              ? this.#image(this.#input.images.files[source.fileId], block.width)
              : mediaIdsOf(this.#value(source.fieldId))
                  .map((id) => this.#image(this.#input.images.media[id], block.width))
                  .join('');
        const caption = this.#say(block.caption);
        if (images === '' && caption === '') {
          return '';
        }
        return `<figure class="align-${block.align}">${images}${caption === '' ? '' : `<figcaption dir="auto">${this.#text(caption)}</figcaption>`}</figure>`;
      }
      case 'qr': {
        const caption = this.#say(block.caption);
        const size = `width:${String(block.size)}mm;height:${String(block.size)}mm`;
        const code =
          this.#input.qrUrl === null
            ? `<span class="qr placeholder" style="${size}">${escapeHtml(this.#format.words.qrPlaceholder)}</span>`
            : `<span class="qr" style="${size}">${qrSvg(this.#input.qrUrl)}</span>`;
        return `<figure class="align-${block.align}">${code}${caption === '' ? '' : `<figcaption dir="auto">${this.#text(caption)}</figcaption>`}</figure>`;
      }
      case 'divider':
        return '<hr>';
      case 'spacer':
        return `<div class="spacer" style="height:${String(block.height)}mm"></div>`;
      case 'page_break':
        return '<div class="page-break"></div>';
      case 'row': {
        const total = block.columns.reduce((sum, column) => sum + column.width, 0);
        const columns = block.columns
          .map(
            (column) =>
              `<div class="col" style="flex:${String(column.width)} 1 0;max-width:${((column.width / total) * 100).toFixed(3)}%">${column.blocks.map((inner) => this.block(inner)).join('')}</div>`,
          )
          .join('');
        return `<div class="row">${columns}</div>`;
      }
    }
  }

  /** Whether any block sets a colour or shading, so the page needs those rules. */
  get usesAppearance(): boolean {
    const visit = (blocks: readonly (Block | LeafBlock)[]): boolean =>
      blocks.some(
        (block) =>
          ('colour' in block && block.colour !== undefined) ||
          ('shaded' in block && block.shaded === true) ||
          (block.type === 'row' && block.columns.some((column) => visit(column.blocks))),
      );
    return visit(this.#input.design.blocks);
  }

  #title(title: Readonly<Record<string, string>> | undefined): string {
    const text = this.#say(title);
    return text === '' ? '' : `<div class="table-title" dir="auto">${this.#text(text)}</div>`;
  }
}

/** Column widths as CSS: the given percentages, and the rest shared equally. */
function columnWidths(given: readonly (number | undefined)[]): string[] {
  const fixed = given.reduce<number>((sum, width) => sum + (width ?? 0), 0);
  const open = given.filter((width) => width === undefined).length;
  const share = open === 0 ? 0 : Math.max(0, 100 - fixed) / open;
  return given.map((width) => `${(width ?? share).toFixed(2)}%`);
}

/** The template's brand colour as printed, or null for black headings (templates before 1.3.0). */
function brandColourOf(input: RenderInput): string | null {
  const chosen = input.design.style.brandColour;
  if (chosen === 'company') {
    return input.companyBrandColour ?? DEFAULT_BRAND_COLOUR;
  }
  return chosen;
}

function css(
  input: RenderInput,
  direction: 'ltr' | 'rtl',
  extras: { colours: LookColours; brand: string | null; appearance: boolean },
): string {
  const { design, mode, images } = input;
  const { margins, fontSize } = design.page;
  const landscape = design.page.orientation === 'landscape';
  const pageWidth = landscape ? 297 : 210;
  const pageHeight = landscape ? 210 : 297;
  const font = documentFont(design.style.font);
  const start = direction === 'rtl' ? 'right' : 'left';
  const end = direction === 'rtl' ? 'left' : 'right';
  const page = `@page { size: A4 ${design.page.orientation}; margin: ${String(margins.top)}mm ${String(direction === 'rtl' ? margins.start : margins.end)}mm ${String(margins.bottom)}mm ${String(direction === 'rtl' ? margins.end : margins.start)}mm; }`;
  const firstTop = design.page.firstPage?.topMargin ?? null;
  const firstPageRule =
    firstTop === null ? '' : `@page :first { margin-top: ${String(firstTop)}mm; }`;
  let sheet = '';
  if (mode === 'preview') {
    const rest =
      design.page.background === null
        ? null
        : safeSource(images.files[design.page.background.fileId]);
    const firstPage = design.page.firstPage;
    const first =
      firstPage === null
        ? rest
        : firstPage.background === null
          ? null
          : safeSource(images.files[firstPage.background.fileId]);
    const layers: string[] = [];
    const positions: string[] = [];
    const repeats: string[] = [];
    if (firstPage !== null && first !== null) {
      layers.push(`url("${first}")`);
      positions.push('0 0');
      repeats.push('no-repeat');
    }
    if (rest !== null) {
      layers.push(`url("${rest}")`);
      positions.push(firstPage === null ? '0 0' : `0 ${String(pageHeight)}mm`);
      repeats.push(firstPage === null ? 'repeat-y' : 'repeat-y');
    }
    // Page edges every page height, so the designer sees roughly where pages end.
    layers.push(
      `repeating-linear-gradient(to bottom, transparent 0, transparent calc(${String(pageHeight)}mm - 1px), #c7cdd6 calc(${String(pageHeight)}mm - 1px), #c7cdd6 ${String(pageHeight)}mm)`,
    );
    positions.push('0 0');
    repeats.push('repeat');
    sheet = `
      html { background: #e9ecf1; }
      body { margin: 0; padding: 8mm 0; }
      .sheet {
        width: ${String(pageWidth)}mm; min-height: ${String(pageHeight)}mm; margin: 0 auto; box-sizing: border-box; position: relative;
        padding: ${String(firstTop ?? margins.top)}mm ${String(margins.end)}mm ${String(margins.bottom)}mm ${String(margins.start)}mm;
        padding-inline-start: ${String(margins.start)}mm; padding-inline-end: ${String(margins.end)}mm;
        background-color: #ffffff; background-image: ${layers.join(', ')};
        background-size: ${layers.map(() => `${String(pageWidth)}mm ${String(pageHeight)}mm`).join(', ')};
        background-position: ${positions.join(', ')}; background-repeat: ${repeats.join(', ')};
        box-shadow: 0 1px 4px rgba(0,0,0,.15);
      }
      /* On screen a page break cannot start a new sheet; it shows where one will. */
      .sheet .page-break { border-top: 1px dashed #9aa4b2; margin: 6mm 0; }
      /* The header and footer, drawn on the sheet as Chromium prints them in the margins. */
      .sheet > .band { position: absolute; inset-inline: 0; }`;
  }
  return `${input.fontFaceCss === undefined || input.fontFaceCss === '' ? '' : `\n    ${input.fontFaceCss}`}
    ${page}
    ${firstPageRule}
    *, *::before, *::after { box-sizing: border-box; }
    html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { margin: 0; font-family: ${font.text}; font-size: ${String(fontSize)}pt; line-height: 1.4; color: #111418; ${mode === 'pdf' ? 'background: transparent;' : ''} }
    ${sheet}
    h1, h2, h3 { margin: 0 0 2.5mm; line-height: 1.25; break-after: avoid; }
    h1 { font-size: 1.8em; } h2 { font-size: 1.4em; } h3 { font-size: 1.15em; }
    p.text { margin: 0 0 2.5mm; }
    .size-small { font-size: 0.85em; } .size-large { font-size: 1.2em; } .bold { font-weight: 700; }
    .align-start { text-align: ${start}; } .align-center { text-align: center; } .align-end { text-align: ${end}; }
    .field { margin: 0 0 2mm; break-inside: avoid; }
    .field.inline { display: flex; gap: 2mm; align-items: baseline; }
    .field.inline .label::after { content: ':'; }
    .field.stacked .label { display: block; }
    .field .label, .options .label { font-weight: 600; color: #3b4450; }
    .check { display: flex; gap: 2mm; align-items: center; margin: 0 0 1.5mm; break-inside: avoid; }
    .box { display: inline-flex; width: 4mm; height: 4mm; flex: none; border: 0.35mm solid #111418; border-radius: 0.5mm; align-items: center; justify-content: center; }
    .box svg { width: 3.4mm; height: 3.4mm; }
    .options { margin: 0 0 2.5mm; break-inside: avoid; }
    .grid.cols-1 { display: block; }
    .grid.cols-2, .grid.cols-3, .grid.cols-4 { display: grid; column-gap: 4mm; }
    .grid.cols-2 { grid-template-columns: repeat(2, 1fr); } .grid.cols-3 { grid-template-columns: repeat(3, 1fr); } .grid.cols-4 { grid-template-columns: repeat(4, 1fr); }
    .table-title { font-weight: 700; margin: 2mm 0 1.5mm; break-after: avoid; }
    table.t { width: 100%; border-collapse: collapse; margin: 0 0 3mm; table-layout: fixed; }
    table.t th, table.t td { border: 0.25mm solid #9aa3ad; padding: 1.2mm 1.6mm; vertical-align: top; text-align: ${start}; overflow-wrap: anywhere; }
    table.t thead th { background: #eef1f4; font-weight: 600; }
    table.t thead { display: table-header-group; }
    table.t tr { break-inside: avoid; }
    table.kv th { width: 38%; font-weight: 600; background: #f6f7f9; }
    td.num, th.num { width: 11mm; text-align: center; white-space: nowrap; }
    figure { margin: 0 0 3mm; break-inside: avoid; }
    figure img, .images img { max-width: 100%; height: auto; }
    .images { display: flex; flex-wrap: wrap; gap: 1.5mm; }
    figcaption { font-size: 0.85em; color: #3b4450; margin-top: 1mm; }
    .qr { display: inline-block; } .qr svg { width: 100%; height: 100%; display: block; }
    .placeholder { display: inline-flex; align-items: center; justify-content: center; min-height: 12mm; border: 0.3mm dashed #9aa3ad; color: #5b6977; font-size: 0.8em; padding: 1mm; }
    hr { border: 0; border-top: 0.3mm solid #9aa3ad; margin: 2mm 0 3mm; }
    .row { display: flex; gap: 5mm; align-items: flex-start; margin: 0 0 1mm; break-inside: avoid; }
    .row .col { min-width: 0; }
    .page-break { break-after: page; height: 0; }
  ${styleCss(input, extras)}`;
}

/**
 * The template's style as rules after the classic ones: nothing at all for a
 * template made before 1.3.0, so it prints exactly as it did.
 */
function styleCss(
  input: RenderInput,
  extras: { colours: LookColours; brand: string | null; appearance: boolean },
): string {
  const style = input.design.style;
  const font = documentFont(style.font);
  const { colours, brand } = extras;
  const rules: string[] = [];
  if (font.heading !== font.text) {
    rules.push(`h1, h2, h3 { font-family: ${font.heading}; }`);
  }
  if (brand !== null) {
    rules.push(`h1, h2, h3, .table-title { color: ${colours.brand}; }`);
    rules.push(`hr { border-top-color: ${colours.brand}; }`);
    if (style.headerShading) {
      rules.push(`table.t thead th { background: ${colours.tint}; }`);
      rules.push(`table.kv th { background: ${colours.stripe}; }`);
    }
  }
  if (!style.headerShading) {
    rules.push('table.t thead th, table.kv th { background: transparent; }');
  }
  if (style.tableLines === 'none') {
    rules.push('table.t th, table.t td { border: 0; }');
    rules.push(
      `table.t thead th { border-bottom: 0.35mm solid ${brand === null ? '#3b4450' : colours.brand}; }`,
    );
  } else if (style.tableLines === 'strong') {
    rules.push('table.t th, table.t td { border: 0.35mm solid #3b4450; }');
  }
  if (style.stripedRows) {
    rules.push(`table.t tbody tr:nth-child(even) td { background: ${colours.stripe}; }`);
  }
  if (extras.appearance) {
    for (const [name, value] of Object.entries(BLOCK_TEXT)) {
      rules.push(`.blk.c-${name}, .blk.c-${name} * { color: ${value}; }`);
    }
    rules.push(`.blk.c-brand, .blk.c-brand * { color: ${brand ?? colours.brand}; }`);
    rules.push(
      `.blk.shaded { background: ${colours.tint}; padding: 2mm 3mm; margin: 0 0 3mm; border-radius: 1mm; break-inside: avoid; }`,
    );
    rules.push('.blk.shaded > :last-child { margin-bottom: 0; }');
  }
  return rules.join('\n    ');
}

/** The template filled with the submission, as a complete HTML page. */
export function renderDocumentHtml(input: RenderInput): RenderedDocument {
  const renderer = new Renderer(input);
  const direction = input.locale === 'ar' ? 'rtl' : 'ltr';
  const content = input.design.blocks.map((block) => renderer.block(block)).join('\n');
  const brand = brandColourOf(input);
  const look = documentLook(
    {
      brandColour: brand,
      fontKey: input.design.style.font,
      logo: input.images.logo,
      header: input.design.page.header,
      footer: input.design.page.footer,
    },
    {
      locale: input.locale,
      margins: input.design.page.margins,
      orientation: input.design.page.orientation,
      fontSize: input.design.page.fontSize,
      ...(input.fontFaceCss === undefined ? {} : { fontFaceCss: input.fontFaceCss }),
      placeholder: (scope, name) => renderer.placeholder(scope, name),
      mode: input.mode,
    },
  );
  let body = `<main>${content}</main>`;
  if (input.mode === 'preview') {
    const { margins } = input.design.page;
    const header =
      look.previewHeaderHtml === ''
        ? ''
        : `<div class="band" style="top:${String(CHROMIUM_BAND_PADDING_MM + headerOffset(margins.top, bandHeight(input.design.page.header)))}mm">${look.previewHeaderHtml}</div>`;
    const footer =
      look.previewFooterHtml === ''
        ? ''
        : `<div class="band" style="bottom:${String(CHROMIUM_BAND_PADDING_MM + Math.max(0, margins.bottom - 10))}mm">${look.previewFooterHtml}</div>`;
    body = `<main class="sheet">${header}${content}${footer}</main>`;
  }
  const extras = {
    colours: lookColours(brand),
    brand,
    appearance: renderer.usesAppearance,
  };
  const html = `<!doctype html><html lang="${input.locale}" dir="${direction}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.facts.formTitle)}</title><style>${css(input, direction, extras)}</style></head><body>${body}</body></html>`;
  return {
    html,
    headerHtml: look.headerHtml,
    footerHtml: look.footerHtml,
    hasHeader: look.hasHeader,
    hasFooter: look.hasFooter,
    landscape: look.landscape,
    margins: input.design.page.margins,
    ...(look.firstPage === undefined ? {} : { firstPage: look.firstPage }),
  };
}

/** The tallest place of a band, in millimetres. */
function bandHeight(band: TemplateDesign['page']['header']): number {
  if (band === null) {
    return 4;
  }
  return Math.max(
    4,
    ...[band.start, band.center, band.end].map((slot) => (slot?.kind === 'logo' ? slot.height : 0)),
  );
}

export type { FieldProblem, ResolvedField, SubmissionFacts };
