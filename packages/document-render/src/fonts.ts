/**
 * The typefaces a printed document may use (docs/documents ADR-0001, addendum
 * 1.3.0): two pairs the server has always had installed, and the Integr8 Media
 * website's own two pairs. Every pair covers English and Arabic.
 *
 * Each key names a text stack and a heading stack. The Noto and DejaVu fonts
 * are installed in the API image (Debian's `fonts-noto-core` and
 * `fonts-dejavu-core`), so Chromium finds them by name. The website's fonts are
 * not installed: they are the exact-pinned `@fontsource` files the web and
 * desktop apps already ship, and whoever prints embeds them into the page as
 * `@font-face` rules with data URIs (the API's `documentFontFaces`), because
 * printing never reaches the network and Chromium does not read WOFF2 files
 * installed as system fonts. The family names are the ones `@fontsource`
 * declares, so the desktop app's live preview, which has the same files loaded
 * already, finds them under the same names.
 */

export const DOCUMENT_FONT_KEYS = [
  'noto-sans',
  'noto-naskh',
  'integr8-display',
  'integr8-text',
] as const;
export type DocumentFontKey = (typeof DOCUMENT_FONT_KEYS)[number];

/** One file to embed: where it is, and the `@font-face` it becomes. */
export interface FontFaceSource {
  /** The CSS family name, exactly as the `@fontsource` package names it. */
  family: string;
  /** The npm package holding the file. */
  packageName: string;
  /** The file's path inside that package. */
  file: string;
  /** `100 900` for a variable font, one weight otherwise. */
  weight: string;
  unicodeRange: string;
}

export interface DocumentFont {
  key: DocumentFontKey;
  /** The CSS stack for running text. */
  text: string;
  /** The CSS stack for headings. */
  heading: string;
  /** Files to embed; empty for fonts the server has installed. */
  faces: readonly FontFaceSource[];
}

/** The stack every template printed with before 1.3.0, unchanged. */
const NOTO_SANS =
  "'Noto Sans', 'Noto Sans Arabic', 'Noto Naskh Arabic', 'DejaVu Sans', 'Segoe UI', Tahoma, Arial, sans-serif";
const NOTO_NASKH =
  "'Noto Serif', 'Noto Naskh Arabic', 'DejaVu Serif', 'Noto Sans Arabic', 'Times New Roman', serif";
const INTEGR8_TEXT =
  "'Inter Variable', 'IBM Plex Sans Arabic', 'Noto Sans', 'Noto Sans Arabic', 'DejaVu Sans', 'Segoe UI', Tahoma, Arial, sans-serif";
const INTEGR8_DISPLAY =
  "'Unbounded Variable', 'Alexandria Variable', 'Inter Variable', 'IBM Plex Sans Arabic', 'Noto Sans', 'Noto Sans Arabic', 'DejaVu Sans', sans-serif";

/** `@fontsource`'s own ranges, so one file serves each script. */
const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';
const ARABIC =
  'U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC';

const INTER: FontFaceSource[] = [
  {
    family: 'Inter Variable',
    packageName: '@fontsource-variable/inter',
    file: 'files/inter-latin-wght-normal.woff2',
    weight: '100 900',
    unicodeRange: LATIN,
  },
  {
    family: 'Inter Variable',
    packageName: '@fontsource-variable/inter',
    file: 'files/inter-latin-ext-wght-normal.woff2',
    weight: '100 900',
    unicodeRange: LATIN_EXT,
  },
];
const PLEX_ARABIC: FontFaceSource[] = (['400', '600', '700'] as const).map((weight) => ({
  family: 'IBM Plex Sans Arabic',
  packageName: '@fontsource/ibm-plex-sans-arabic',
  file: `files/ibm-plex-sans-arabic-arabic-${weight}-normal.woff2`,
  weight,
  unicodeRange: ARABIC,
}));
const DISPLAY: FontFaceSource[] = [
  {
    family: 'Unbounded Variable',
    packageName: '@fontsource-variable/unbounded',
    file: 'files/unbounded-latin-wght-normal.woff2',
    weight: '200 900',
    unicodeRange: LATIN,
  },
  {
    family: 'Alexandria Variable',
    packageName: '@fontsource-variable/alexandria',
    file: 'files/alexandria-arabic-wght-normal.woff2',
    weight: '100 900',
    unicodeRange: ARABIC,
  },
];

export const DOCUMENT_FONTS: Readonly<Record<DocumentFontKey, DocumentFont>> = {
  'noto-sans': {
    key: 'noto-sans',
    text: NOTO_SANS,
    heading: NOTO_SANS,
    faces: [],
  },
  'noto-naskh': {
    key: 'noto-naskh',
    text: NOTO_NASKH,
    heading: NOTO_NASKH,
    faces: [],
  },
  'integr8-display': {
    key: 'integr8-display',
    text: INTEGR8_TEXT,
    heading: INTEGR8_DISPLAY,
    faces: [...INTER, ...PLEX_ARABIC, ...DISPLAY],
  },
  'integr8-text': {
    key: 'integr8-text',
    text: INTEGR8_TEXT,
    heading: INTEGR8_TEXT,
    faces: [...INTER, ...PLEX_ARABIC],
  },
};

/** The font for a key, the plain Noto pair for anything unknown. */
export function documentFont(key: string | null | undefined): DocumentFont {
  return DOCUMENT_FONTS[key as DocumentFontKey] ?? DOCUMENT_FONTS['noto-sans'];
}

/**
 * The `@font-face` rules for a font, each file given as a URL by `source`:
 * a data URI on the server, wherever the app serves it in a preview. A file
 * `source` cannot find (null) is left out, and the stack falls back to the
 * installed Noto fonts.
 */
export function fontFaceRules(
  key: DocumentFontKey,
  source: (face: FontFaceSource) => string | null,
): string {
  return documentFont(key)
    .faces.flatMap((face) => {
      const url = source(face);
      if (url === null) {
        return [];
      }
      return [
        `@font-face{font-family:'${face.family}';font-style:normal;font-display:block;font-weight:${face.weight};src:url(${JSON.stringify(url)}) format('woff2');unicode-range:${face.unicodeRange};}`,
      ];
    })
    .join('');
}
