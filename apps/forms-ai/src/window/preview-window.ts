import type { FormPackageCheck } from '@integr8/form-package';
import type { FoundBrowser } from '../preview/browser.js';
import { FileExistsError, savePackage } from '../mcp/package-files.js';
import { listRequests, requestsFolder } from '../requests/store.js';
import type { PreviewResult } from '../mcp/preview.js';
import type { OpenUrl } from './open-browser.js';
import { type PrintFunction, WindowPrinter } from './printer.js';
import {
  type SaveOutcome,
  type SaveRequest,
  startWindowServer,
  type WindowServer,
} from './server.js';
import { PreviewSession, type PrintOptions, type WindowContent } from './session.js';

/**
 * The preview window as the MCP tools see it: one session, one printer and,
 * once opened, one page server. `open_preview` starts the server and opens
 * the browser; `update_preview` changes the session, which the page hears
 * through its event stream; `close_preview`, or the MCP server stopping,
 * stops the page server.
 */

export interface PreviewWindowOptions {
  scratch: string;
  browser: () => FoundBrowser | undefined;
  openUrl: OpenUrl;
  /** Where Save writes: the configured output folder, read at each save. */
  outputFolder: () => string;
  print?: PrintFunction;
}

export interface OpenOutcome {
  url: string;
  /** Whether a browser was asked to show the window (false: it already showed it, or failed). */
  opened: boolean;
  /** Whether opening was attempted and failed. */
  openFailed: boolean;
  check: FormPackageCheck;
}

const LANGUAGE = { en: 'English', ar: 'Arabic' } as const;

export class PreviewWindow {
  readonly session = new PreviewSession();
  readonly printer: WindowPrinter;
  readonly #options: PreviewWindowOptions;
  #server: Promise<WindowServer> | undefined;

  constructor(options: PreviewWindowOptions) {
    this.#options = options;
    this.printer = new WindowPrinter({
      session: this.session,
      scratch: options.scratch,
      browser: options.browser,
      ...(options.print === undefined ? {} : { print: options.print }),
    });
  }

  get isOpen(): boolean {
    return this.#server !== undefined;
  }

  async open(content: WindowContent): Promise<OpenOutcome> {
    const check = this.session.update(content);
    const fresh = this.#server === undefined;
    this.#server ??= startWindowServer({
      session: this.session,
      printer: this.printer,
      outputFolder: this.#options.outputFolder(),
      save: (request) => this.save(request),
      listRequests: () =>
        listRequests(requestsFolder(this.#options.outputFolder())).requests.map(({ header }) => ({
          number: header.number,
          title: header.title,
          kind: header.kind,
          status: header.status,
          date: header.date,
        })),
    });
    let server: WindowServer;
    try {
      server = await this.#server;
    } catch (error) {
      this.#server = undefined;
      throw error;
    }
    // A page already showing the window refreshes by itself; no second tab.
    if (!fresh && server.connections() > 0) {
      return { url: server.url, opened: false, openFailed: false, check };
    }
    const opened = await this.#options.openUrl(server.url);
    return { url: server.url, opened, openFailed: !opened, check };
  }

  update(change: Partial<WindowContent>): FormPackageCheck {
    if (this.#server === undefined) {
      throw new Error('The preview window is not open; call open_preview first.');
    }
    return this.session.update(change);
  }

  async url(): Promise<string | undefined> {
    return this.#server === undefined ? undefined : (await this.#server).url;
  }

  async connections(): Promise<number> {
    return this.#server === undefined ? 0 : (await this.#server).connections();
  }

  async close(): Promise<boolean> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) {
      return false;
    }
    await (await server).close();
    return true;
  }

  /** The window's Save button: the same file save_package writes, from the session. */
  save(request: SaveRequest): SaveOutcome {
    const content = this.session.content;
    if (content === undefined) {
      throw new Error('There is no form to save yet.');
    }
    try {
      const saved = savePackage({
        definition: content.definition,
        settings: content.settings,
        templates: content.templates,
        pictures: content.pictures.map((picture) => ({
          id: picture.id,
          base64: Buffer.from(picture.bytes).toString('base64'),
        })),
        fileName: request.fileName,
        folder: this.#options.outputFolder(),
        overwrite: request.overwrite,
      });
      return { kind: 'saved', path: saved.path, replaced: saved.replaced, ok: saved.check.ok };
    } catch (error) {
      if (error instanceof FileExistsError) {
        return { kind: 'exists', path: error.path };
      }
      throw error;
    }
  }

  /** After preview_pdf: the window's PDF tab shows the AI's print of a template it holds. */
  recordAiPrint(
    template: { name: string; design: unknown },
    result: PreviewResult,
    options: PrintOptions,
  ): void {
    if (this.#server === undefined) {
      return;
    }
    const templates = this.session.content?.templates ?? [];
    const design = JSON.stringify(template.design);
    const index = templates.findIndex(
      (candidate) =>
        candidate.name === template.name && JSON.stringify(candidate.design) === design,
    );
    if (index !== -1) {
      this.printer.recordFromAi(index, result, options);
    }
  }

  /** What the person did in the window, for get_preview_state. Marks the notes read. */
  async describe(): Promise<string> {
    const url = await this.url();
    if (url === undefined) {
      return 'The preview window is not open. Call open_preview to open it.';
    }
    const session = this.session;
    const view = session.view;
    const connected = await this.connections();
    const lines = [
      `The window is open at ${url} (${connected === 0 ? 'no browser page is showing it now' : `shown in ${String(connected)} browser page${connected === 1 ? '' : 's'}`}).`,
      `The person is on the ${view.tab === 'pdf' ? 'PDF' : view.tab === 'checks' ? 'Checks' : 'Form'} tab, in ${LANGUAGE[view.language]}, at ${view.width} width, ${view.theme} theme.`,
      '',
    ];
    const answers = session.answers;
    const count = Object.keys(answers).length;
    lines.push(
      count === 0
        ? 'Answers typed in the Form tab: none.'
        : `Answers typed in the Form tab (${String(count)}, by question id):\n${JSON.stringify(answers, null, 2)}`,
      '',
    );
    const submitted = session.submitted;
    lines.push(
      submitted === undefined
        ? 'Submit: not pressed yet.'
        : `Submit: pressed at ${submitted.at}. Nothing was sent; the app would have sent:\n${JSON.stringify(submitted.answers, null, 2)}`,
      '',
    );
    const notes = session.takeUnreadNotes();
    if (notes.length === 0) {
      lines.push('Notes from the person: no new ones.');
    } else {
      lines.push(
        'New notes from the person (answer them, or ask about them):',
        ...notes.map(
          (note, index) =>
            `${String(index + 1)}. [${note.platform ? 'PLATFORM SUGGESTION, ' : ''}${note.tab} tab${note.about === undefined ? '' : `, about "${note.about}"`}, ${note.at}] ${note.text}`,
        ),
        ...(notes.some((note) => note.platform)
          ? [
              'A platform suggestion is something the person wants the platform itself to do. Say: "The platform cannot do this yet. Shall I record it as a change request?" If yes, ask what should happen, for whom, on which apps and what they do today, then call record_change_request.',
            ]
          : []),
      );
    }
    const templates = session.content?.templates ?? [];
    if (templates.length > 0) {
      lines.push('', 'PDF tab:');
      templates.forEach((template, index) => {
        const print = session.print(index);
        let status = 'not printed in the window yet';
        if (print !== undefined) {
          const answersUsed = print.options.useAnswers ? 'the typed answers' : 'sample answers';
          status =
            print.status === 'ready'
              ? `printed (${String(print.pageCount ?? 0)} page(s), with ${answersUsed}${print.version === session.version ? '' : ', before the latest change'})`
              : print.status === 'unavailable' || print.status === 'failed'
                ? `${print.status}: ${print.message ?? ''}`
                : print.status;
        }
        lines.push(`- "${template.name}": ${status}`);
      });
    }
    return lines.join('\n');
  }
}
