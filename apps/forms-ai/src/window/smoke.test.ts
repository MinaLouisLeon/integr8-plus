import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { currentHost } from '../host.js';
import { findExample, type FormExample, type TemplateExample } from '../mcp/examples.js';
import { findBrowser } from '../preview/browser.js';
import { Chrome } from '../preview/cdp.js';
import { PreviewWindow } from './preview-window.js';
import { requestPictures } from '../requests/pictures.js';

/**
 * The window in a real browser: the page server, the built page, the
 * product's filler and a real print, through the same CDP client the PDF
 * previews use. Skipped when no Chrome, Edge or Chromium is found, like the
 * preview tests, or when the page has not been built (`pnpm build`).
 */

const browser = findBrowser(currentHost());
const built = existsSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'window', 'page.js'),
);
const scratch = mkdtempSync(join(tmpdir(), 'forms-ai-window-smoke-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, what: string) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await read();
    if (done(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}; last: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe.skipIf(browser === undefined || !built)('the preview window in a real browser', () => {
  it('shows the form, takes an answer, prints it, and loads nothing from elsewhere', async () => {
    const opened: string[] = [];
    const preview = new PreviewWindow({
      scratch,
      browser: () => browser,
      openUrl: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      outputFolder: () => join(scratch, 'out'),
    });
    const report = findExample('boiler_service_report') as TemplateExample;
    await preview.open({
      definition: (findExample('boiler_service') as FormExample).definition,
      settings: undefined,
      templates: [{ name: report.name, design: report.design }],
      pictures: [],
    });
    const url = opened[0] ?? '';
    const origin = new URL(url).origin;
    const chrome = await Chrome.launch(browser?.path ?? '', { timeoutMs: 60_000 });
    try {
      const tab = await chrome.newPage({ javaScript: true, blockNetwork: false });
      await tab.send('Page.addScriptToEvaluateOnNewDocument', {
        source:
          "window.__violations = []; document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.violatedDirective + ' ' + e.blockedURI));",
      });
      await tab.open(url);
      await until(
        () => tab.evaluate<string>("document.querySelector('h1')?.textContent ?? ''"),
        (title) => title.length > 0 && !title.includes('Untitled'),
        'the form title',
      );

      // Typed as a person types: the input's own setter, then the event React listens for.
      await tab.evaluate(`(() => {
        const input = document.querySelector('main input[type="text"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'Smoke test answer');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await until(
        () => Object.values(preview.session.answers),
        (values) => values.includes('Smoke test answer'),
        'the answer to reach the program',
      );

      await tab.evaluate("document.querySelectorAll('[role=tab]')[1].click()");
      const print = await until(
        () => preview.session.print(0),
        (record) => record?.status === 'ready' || record?.status === 'failed',
        'the print',
      );
      expect(print).toMatchObject({ status: 'ready', options: { useAnswers: true } });
      await until(
        () => tab.evaluate<boolean>("document.querySelector('iframe') !== null"),
        (shown) => shown,
        'the PDF frame',
      );

      const loaded = await tab.evaluate<string[]>(
        "performance.getEntriesByType('resource').map((entry) => entry.name)",
      );
      expect(loaded.length).toBeGreaterThan(0);
      for (const address of loaded) {
        expect(address.startsWith(`${origin}/`)).toBe(true);
      }
      expect(await tab.evaluate<string[]>('window.__violations')).toEqual([]);

      // A change request's pictures (P39): the Form tab with nothing typed, and each PDF.
      const content = preview.session.content;
      const pictured = await requestPictures({
        browser,
        scratch,
        example: content === undefined ? undefined : { ...content },
        windowUrl: await preview.url(),
      });
      expect(pictured.notes).toEqual([]);
      expect(pictured.pictures.map((picture) => picture.name)).toEqual([
        'preview-form.png',
        'preview-pdf-1.png',
      ]);
      for (const picture of pictured.pictures) {
        expect(Buffer.from(picture.png.slice(1, 4)).toString('ascii')).toBe('PNG');
      }
    } finally {
      await chrome.close();
      await preview.close();
    }
  }, 120_000);
});
