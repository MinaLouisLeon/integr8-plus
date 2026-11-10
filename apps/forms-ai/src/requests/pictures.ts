import { Chrome } from '../preview/cdp.js';
import type { FoundBrowser } from '../preview/browser.js';
import { previewTemplate } from '../mcp/preview.js';
import type { RequestExample } from './store.js';

/**
 * Pictures for a change request (P39): the preview window's Form tab and the
 * first page of each PDF template, made with the browser the PDF previews use.
 * Sample answers only: the Form tab is drawn with `?blank=1`, which shows the
 * form with nothing typed, and the PDFs print with generated sample answers,
 * so nothing a person typed can end up in a request.
 */

export interface RequestPicture {
  name: string;
  png: Uint8Array;
}

const MAX_TEMPLATES = 5;

async function formTab(browser: FoundBrowser, windowUrl: string): Promise<Uint8Array | undefined> {
  const chrome = await Chrome.launch(browser.path, { timeoutMs: 60_000 });
  try {
    const tab = await chrome.newPage({ javaScript: true, blockNetwork: false });
    await tab.send('Emulation.setDeviceMetricsOverride', {
      width: 1100,
      height: 1400,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await tab.open(`${windowUrl}&blank=1`);
    for (let tries = 0; tries < 50; tries += 1) {
      const ready = await tab.evaluate<boolean>(
        "document.querySelector('main form, main [role=tabpanel]') !== null",
      );
      if (ready) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const shot = (await tab.send('Page.captureScreenshot', { format: 'png' })) as {
      data?: string;
    };
    return shot.data === undefined ? undefined : new Uint8Array(Buffer.from(shot.data, 'base64'));
  } finally {
    await chrome.close();
  }
}

export async function requestPictures(input: {
  browser: FoundBrowser | undefined;
  scratch: string;
  example: RequestExample | undefined;
  windowUrl: string | undefined;
}): Promise<{ pictures: RequestPicture[]; notes: string[] }> {
  const notes: string[] = [];
  const pictures: RequestPicture[] = [];
  if (input.browser === undefined) {
    notes.push('No Chrome, Edge or Chromium on this computer, so the request has no pictures.');
    return { pictures, notes };
  }
  if (input.windowUrl !== undefined) {
    try {
      const png = await formTab(input.browser, input.windowUrl);
      if (png !== undefined) {
        pictures.push({ name: 'preview-form.png', png });
      }
    } catch (error) {
      notes.push(
        `The Form tab could not be pictured: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const templates = input.example?.templates ?? [];
  for (const [index, template] of templates.slice(0, MAX_TEMPLATES).entries()) {
    try {
      const printed = await previewTemplate(
        {
          definition: input.example?.definition,
          template,
          pictures: (input.example?.pictures ?? []).map((picture) => ({
            id: picture.id,
            base64: Buffer.from(picture.bytes).toString('base64'),
          })),
          pages: 1,
        },
        { browser: input.browser, scratch: input.scratch },
      );
      const page = printed.pageImages[0];
      if (page !== undefined) {
        pictures.push({ name: `preview-pdf-${String(index + 1)}.png`, png: page.png });
      } else if (printed.skipped !== undefined) {
        notes.push(`PDF "${template.name}": ${printed.skipped}`);
      }
    } catch (error) {
      notes.push(
        `PDF "${template.name}" could not be pictured: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (templates.length > MAX_TEMPLATES) {
    notes.push(`Only the first ${String(MAX_TEMPLATES)} PDF templates were pictured.`);
  }
  return { pictures, notes };
}
