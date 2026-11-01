import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type DocumentLocale,
  fontFaceRules,
  parseDesign,
  renderDocumentHtml,
  resolveDocumentFields,
  type SubmissionFacts,
  sampleAnswers,
  type TemplateDesign,
} from '@integr8/document-render';
import {
  type CompiledForm,
  compileDefinition,
  withRequiredSchemaVersion,
} from '@integr8/form-engine';
import { checkFormPackage, type FormPackageCheck } from '@integr8/form-package';
import { readAsset } from '../assets.js';
import { Chrome } from '../preview/cdp.js';
import type { FoundBrowser } from '../preview/browser.js';
import { type Background, printToPdf } from '../preview/print.js';
import { rasterizePdf } from '../preview/raster.js';
import {
  loadPicture,
  type Picture,
  type PictureInput,
  safeFileName,
  titleOf,
} from './package-files.js';

/**
 * `preview_pdf`: one PDF template printed with sample answers, as the server
 * would print it, and pictures of its first pages for the AI to look at.
 *
 * Everything the server fills from the company or the job is filled with
 * plain stand-ins (a "Sample company", job WO-1042, a grey "LOGO" box), and
 * every question gets a plausible answer of its kind (`sampleAnswers`, the
 * designer's own preview data) unless the AI gives its own. Photos and
 * signatures print when the AI gives picture files for them.
 */

export interface PreviewInput {
  definition: unknown;
  template: { name: string; design: unknown };
  /** Answers by question id; for a repeating section, its entries. Merged over the sample. */
  answers?: Record<string, unknown> | undefined;
  /** The template's own pictures (backgrounds, image blocks), by id. */
  pictures?: readonly PictureInput[] | undefined;
  /** Photo or signature questions' sample pictures: question id → file paths. */
  answerPictures?: Readonly<Record<string, readonly string[]>> | undefined;
  /** The document fields typed when the PDF is made, by key. */
  typedFields?: Readonly<Record<string, string>> | undefined;
  language?: DocumentLocale | undefined;
  /** The company's accent colour for `brandColour: "company"`. */
  companyColour?: string | undefined;
  /** How many pages to return as pictures (1–6). */
  pages?: number | undefined;
}

export interface PreviewResult {
  check: FormPackageCheck;
  /** Why there is no PDF, when there is none. */
  skipped?: string;
  pdfPath?: string;
  pageCount?: number;
  /** PNG of each page drawn, first page first, with where each was saved. */
  pageImages: { path: string; png: Uint8Array }[];
  notes: string[];
}

const SAMPLE_LOGO = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80" viewBox="0 0 240 80"><rect x="1" y="1" width="238" height="78" rx="10" fill="#eef1f5" stroke="#9aa4b2" stroke-width="2" stroke-dasharray="8 6"/><text x="120" y="50" font-family="Arial, sans-serif" font-size="26" font-weight="700" fill="#5b6977" text-anchor="middle">LOGO</text></svg>',
).toString('base64')}`;

const dataUri = (picture: Picture) =>
  `data:${picture.contentType};base64,${Buffer.from(picture.bytes).toString('base64')}`;

/** Puts sample photos or signatures into the answers, top level or in every entry. */
function withAnswerPictures(
  form: CompiledForm,
  answers: Record<string, unknown>,
  answerPictures: Readonly<Record<string, readonly string[]>>,
  media: Record<string, string>,
  notes: string[],
): void {
  for (const [fieldId, paths] of Object.entries(answerPictures)) {
    const element = form.elements.get(fieldId);
    const field = element?.field;
    if (field === undefined || (field.type !== 'photo' && field.type !== 'signature')) {
      notes.push(`answerPictures.${fieldId}: not a photo or signature question; ignored.`);
      continue;
    }
    const references = paths.map((path) => {
      const picture = loadPicture({ id: fieldId, path });
      const mediaId = randomUUID();
      media[mediaId] = dataUri(picture);
      return { mediaId, contentType: picture.contentType, byteSize: picture.bytes.length };
    });
    const value = field.type === 'signature' ? references[0] : references;
    if (value === undefined) {
      continue;
    }
    const section = element?.entries;
    if (section === undefined) {
      answers[fieldId] = value;
      continue;
    }
    const entries = answers[section];
    if (Array.isArray(entries)) {
      for (const entry of entries as { values?: Record<string, unknown> }[]) {
        if (entry.values !== undefined) {
          entry.values[fieldId] = value;
        }
      }
    }
  }
}

export async function previewTemplate(
  input: PreviewInput,
  deps: { browser: FoundBrowser | undefined; scratch: string; now?: Date },
): Promise<PreviewResult> {
  const notes: string[] = [];
  const pictures = (input.pictures ?? []).map(loadPicture);
  const check = checkFormPackage({
    form: input.definition,
    templates: [input.template],
    files: pictures,
  });
  const compiled = compileDefinition(withRequiredSchemaVersion(input.definition));
  if (!compiled.ok) {
    return {
      check,
      skipped: 'The form has problems, so nothing can be printed yet.',
      pageImages: [],
      notes,
    };
  }
  const parsed = parseDesign(input.template.design);
  if (!parsed.ok) {
    return {
      check,
      skipped: 'The PDF template is not a design the designer can read.',
      pageImages: [],
      notes,
    };
  }
  const design: TemplateDesign = parsed.design;
  const form = compiled.form;

  const now = deps.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const locale: DocumentLocale = input.language ?? design.page.language ?? 'en';
  const answers: Record<string, unknown> = {
    ...sampleAnswers(form, locale, today),
    ...input.answers,
  };
  const media: Record<string, string> = {};
  withAnswerPictures(form, answers, input.answerPictures ?? {}, media, notes);

  const facts: SubmissionFacts = {
    companyName: locale === 'ar' ? 'شركة تجريبية' : 'Sample Company',
    formTitle: form.definition.title[locale] ?? titleOf(form.definition),
    submittedAt: now.toISOString(),
    submittedBy: locale === 'ar' ? 'مهندس تجريبي' : 'Sample Engineer',
    workOrderReference: 'WO-1042',
    assetReference: 'AS-0007',
    documentDate: now.toISOString(),
    timeZone: 'Africa/Cairo',
  };
  const typed: Record<string, string> = {};
  for (const field of design.fields) {
    if (field.source.kind === 'typed') {
      typed[field.key] = (input.typedFields?.[field.key] ?? 'SAMPLE-1042').slice(
        0,
        field.source.maxLength,
      );
    }
  }
  const resolved = resolveDocumentFields({ design, form, answers, typed, facts, locale, today });
  if (!resolved.ok) {
    notes.push(
      `Document fields: ${resolved.problems.map((problem) => `${problem.key} (${problem.code})`).join(', ')}; printed without them.`,
    );
  }

  const files: Record<string, string> = {};
  for (const picture of pictures) {
    files[picture.id] = dataUri(picture);
  }
  const rendered = renderDocumentHtml({
    design,
    form,
    answers,
    locale,
    facts,
    fields: resolved.ok ? resolved.fields : [],
    qrUrl: 'https://app.integr8-media.com/d/SAMPLE',
    images: { logo: SAMPLE_LOGO, files, media },
    mode: 'pdf',
    today,
    companyBrandColour: input.companyColour ?? null,
    fontFaceCss: fontFaceRules(
      design.style.font,
      (face) => `data:font/woff2;base64,${Buffer.from(readAsset(face)).toString('base64')}`,
    ),
  });
  if (design.style.font === 'noto-sans' || design.style.font === 'noto-naskh') {
    notes.push(
      "The Noto fonts are printed with this machine's own fonts when it lacks them; the server has them installed, so its PDF may differ slightly in letter shapes.",
    );
  }

  if (deps.browser === undefined) {
    return {
      check,
      skipped:
        'No Chrome, Edge or Chromium was found on this computer, so no PDF preview was made. Everything else still works; install Chrome or Edge (or set INTEGR8_FORMS_BROWSER to a Chromium-based browser) to see previews.',
      pageImages: [],
      notes,
    };
  }

  const background = (fileId: string | undefined): Background | null => {
    const picture = pictures.find((candidate) => candidate.id === fileId);
    return picture === undefined
      ? null
      : { bytes: picture.bytes, contentType: picture.contentType };
  };
  const firstPage = design.page.firstPage;
  const backgrounds = {
    every: background(design.page.background?.fileId),
    ...(firstPage === null ? {} : { first: background(firstPage.background?.fileId) }),
  };

  const folder = join(
    deps.scratch,
    'previews',
    `${safeFileName(titleOf(form.definition))} - ${safeFileName(input.template.name)} - ${now.toISOString().replace(/[:.]/gu, '-')}`,
  );
  mkdirSync(folder, { recursive: true });
  const chrome = await Chrome.launch(deps.browser.path, { timeoutMs: 60_000 });
  try {
    const pdf = await printToPdf(chrome, rendered, backgrounds, input.template.name);
    const pdfPath = join(folder, 'preview.pdf');
    writeFileSync(pdfPath, pdf.bytes);
    const pictured = await rasterizePdf(
      chrome,
      pdf.bytes,
      Math.min(6, Math.max(1, input.pages ?? 2)),
    );
    const pageImages = pictured.pages.map((png, index) => {
      const path = join(folder, `page-${String(index + 1)}.png`);
      writeFileSync(path, png);
      return { path, png };
    });
    return { check, pdfPath, pageCount: pdf.pageCount, pageImages, notes };
  } finally {
    await chrome.close();
  }
}
