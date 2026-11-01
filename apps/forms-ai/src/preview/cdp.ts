import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

/**
 * Just enough of the Chrome DevTools Protocol to print a page to PDF and run
 * pdf.js on the result, spoken over `--remote-debugging-pipe`.
 *
 * The API prints with Playwright; this tool cannot, because it ships as one
 * executable and Playwright reads its own files from disk at run time, which
 * a bundle does not have. The protocol calls are the ones Playwright makes
 * for `page.pdf()`; the browser is the same kind (any Chromium), so a preview
 * prints like the server does. No port is opened: the pipe is the process's
 * own file descriptors 3 and 4, and nothing else can talk to it.
 */

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

interface Waiter {
  method: string;
  sessionId: string | undefined;
  resolve: () => void;
}

export class BrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserError';
  }
}

export class Chrome {
  readonly #child: ChildProcess;
  readonly #input: Writable;
  readonly #profile: string;
  readonly #timeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  #waiters: Waiter[] = [];
  #nextId = 1;
  #buffer = '';
  #stderr = '';
  #exited: Error | undefined;

  private constructor(child: ChildProcess, profile: string, timeoutMs: number) {
    this.#child = child;
    this.#profile = profile;
    this.#timeoutMs = timeoutMs;
    const [, , , input, output] = child.stdio as [unknown, unknown, Readable, Writable, Readable];
    this.#input = input;
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      this.#read(chunk);
    });
    child.stdio[2]!.setEncoding('utf8');
    child.stdio[2]!.on('data', (chunk: string) => {
      // Kept short: only the last lines say why a browser would not start.
      this.#stderr = (this.#stderr + chunk).slice(-4000);
    });
    child.on('exit', (code, signal) => {
      this.#exited = new BrowserError(
        `The browser stopped (${signal ?? `exit code ${String(code)}`}). ${this.#stderr.trim().split('\n').slice(-3).join(' ')}`.trim(),
      );
      for (const pending of this.#pending.values()) {
        pending.reject(this.#exited);
      }
      this.#pending.clear();
    });
    child.on('error', (error) => {
      this.#exited = new BrowserError(`The browser could not be started: ${error.message}`);
      for (const pending of this.#pending.values()) {
        pending.reject(this.#exited);
      }
      this.#pending.clear();
    });
  }

  static async launch(executable: string, options: { timeoutMs: number }): Promise<Chrome> {
    const profile = mkdtempSync(join(tmpdir(), 'integr8-forms-browser-'));
    const args = [
      '--headless=new',
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--mute-audio',
      '--font-render-hinting=none',
      // Chromium refuses its sandbox to root; the page is our own HTML with
      // the network shut, as on the server.
      ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      'about:blank',
    ];
    const child = spawn(executable, args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chrome = new Chrome(child, profile, options.timeoutMs);
    // The first answer proves the pipe works.
    await chrome.send('Browser.getVersion');
    return chrome;
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    let end = this.#buffer.indexOf('\0');
    while (end !== -1) {
      const message = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 1);
      end = this.#buffer.indexOf('\0');
      let parsed: {
        id?: number;
        method?: string;
        sessionId?: string;
        result?: Record<string, unknown>;
        error?: { message?: string };
      };
      try {
        parsed = JSON.parse(message) as typeof parsed;
      } catch {
        continue;
      }
      if (parsed.id !== undefined) {
        const pending = this.#pending.get(parsed.id);
        this.#pending.delete(parsed.id);
        if (parsed.error !== undefined) {
          pending?.reject(
            new BrowserError(parsed.error.message ?? 'The browser refused a command.'),
          );
        } else {
          pending?.resolve(parsed.result ?? {});
        }
      } else if (parsed.method !== undefined) {
        const method = parsed.method;
        const sessionId = parsed.sessionId;
        const matched = this.#waiters.filter(
          (waiter) => waiter.method === method && waiter.sessionId === sessionId,
        );
        this.#waiters = this.#waiters.filter((waiter) => !matched.includes(waiter));
        for (const waiter of matched) {
          waiter.resolve();
        }
      }
    }
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.#exited !== undefined) {
      return Promise.reject(this.#exited);
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BrowserError(`The browser did not answer ${method} in time.`));
      }, this.#timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#input.write(
        `${JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) })}\0`,
      );
    });
  }

  /** Resolves on the next event of this kind; register before causing it. */
  waitFor(method: string, sessionId: string | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((waiter) => waiter !== entry);
        reject(new BrowserError(`The browser did not finish loading in time (${method}).`));
      }, this.#timeoutMs);
      const entry: Waiter = {
        method,
        sessionId,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      this.#waiters.push(entry);
    });
  }

  /** A new tab, attached, with its own session. */
  async newPage(options: { javaScript: boolean }): Promise<Tab> {
    const { targetId } = (await this.send('Target.createTarget', { url: 'about:blank' })) as {
      targetId: string;
    };
    const { sessionId } = (await this.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    await this.send('Page.enable', {}, sessionId);
    await this.send('Network.enable', {}, sessionId);
    // Nothing on the page may reach the network: images and fonts are data URIs.
    await this.send(
      'Network.setBlockedURLs',
      { urls: ['http://*', 'https://*', 'ws://*', 'wss://*', 'ftp://*'] },
      sessionId,
    );
    if (!options.javaScript) {
      await this.send('Emulation.setScriptExecutionDisabled', { value: true }, sessionId);
    }
    return new Tab(this, targetId, sessionId);
  }

  async close(): Promise<void> {
    if (this.#exited === undefined) {
      const exited = new Promise<void>((resolve) => {
        this.#child.once('exit', () => {
          resolve();
        });
      });
      await Promise.race([
        this.send('Browser.close').catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (this.#exited === undefined) {
        this.#child.kill();
      }
    }
    try {
      rmSync(this.#profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A profile the browser still holds on Windows is left in the temp folder.
    }
  }
}

export class Tab {
  readonly #chrome: Chrome;
  readonly #targetId: string;
  readonly sessionId: string;

  constructor(chrome: Chrome, targetId: string, sessionId: string) {
    this.#chrome = chrome;
    this.#targetId = targetId;
    this.sessionId = sessionId;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.#chrome.send(method, params, this.sessionId);
  }

  /** Opens a URL and waits for its load event. */
  async open(url: string): Promise<void> {
    const loaded = this.#chrome.waitFor('Page.loadEventFired', this.sessionId);
    const result = (await this.send('Page.navigate', { url })) as { errorText?: string };
    if (result.errorText !== undefined && result.errorText !== '') {
      throw new BrowserError(`The browser could not open the page: ${result.errorText}`);
    }
    await loaded;
  }

  /** Runs an expression and returns its (awaited) value. */
  async evaluate<T>(expression: string): Promise<T> {
    const result = (await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };
    if (result.exceptionDetails !== undefined) {
      throw new BrowserError(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'Script failed',
      );
    }
    return result.result?.value as T;
  }

  async close(): Promise<void> {
    await this.#chrome
      .send('Target.closeTarget', { targetId: this.#targetId })
      .catch(() => undefined);
  }
}
