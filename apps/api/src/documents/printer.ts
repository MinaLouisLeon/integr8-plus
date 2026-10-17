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
 */

export interface PrintJob {
  html: string;
  footerHtml: string;
  margins: Margins;
  hasFooter: boolean;
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
  #browser: Promise<Browser> | undefined;
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(options: { executablePath: string; timeoutMs: number; maxConcurrent: number }) {
    this.#path = options.executablePath;
    this.#timeoutMs = options.timeoutMs;
    this.#maxConcurrent = Math.max(1, options.maxConcurrent);
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
          return page.pdf({
            format: 'A4',
            landscape: false,
            printBackground: true,
            preferCSSPageSize: true,
            displayHeaderFooter: job.hasFooter,
            headerTemplate: '<span></span>',
            footerTemplate: job.hasFooter ? job.footerHtml : '<span></span>',
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
      const page = pdf.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
      page.drawText(`Recorded page ${String(index + 1)} of ${String(pages)}`, {
        x: 50,
        y: A4_HEIGHT_PT - 80,
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
