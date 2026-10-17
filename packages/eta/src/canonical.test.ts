import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalBytes, canonicalDigest, canonicalText, toHex } from './canonical.js';
import { parseJsonText } from './json-text.js';

describe('the ETA canonical serialisation', () => {
  it('upper-cases names, quotes values as written, and drops braces and commas', () => {
    expect(canonicalText(parseJsonText('{"issuer":{"type":"B","id":"123"},"total":10.50}'))).toBe(
      '"ISSUER""TYPE""B""ID""123""TOTAL""10.50"',
    );
  });

  it('keeps a number exactly as written: 1.10 is not 1.1, 100.00000 is not 100', () => {
    expect(canonicalText(parseJsonText('{"a":1.10,"b":100.00000,"c":1e2,"d":-0.0}'))).toBe(
      '"A""1.10""B""100.00000""C""1e2""D""-0.0"',
    );
  });

  it('repeats an array’s name before each entry, and once before them (canonical-array)', () => {
    const doc = parseJsonText(
      '{"taxTotals":[{"taxType":"T1","amount":1},{"taxType":"T2","amount":2}],"x":"y"}',
    );
    expect(canonicalText(doc)).toBe(
      '"TAXTOTALS""TAXTOTALS""TAXTYPE""T1""AMOUNT""1""TAXTOTALS""TAXTYPE""T2""AMOUNT""2""X""y"',
    );
    expect(canonicalText(doc, { arrayNameOnce: false })).toBe(
      '"TAXTOTALS""TAXTYPE""T1""AMOUNT""1""TAXTOTALS""TAXTYPE""T2""AMOUNT""2""X""y"',
    );
  });

  it('serialises arrays of simple values and empty arrays', () => {
    expect(canonicalText(parseJsonText('{"refs":["a","b"],"none":[]}'))).toBe(
      '"REFS""REFS""a""REFS""b""NONE"',
    );
  });

  it('leaves the top-level signatures out, and only those', () => {
    const doc = parseJsonText(
      '{"a":"1","signatures":[{"signatureType":"I","value":"abc"}],"b":{"signatures":"kept"}}',
    );
    expect(canonicalText(doc)).toBe('"A""1""B""SIGNATURES""kept"');
  });

  it('hashes the UTF-8 bytes, Arabic included', async () => {
    const doc = parseJsonText('{"name":"شركة"}');
    const bytes = canonicalBytes(doc);
    expect(Buffer.from(bytes).toString('utf8')).toBe('"NAME""شركة"');
    expect(toHex(await canonicalDigest(doc))).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });

  it('refuses a document that is not an object', () => {
    expect(() => canonicalText(parseJsonText('[1]'))).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// The ETA's own public sample (fetched by scripts/fetch_eta_refs.py)
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const official = join(here, '..', '..', '..', 'docs', 'e-invoicing', 'official-public');
const manifestPath = join(official, 'manifest.json');
const fetched = existsSync(manifestPath);

/**
 * Skipped, not passed, while the official files are missing: see
 * docs/e-invoicing/official-public/FETCH-STATUS.md. The sample is a legacy
 * v0.9 document; it settles the serialisation, not the v1.0 fields.
 */
describe.skipIf(!fetched)('the official public sample (legacy v0.9)', () => {
  const manifest = fetched
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        filename: string;
        source_url: string;
        sha256: string;
      }[])
    : [];
  const read = (name: string) => readFileSync(join(official, name));

  it('matches the recorded checksums and comes from the ETA SDK', () => {
    expect(manifest.length).toBeGreaterThan(0);
    for (const entry of manifest) {
      expect(entry.source_url.startsWith('https://sdk.invoicing.eta.gov.eg/files/')).toBe(true);
      expect(createHash('sha256').update(read(entry.filename)).digest('hex')).toBe(entry.sha256);
    }
  });

  it('serialises the unsigned sample to the official canonical text, byte for byte', () => {
    const unsigned = read('eta-unsigned-legacy-v0.9.json').toString('utf8');
    const expected = read('eta-canonical-legacy-v0.9.txt')
      .toString('utf8')
      .replace(/^\uFEFF/u, '')
      .trimEnd();
    expect(canonicalText(parseJsonText(unsigned))).toBe(expected);
  });

  it('keeps every numeric lexeme of the sample in the canonical text', () => {
    const unsigned = read('eta-unsigned-legacy-v0.9.json').toString('utf8');
    const canonical = canonicalText(parseJsonText(unsigned));
    const lexemes = unsigned.match(/(?<=:\s*)-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu) ?? [];
    expect(lexemes.length).toBeGreaterThan(0);
    for (const lexeme of lexemes) {
      expect(canonical).toContain(`"${lexeme}"`);
    }
  });

  it('serialises the signed sample to the same text: its signatures are left out', () => {
    const signed = read('eta-signed-legacy-v0.9.json').toString('utf8');
    const unsigned = read('eta-unsigned-legacy-v0.9.json').toString('utf8');
    expect(canonicalText(parseJsonText(signed))).toBe(canonicalText(parseJsonText(unsigned)));
  });
});
