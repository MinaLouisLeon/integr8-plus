import { access, constants } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { type Browser, chromium } from 'playwright-core';
import type { Margins } from '@integr8/document-render';
import type { ApiConfig } from '../config.js';

/**
 * Turns a document's HTML into PDF bytes (docs/documents/ADR-0001 D4).
 *
 * Chromium is the printer because it is the one engine that lays out Arabic,
 * breaks tables across pages and repeats their headers the way the designer's
 * preview shows them. It runs with JavaScript off and every network request
 * refused: the page is our own HTML with its images inlined, and nothing in it
 * may reach anywhere else.
 *
 * The header and footer are Chromium's templates (the document look in
 * `@integr8/document-render`). A template cannot tell which page it is on, so
 * a header or footer left off the first page is done by printing twice: the
 * whole document with the bands every page has, and again with the first
 * page's; the result is the second print's first page followed by the first
 * print's others. Both prints lay out the same content in the same page box,
 * so their pages break in the same places.
 */

export interface PrintJob {
  html: string;
  footerHtml: string;
  margins: Margins;
  hasFooter: boolean;
  /** Chromium's header template; none when absent. */
  headerHtml?: string;
  hasHeader?: boolean;
  /** A4 landscape rather than portrait. The page's own `@page` rule says so too. */
  landscape?: boolean;
  /** The first page's own header and footer, when they differ from the other pages'. */
  firstPage?: { headerHtml: string; footerHtml: string; hasHeader: boolean; hasFooter: boolean };
}

export type PrinterStatus = { ok: true } | { ok: false; reason: string };

export interface PdfPrinter {
  readonly kind: 'chromium' | 'recording';
  /** Whether it can print, and if not, why, in words an operator can act on. */
  status(): Promise<PrinterStatus>;
  print(job: PrintJob): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** The printer cannot run at all: no Chromium, or it would not start. Not worth retrying. */
export class PrinterUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PrinterUnavailableError';
  }
}

/** One page took longer than the configured limit. */
export class PrintTimeoutError extends Error {
  constructor(ms: number) {
    super(`Printing took longer than ${String(ms)} ms.`);
    this.name = 'PrintTimeoutError';
  }
}

export class ChromiumPrinter implements PdfPrinter {
  readonly kind = 'chromium';
  readonly #path: string;
  readonly #timeoutMs: number;
  readonly #maxConcurrent: number;
  readonly #idleCloseMs: number;
  #browser: Promise<Browser> | undefined;
  #running = 0;
  readonly #waiting: (() => void)[] = [];
  #idleTimer: NodeJS.Timeout | undefined;

  constructor(options: {
    executablePath: string;
    timeoutMs: number;
    maxConcurrent: number;
    /**
     * Chromium is closed after this long with nothing to print, and started
     * again on the next document. The API process prints only the designer's
     * previews (1.3.0), so it should not hold a browser's memory in between.
     */
    idleCloseMs?: number;
  }) {
    this.#path = options.executablePath;
    this.#timeoutMs = options.timeoutMs;
    this.#maxConcurrent = Math.max(1, options.maxConcurrent);
    this.#idleCloseMs = options.idleCloseMs ?? IDLE_CLOSE_MS;
  }

  async status(): Promise<PrinterStatus> {
    try {
      await access(this.#path, constants.X_OK);
      return { ok: true };
    } catch {
      return {
        ok: false,
        reason: `PDF_CHROMIUM_PATH is ${this.#path}, and no Chromium can be run there: PDF documents cannot be made.`,
      };
    }
  }

  async print(job: PrintJob): Promise<Uint8Array> {
    const every = await this.#printOnce(job, {
      headerHtml: job.headerHtml ?? EMPTY,
      footerHtml: job.footerHtml,
      hasHeader: job.hasHeader === true,
      hasFooter: job.hasFooter,
    });
    if (job.firstPage === undefined) {
      return every;
    }
    const first = await this.#printOnce(job, job.firstPage);
    return firstPageFrom(first, every);
  }

  async #printOnce(
    job: PrintJob,
    bands: { headerHtml: string; footerHtml: string; hasHeader: boolean; hasFooter: boolean },
  ): Promise<Uint8Array> {
    await this.#acquire();
    try {
      const browser = await this.#launch();
      const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
      try {
        // Nothing leaves: images are data URLs, fonts are the system's.
        await context.route('**/*', (route) =>
          route.request().url().startsWith('data:') ? route.continue() : route.abort(),
        );
        const page = await context.newPage();
        page.setDefaultTimeout(this.#timeoutMs);
        const work = (async () => {
          await page.setContent(job.html, { waitUntil: 'load', timeout: this.#timeoutMs });
          const bandsShown = bands.hasHeader || bands.hasFooter;
          return page.pdf({
            format: 'A4',
            landscape: job.landscape === true,
            printBackground: true,
            preferCSSPageSize: true,
            displayHeaderFooter: bandsShown,
            headerTemplate: bands.hasHeader ? bands.headerHtml : EMPTY,
            footerTemplate: bands.hasFooter ? bands.footerHtml : EMPTY,
            // The margins are the page's own `@page` rule, which already
            // knows which side is the start in Arabic.
            outline: false,
            tagged: true,
          });
        })();
        return new Uint8Array(await withTimeout(work, this.#timeoutMs));
      } finally {
        await context.close().catch(() => undefined);
      }
    } finally {
      this.#release();
    }
  }

  async close(): Promise<void> {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    const browser = this.#browser;
    this.#browser = undefined;
    if (browser !== undefined) {
      await (await browser.catch(() => undefined))?.close().catch(() => undefined);
    }
  }

  /** One browser for the process, started on first use and again if it dies. */
  #launch(): Promise<Browser> {
    if (this.#browser === undefined) {
      const launching = (async () => {
        const status = await this.status();
        if (!status.ok) {
          throw new PrinterUnavailableError(status.reason);
        }
        try {
          const browser = await chromium.launch({
            executablePath: this.#path,
            headless: true,
            // The container is the sandbox: the page is our own HTML, with
            // scripts off and the network shut, and the image runs Chromium as
            // an unprivileged user without the namespaces its own sandbox needs.
            chromiumSandbox: false,
            args: ['--disable-dev-shm-usage', '--font-render-hinting=none'],
            timeout: this.#timeoutMs,
          });
          browser.on('disconnected', () => {
            if (this.#browser === launching) {
              this.#browser = undefined;
            }
          });
          return browser;
        } catch (error) {
          throw new PrinterUnavailableError(
            `Chromium at ${this.#path} would not start: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })();
      this.#browser = launching;
      launching.catch(() => {
        if (this.#browser === launching) {
          this.#browser = undefined;
        }
      });
    }
    return this.#browser;
  }

  async #acquire(): Promise<void> {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    if (this.#running < this.#maxConcurrent) {
      this.#running += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#waiting.push(resolve);
    });
    this.#running += 1;
  }

  #release(): void {
    this.#running -= 1;
    this.#waiting.shift()?.();
    if (this.#running === 0 && this.#waiting.length === 0) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = setTimeout(() => {
        this.#idleTimer = undefined;
        if (this.#running === 0) {
          void this.close();
        }
      }, this.#idleCloseMs);
      // An idle printer never keeps the process alive.
      this.#idleTimer.unref();
    }
  }
}

/**
 * A printer for tests and machines without Chromium: one A4 page per
 * `page-break`, naming what it was asked to print. The pipeline around it —
 * backgrounds, storage, the ledger, the link — is exercised exactly as in
 * production.
 */
export class RecordingPrinter implements PdfPrinter {
  readonly kind = 'recording';
  readonly printed: PrintJob[] = [];

  status(): Promise<PrinterStatus> {
    return Promise.resolve({ ok: true });
  }

  async print(job: PrintJob): Promise<Uint8Array> {
    this.printed.push(job);
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const pages = 1 + (job.html.match(/class="page-break"/gu)?.length ?? 0);
    for (let index = 0; index < pages; index += 1) {
      const page = pdf.addPage(
        job.landscape === true ? [A4_HEIGHT_PT, A4_WIDTH_PT] : [A4_WIDTH_PT, A4_HEIGHT_PT],
      );
      page.drawText(`Recorded page ${String(index + 1)} of ${String(pages)}`, {
        x: 50,
        y: (job.landscape === true ? A4_WIDTH_PT : A4_HEIGHT_PT) - 80,
        size: 12,
        font,
      });
    }
    return pdf.save();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** A4 in PDF points. */
export const A4_WIDTH_PT = 595.28;
export const A4_HEIGHT_PT = 841.89;

/** Chromium's empty template: without one it prints the title and the date. */
const EMPTY = '<span></span>';

/** How long Chromium is kept open with nothing to print. */
const IDLE_CLOSE_MS = 5 * 60 * 1000;

/** The first print's first page, then the second print's other pages, as one PDF. */
export async function firstPageFrom(first: Uint8Array, rest: Uint8Array): Promise<Uint8Array> {
  const others = await PDFDocument.load(rest);
  const opening = await PDFDocument.load(first);
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(opening, [0]);
  out.addPage(page);
  const later = others.getPageIndices().slice(1);
  for (const copied of await out.copyPages(others, later)) {
    out.addPage(copied);
  }
  return out.save();
}

export function buildPdfPrinter(config: ApiConfig): PdfPrinter {
  return config.PDF_RENDERER === 'chromium'
    ? new ChromiumPrinter({
        executablePath: config.PDF_CHROMIUM_PATH,
        timeoutMs: config.PDF_RENDER_TIMEOUT_MS,
        maxConcurrent: config.PDF_MAX_CONCURRENT,
      })
    : new RecordingPrinter();
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new PrintTimeoutError(ms));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
