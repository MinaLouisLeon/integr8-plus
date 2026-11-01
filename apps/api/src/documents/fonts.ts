import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  documentFont,
  type DocumentFontKey,
  type FontFaceSource,
  fontFaceRules,
} from '@integr8/document-render';

/**
 * The website's fonts for printing (docs/documents ADR-0001, addendum 1.3.0).
 *
 * Chromium prints with the network shut and does not read WOFF2 files
 * installed as system fonts, so a document using one of the Integr8 Media
 * fonts carries them in its own HTML as `@font-face` rules with data URIs.
 * The files are the exact-pinned `@fontsource` packages this package depends
 * on, so they are in the image wherever the API is. The Noto and DejaVu fonts
 * are installed in the image and need nothing here.
 *
 * Read once per process and kept: four or five files of 30–90 KB.
 */

const require = createRequire(import.meta.url);
const cache = new Map<DocumentFontKey, Promise<string>>();

async function dataUri(face: FontFaceSource): Promise<string | null> {
  try {
    const path = require.resolve(`${face.packageName}/${face.file}`);
    return `data:font/woff2;base64,${(await readFile(path)).toString('base64')}`;
  } catch {
    // A missing file falls back to the installed Noto fonts rather than failing a document.
    return null;
  }
}

/**
 * The `@font-face` rules a document in this font needs, or an empty string
 * for a font the image has installed. For any branded PDF: pass it as the
 * look's `fontFaceCss`, which puts it in the page and in the header and footer.
 */
export function documentFontFaces(key: DocumentFontKey): Promise<string> {
  const known = cache.get(key);
  if (known !== undefined) {
    return known;
  }
  const made = (async () => {
    const faces = documentFont(key).faces;
    const uris = new Map<FontFaceSource, string | null>();
    for (const face of faces) {
      uris.set(face, await dataUri(face));
    }
    return fontFaceRules(key, (face) => uris.get(face) ?? null);
  })();
  cache.set(key, made);
  return made;
}
