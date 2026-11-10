import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FoundBrowser } from '../preview/browser.js';
import { type PreviewInput, type PreviewResult, previewTemplate } from '../mcp/preview.js';
import { formatError } from '../mcp/report.js';
import type { PreviewSession, PrintOptions, PrintRecord } from './session.js';

/**
 * Prints the window's PDF tab: one print at a time, with the server's own
 * renderer (`previewTemplate`, as `preview_pdf`). A print starts when the
 * page asks (the PDF tab opened, the template changed, "Print again"), never
 * on a keystroke. While one runs, a newer request takes the single waiting
 * place, replacing whatever waited there.
 *
 * The finished file stays in the scratch folder, and the previous print of
 * the same template is deleted, so the folder holds one PDF per template.
 */

export type PrintFunction = (
  input: PreviewInput,
  deps: { browser: FoundBrowser | undefined; scratch: string },
) => Promise<PreviewResult>;

export interface PrinterOptions {
  session: PreviewSession;
  scratch: string;
  browser: () => FoundBrowser | undefined;
  print?: PrintFunction;
}

interface Job {
  template: number;
  options: PrintOptions;
}

export const NO_BROWSER =
  'No Chrome, Edge or Chromium was found on this computer, so the PDF cannot be printed here. The Form and Checks tabs still work; install Chrome or Edge (or set INTEGR8_FORMS_BROWSER) to see the PDF.';

export class WindowPrinter {
  readonly #session: PreviewSession;
  readonly #scratch: string;
  readonly #browser: () => FoundBrowser | undefined;
  readonly #print: PrintFunction;
  #waiting: Job | undefined;
  #running: Promise<void> | undefined;

  constructor(options: PrinterOptions) {
    this.#session = options.session;
    this.#scratch = options.scratch;
    this.#browser = options.browser;
    this.#print = options.print ?? previewTemplate;
  }

  /** Whether printing can work on this computer at all. */
  available(): boolean {
    return this.#browser() !== undefined;
  }

  /** Asks for a print; the answer says where it stands now. */
  request(template: number, options: PrintOptions): PrintRecord {
    const content = this.#session.content;
    if (content?.templates[template] === undefined) {
      throw new RangeError(`There is no PDF template number ${String(template)}.`);
    }
    const base = {
      version: this.#session.version,
      options,
      by: 'window' as const,
      at: new Date().toISOString(),
    };
    if (!this.available()) {
      const record: PrintRecord = { ...base, status: 'unavailable', message: NO_BROWSER };
      this.#session.setPrint(template, record);
      return record;
    }
    const replaced = this.#waiting;
    if (replaced !== undefined && replaced.template !== template) {
      // Its place is taken; the PDF tab shows it as not printed, with Print again.
      if (this.#session.print(replaced.template)?.status === 'waiting') {
        this.#session.clearPrint(replaced.template);
      }
    }
    this.#waiting = { template, options };
    const record: PrintRecord = { ...base, status: 'waiting' };
    this.#session.setPrint(template, record);
    this.#running ??= this.#drain().finally(() => {
      this.#running = undefined;
    });
    return record;
  }

  /** Resolves when nothing is printing or waiting (tests). */
  async idle(): Promise<void> {
    while (this.#running !== undefined) {
      await this.#running;
    }
  }

  async #drain(): Promise<void> {
    for (let job = this.#take(); job !== undefined; job = this.#take()) {
      await this.#run(job);
    }
  }

  #take(): Job | undefined {
    const job = this.#waiting;
    this.#waiting = undefined;
    return job;
  }

  async #run(job: Job): Promise<void> {
    const content = this.#session.content;
    const template = content?.templates[job.template];
    if (content === undefined || template === undefined) {
      return;
    }
    const version = this.#session.version;
    const started = {
      version,
      options: job.options,
      by: 'window' as const,
      at: new Date().toISOString(),
    };
    const previous = this.#session.print(job.template);
    this.#session.setPrint(job.template, { ...started, status: 'printing' });
    let record: PrintRecord;
    try {
      const result = await this.#print(
        {
          definition: content.definition,
          template,
          answers: job.options.useAnswers ? this.#session.answers : undefined,
          withSamples: !job.options.useAnswers,
          answerMedia: job.options.useAnswers ? this.#session.mediaDataUris() : undefined,
          pictures: content.pictures.map((picture) => ({
            id: picture.id,
            base64: Buffer.from(picture.bytes).toString('base64'),
          })),
          language: job.options.language,
          companyColour: job.options.companyColour,
          rasterize: false,
        },
        { browser: this.#browser(), scratch: this.#scratch },
      );
      record =
        result.pdfPath === undefined
          ? {
              ...started,
              status: this.available() ? 'failed' : 'unavailable',
              message: result.skipped ?? 'Nothing was printed.',
            }
          : {
              ...started,
              status: 'ready',
              pdfPath: result.pdfPath,
              pageCount: result.pageCount ?? 0,
              ...(result.notes.length === 0 ? {} : { message: result.notes.join(' ') }),
            };
    } catch (error) {
      record = { ...started, status: 'failed', message: formatError(error) };
    }
    if (record.status === 'ready') {
      this.#forget(previous, record.pdfPath);
    }
    // A print of an older version is still shown: the page says it is out of date.
    this.#session.setPrint(job.template, record);
  }

  /** Records a print the AI made with preview_pdf for a template the window shows. */
  recordFromAi(template: number, result: PreviewResult, options: PrintOptions): void {
    if (result.pdfPath === undefined) {
      return;
    }
    const previous = this.#session.print(template);
    if (previous?.status === 'printing' || previous?.status === 'waiting') {
      return;
    }
    this.#forget(previous, result.pdfPath);
    this.#session.setPrint(template, {
      status: 'ready',
      version: this.#session.version,
      options,
      by: 'ai',
      at: new Date().toISOString(),
      pdfPath: result.pdfPath,
      pageCount: result.pageCount ?? 0,
    });
  }

  /** Deletes the folder of a print that has been replaced. */
  #forget(previous: PrintRecord | undefined, current: string | undefined): void {
    const path = previous?.pdfPath;
    // preview_pdf's own files are the AI's to keep; only the window's prints are cleared.
    if (
      path === undefined ||
      previous?.by !== 'window' ||
      dirname(path) === dirname(current ?? '')
    ) {
      return;
    }
    try {
      rmSync(dirname(path), { recursive: true, force: true });
    } catch {
      // A file the browser still holds open on Windows stays until the next run.
    }
  }
}
