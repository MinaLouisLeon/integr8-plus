import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { getAsset, isSea } from 'node:sea';
import { DOCUMENT_FONTS } from '@integr8/document-render';

/**
 * Files the program needs besides its code: pdf.js, which turns a printed
 * PDF into pictures for the AI to look at, and the website's fonts, which a
 * PDF template may print with. In the single executable they are Node SEA
 * assets (`scripts/build-sea.mjs` puts every one of {@link ASSETS} in); run
 * from source they are read from the exact-pinned packages in node_modules.
 */

export interface AssetSource {
  /** The npm package holding the file. */
  packageName: string;
  /** The file's path inside that package. */
  file: string;
}

/** The key an asset is stored under: its package and path. */
export const assetKey = (source: AssetSource): string => `${source.packageName}/${source.file}`;

export const PDFJS: { library: AssetSource; worker: AssetSource } = {
  library: { packageName: 'pdfjs-dist', file: 'build/pdf.min.mjs' },
  worker: { packageName: 'pdfjs-dist', file: 'build/pdf.worker.min.mjs' },
};

/** Every file the executable must carry, each once. */
export const ASSETS: readonly AssetSource[] = (() => {
  const all = new Map<string, AssetSource>();
  for (const source of [PDFJS.library, PDFJS.worker]) {
    all.set(assetKey(source), source);
  }
  for (const font of Object.values(DOCUMENT_FONTS)) {
    for (const face of font.faces) {
      all.set(assetKey(face), { packageName: face.packageName, file: face.file });
    }
  }
  return [...all.values()];
})();

const cache = new Map<string, Uint8Array>();

function fromPackages(key: string): Uint8Array {
  // `import.meta.url` is this file run from source, or the bundle in dist;
  // either way node_modules is found from there.
  const require = createRequire(import.meta.url);
  let path: string;
  try {
    path = require.resolve(key);
  } catch {
    // pdfjs-dist has no `exports` map; its files are found from its package.json.
    const [scope, name, ...rest] = key.split('/');
    const packageName = scope?.startsWith('@') === true ? `${scope}/${name ?? ''}` : (scope ?? '');
    const file = scope?.startsWith('@') === true ? rest.join('/') : [name, ...rest].join('/');
    const manifest = require.resolve(`${packageName}/package.json`);
    path = manifest.replace(/package\.json$/u, file);
  }
  return new Uint8Array(readFileSync(path));
}

/** An asset's bytes; throws when the file is missing, which is a broken build. */
export function readAsset(source: AssetSource): Uint8Array {
  const key = assetKey(source);
  const known = cache.get(key);
  if (known !== undefined) {
    return known;
  }
  const bytes = isSea() ? new Uint8Array(getAsset(key)) : fromPackages(key);
  cache.set(key, bytes);
  return bytes;
}
