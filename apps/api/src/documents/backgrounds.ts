import { PDFDocument, type PDFImage } from 'pdf-lib';

/**
 * Draws a template's backgrounds under every printed page (ADR-0001 D3).
 *
 * Chromium prints the content on a transparent page. Each printed page is then
 * placed, as it is, on a new A4 page that already carries the background image
 * edge to edge: the first page's own image when the template has one, the
 * repeating image on every other page. Text stays text and vectors stay
 * vectors; only the background is a picture.
 */

export interface BackgroundImage {
  bytes: Uint8Array;
  /** PNG or JPEG: the two kinds a PDF carries natively. */
  format: 'png' | 'jpeg';
}

export interface Backgrounds {
  /** Behind every page; behind every page but the first when `first` is given. */
  every: BackgroundImage | null;
  /**
   * The first page: `undefined` when it is like the others, `null` for a plain
   * first page, or its own image.
   */
  first?: BackgroundImage | null;
}

export interface Underlaid {
  bytes: Uint8Array;
  pageCount: number;
}

export async function underlayBackgrounds(
  printed: Uint8Array,
  backgrounds: Backgrounds,
  meta: { title: string; author: string },
): Promise<Underlaid> {
  const source = await PDFDocument.load(printed);
  const pageCount = source.getPageCount();
  const wantsBackground =
    backgrounds.every !== null || (backgrounds.first !== undefined && backgrounds.first !== null);

  const out = wantsBackground ? await PDFDocument.create() : source;
  if (wantsBackground) {
    const embedded = await out.embedPdf(printed, source.getPageIndices());
    const cache = new Map<BackgroundImage, PDFImage>();
    const image = async (background: BackgroundImage) => {
      const known = cache.get(background);
      if (known !== undefined) {
        return known;
      }
      const made =
        background.format === 'png'
          ? await out.embedPng(background.bytes)
          : await out.embedJpg(background.bytes);
      cache.set(background, made);
      return made;
    };
    for (const [index, content] of embedded.entries()) {
      const { width, height } = source.getPage(index).getSize();
      const page = out.addPage([width, height]);
      const background =
        index === 0 && backgrounds.first !== undefined ? backgrounds.first : backgrounds.every;
      if (background !== null) {
        page.drawImage(await image(background), { x: 0, y: 0, width, height });
      }
      page.drawPage(content, { x: 0, y: 0, width, height });
    }
  }

  out.setTitle(meta.title, { showInWindowTitleBar: true });
  out.setAuthor(meta.author);
  out.setProducer('Integr8');
  out.setCreator('Integr8');
  return { bytes: await out.save(), pageCount };
}
