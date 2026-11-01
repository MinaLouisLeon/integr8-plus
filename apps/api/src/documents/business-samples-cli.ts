import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type BusinessDocumentData,
  type BusinessDocumentKind,
  type BusinessLocale,
  renderBusinessDocumentHtml,
  sampleDocument,
  sampleJobReport,
} from '@integr8/document-render';
import sharp from 'sharp';
import { documentFontFaces } from './fonts.js';
import { inlineImage } from './images.js';
import { ChromiumPrinter } from './printer.js';

/**
 * Prints one sample of each business PDF, in English and Arabic, through the
 * real printer (docs/screenshots/1.3.0/business-pdfs). Made-up company and
 * pictures; nothing is read from a database or a bucket.
 *
 *   pnpm --filter @integr8/api exec tsx src/documents/business-samples-cli.ts <out-dir>
 *
 * `PDF_CHROMIUM_PATH` names the Chromium to use (default /usr/bin/chromium).
 */

const KINDS: readonly BusinessDocumentKind[] = ['quote', 'invoice', 'purchase_order', 'job_report'];
const LOCALES: readonly BusinessLocale[] = ['en', 'ar'];

async function picture(svg: string, format: 'png' | 'jpeg'): Promise<Uint8Array> {
  const image = sharp(Buffer.from(svg));
  return new Uint8Array(
    await (format === 'png' ? image.png() : image.jpeg({ quality: 82 })).toBuffer(),
  );
}

function scene(hue: number, label: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${String(hue)},35%,72%)"/><stop offset="1" stop-color="hsl(${String(hue + 40)},30%,38%)"/>
    </linearGradient></defs>
    <rect width="1200" height="900" fill="url(#g)"/>
    <rect x="220" y="260" width="760" height="420" rx="18" fill="hsl(${String(hue)},10%,85%)" stroke="#2b2f36" stroke-width="10"/>
    ${Array.from({ length: 12 }, (_, i) => `<line x1="${String(260 + i * 60)}" y1="300" x2="${String(260 + i * 60)}" y2="640" stroke="#5b6470" stroke-width="8"/>`).join('')}
    <circle cx="1040" cy="160" r="${String(40 + label * 6)}" fill="rgba(255,255,255,0.35)"/>
  </svg>`;
}

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="160">
  <rect x="8" y="8" width="144" height="144" rx="32" fill="#0e7490"/>
  <path d="M40 104 C 60 40, 100 40, 120 104" stroke="#ffffff" stroke-width="14" fill="none" stroke-linecap="round"/>
  <circle cx="80" cy="60" r="12" fill="#a5f3fc"/>
  <text x="176" y="78" font-family="Noto Sans, sans-serif" font-size="46" font-weight="700" fill="#0f172a">NILE</text>
  <text x="176" y="126" font-family="Noto Sans, sans-serif" font-size="30" fill="#0e7490">COOLING</text>
</svg>`;

const SIGNATURE = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200">
  <path d="M30 140 C 80 20, 120 190, 170 90 S 260 40, 300 120 S 380 170, 420 70 S 520 110, 570 60"
    stroke="#1e3a8a" stroke-width="6" fill="none" stroke-linecap="round"/>
</svg>`;

async function main(): Promise<void> {
  const out = process.argv[2];
  if (out === undefined) {
    throw new Error('Usage: business-samples-cli.ts <out-dir>');
  }
  await mkdir(out, { recursive: true });
  const printer = new ChromiumPrinter({
    executablePath: process.env.PDF_CHROMIUM_PATH ?? '/usr/bin/chromium',
    timeoutMs: 60_000,
    maxConcurrent: 1,
  });
  try {
    const logo = await inlineImage(await picture(LOGO, 'png'));
    const media: Record<string, string> = {};
    const photoIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const id = `photo-${String(index)}`;
      const made = await inlineImage(await picture(scene(170 + index * 25, index), 'jpeg'), 800);
      if (made !== undefined) {
        media[id] = made;
        photoIds.push(id);
      }
    }
    const signature = await inlineImage(await picture(SIGNATURE, 'png'));
    if (signature !== undefined) {
      media.signature = signature;
    }
    for (const kind of KINDS) {
      for (const locale of LOCALES) {
        const data: BusinessDocumentData =
          kind === 'job_report'
            ? sampleJobReport(locale, photoIds, 'signature')
            : sampleDocument(kind, locale);
        const rendered = renderBusinessDocumentHtml({
          data,
          locale,
          timeZone: 'Africa/Cairo',
          qrUrl:
            kind === 'quote'
              ? 'https://app.integr8-media.com/q/9mXr2kQ8vT0bN4sLwY7cJ1pE5hA3uZ6dG8fK0oR2iV4'
              : 'https://app.integr8-media.com/d/Qm3vX8kT2pL9sN4wR7yB1c',
          qrOpensQuote: kind === 'quote',
          images: { logo: logo ?? null, media },
          look: { brandColour: '#0e7490', fontKey: 'noto-sans', logo: logo ?? null },
          fontFaceCss: await documentFontFaces('noto-sans'),
        });
        const pdf = await printer.print({ html: rendered.html, ...rendered.parts });
        const file = join(out, `${kind.replace('_', '-')}-${locale}.pdf`);
        await writeFile(file, pdf);
        process.stdout.write(`${file}\n`);
      }
    }
  } finally {
    await printer.close();
  }
}

await main();
