import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PrintParts } from '@integr8/document-render';
import { sniffImage } from '@integr8/form-package';
import { PDFDocument, type PDFImage } from 'pdf-lib';
import type { Chrome, Tab } from './cdp.js';

/**
 * HTML to PDF the way the API's printer does it (apps/api/src/documents/
 * printer.ts and backgrounds.ts): Chromium prints the content with its own
 * header and footer templates; a header or footer left off the first page is
 * done by printing twice and taking the first page from the second print; the
 * template's background pictures are drawn under each printed page afterwards.
 */

export interface PrintJob extends PrintParts {
  html: string;
}

export interface Background {
  bytes: Uint8Array;
  contentType: string;
}

export interface PageBackgrounds {
  every: Background | null;
  /** `undefined`: like the others; `null`: a plain first page. */
  first?: Background | null;
}

/** A4 in inches, as Chromium is given it. */
const A4 = { width: 8.27, height: 11.7 };
/** Chromium's empty template: without one it prints the title and the date. */
const EMPTY = '<span></span>';

async function printOnce(
  chrome: Chrome,
  url: string,
  job: PrintJob,
  bands: { headerHtml: string; footerHtml: string; hasHeader: boolean; hasFooter: boolean },
): Promise<Uint8Array> {
  const tab = await chrome.newPage({ javaScript: false });
  try {
    await tab.open(url);
    const shown = bands.hasHeader || bands.hasFooter;
    const { data } = (await tab.send('Page.printToPDF', {
      paperWidth: job.landscape ? A4.height : A4.width,
      paperHeight: job.landscape ? A4.width : A4.height,
      landscape: job.landscape,
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: shown,
      headerTemplate: bands.hasHeader ? bands.headerHtml : EMPTY,
      footerTemplate: bands.hasFooter ? bands.footerHtml : EMPTY,
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
      generateTaggedPDF: true,
      generateDocumentOutline: false,
    })) as { data: string };
    return new Uint8Array(Buffer.from(data, 'base64'));
  } finally {
    await tab.close();
  }
}

/** The first print's first page, then the second print's other pages. */
async function firstPageFrom(first: Uint8Array, rest: Uint8Array): Promise<Uint8Array> {
  const others = await PDFDocument.load(rest);
  const opening = await PDFDocument.load(first);
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(opening, [0]);
  out.addPage(page);
  for (const copied of await out.copyPages(others, others.getPageIndices().slice(1))) {
    out.addPage(copied);
  }
  return out.save();
}

/**
 * A picture PDF can carry (PNG or JPEG). A WebP is redrawn as PNG by the
 * browser itself, by showing it at its own size and taking a screenshot: the
 * server uses an image library for this, which a single executable cannot
 * carry.
 */
async function pdfImage(
  chrome: Chrome,
  folder: string,
  background: Background,
): Promise<{ bytes: Uint8Array; format: 'png' | 'jpeg' } | null> {
  if (background.contentType === 'image/png') {
    return { bytes: background.bytes, format: 'png' };
  }
  if (background.contentType === 'image/jpeg') {
    return { bytes: background.bytes, format: 'jpeg' };
  }
  const info = sniffImage(background.bytes);
  if (info === null) {
    return null;
  }
  const scale = Math.min(1, 3508 / Math.max(info.width, info.height));
  const width = Math.max(1, Math.round(info.width * scale));
  const height = Math.max(1, Math.round(info.height * scale));
  const file = join(folder, `picture-${String(Date.now())}.html`);
  writeFileSync(
    file,
    `<!doctype html><html><body style="margin:0"><img alt="" style="display:block;width:${String(width)}px;height:${String(height)}px" src="data:${background.contentType};base64,${Buffer.from(background.bytes).toString('base64')}"></body></html>`,
  );
  const tab: Tab = await chrome.newPage({ javaScript: false });
  try {
    await tab.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await tab.open(pathToFileURL(file).href);
    const { data } = (await tab.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width, height, scale: 1 },
    })) as { data: string };
    return { bytes: new Uint8Array(Buffer.from(data, 'base64')), format: 'png' };
  } finally {
    await tab.close();
  }
}

async function underlay(
  chrome: Chrome,
  folder: string,
  printed: Uint8Array,
  backgrounds: PageBackgrounds,
  title: string,
): Promise<Uint8Array> {
  const source = await PDFDocument.load(printed);
  const wants =
    backgrounds.every !== null || (backgrounds.first !== undefined && backgrounds.first !== null);
  const out = wants ? await PDFDocument.create() : source;
  if (wants) {
    const embedded = await out.embedPdf(printed, source.getPageIndices());
    const cache = new Map<Background, PDFImage | null>();
    const image = async (background: Background): Promise<PDFImage | null> => {
      if (cache.has(background)) {
        return cache.get(background) ?? null;
      }
      const ready = await pdfImage(chrome, folder, background);
      const made =
        ready === null
          ? null
          : ready.format === 'png'
            ? await out.embedPng(ready.bytes)
            : await out.embedJpg(ready.bytes);
      cache.set(background, made);
      return made;
    };
    for (const [index, content] of embedded.entries()) {
      const { width, height } = source.getPage(index).getSize();
      const page = out.addPage([width, height]);
      const background =
        index === 0 && backgrounds.first !== undefined ? backgrounds.first : backgrounds.every;
      const picture = background === null ? null : await image(background);
      if (picture !== null) {
        page.drawImage(picture, { x: 0, y: 0, width, height });
      }
      page.drawPage(content, { x: 0, y: 0, width, height });
    }
  }
  out.setTitle(title, { showInWindowTitleBar: true });
  out.setProducer('Integr8 Forms for AI');
  out.setCreator('Integr8 Forms for AI');
  return out.save();
}

/** Prints a rendered document to PDF bytes, backgrounds drawn underneath. */
export async function printToPdf(
  chrome: Chrome,
  job: PrintJob,
  backgrounds: PageBackgrounds,
  title: string,
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const folder = mkdtempSync(join(tmpdir(), 'integr8-forms-print-'));
  try {
    const page = join(folder, 'document.html');
    writeFileSync(page, job.html);
    const url = pathToFileURL(page).href;
    const every = await printOnce(chrome, url, job, {
      headerHtml: job.headerHtml,
      footerHtml: job.footerHtml,
      hasHeader: job.hasHeader,
      hasFooter: job.hasFooter,
    });
    const printed =
      job.firstPage === undefined
        ? every
        : await firstPageFrom(await printOnce(chrome, url, job, job.firstPage), every);
    const bytes = await underlay(chrome, folder, printed, backgrounds, title);
    const pageCount = (await PDFDocument.load(bytes)).getPageCount();
    return { bytes, pageCount };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
