import { type JsonText, withoutProperty } from './json-text.js';

/**
 * The ETA's serialisation of a document, the text its signature covers
 * (https://sdk.invoicing.eta.gov.eg/document-serialization-approach/; notes in
 * docs/e-invoicing/README.md "Document and signing").
 *
 * - Property names are upper-cased and quoted.
 * - Simple values are quoted exactly as written: a number keeps its lexeme.
 * - There are no braces, brackets, colons or commas.
 * - An array's property name is repeated before each of its entries.
 * - The document is serialised without its `signatures`.
 *
 * SPEC-UNVERIFIED(canonical-array): from memory of the SDK's pseudo-code, the
 * array's name *also* appears once before its first entry. That is the default
 * here, and the only switch, so the official fixture can settle it in one
 * place (`arrayNameOnce`).
 *
 * SPEC-UNVERIFIED(canonical-escapes): a string is written as its escaped JSON
 * source text. How the ETA serialises a string with a quote, a backslash or a
 * control character is not confirmed, so documents built here never contain
 * one (see `invoice.ts`, `text_unsupported`).
 */

export interface CanonicalOptions {
  /** Write an array's name once before its entries as well as before each. Default true. */
  arrayNameOnce?: boolean;
}

function upper(name: string): string {
  return `"${name.toUpperCase()}"`;
}

function serialize(value: JsonText, options: Required<CanonicalOptions>): string {
  switch (value.kind) {
    case 'string':
    case 'number':
    case 'literal':
      return `"${value.raw}"`;
    case 'array':
      // A bare array has no name to repeat; ETA documents never have one below a property.
      return value.items.map((item) => serialize(item, options)).join('');
    case 'object': {
      let out = '';
      for (const entry of value.entries) {
        if (entry.value.kind === 'array') {
          if (options.arrayNameOnce) {
            out += upper(entry.name);
          }
          for (const item of entry.value.items) {
            out += upper(entry.name) + serialize(item, options);
          }
        } else {
          out += upper(entry.name) + serialize(entry.value, options);
        }
      }
      return out;
    }
  }
}

/** The canonical text of a document, its `signatures` left out. */
export function canonicalText(document: JsonText, options: CanonicalOptions = {}): string {
  if (document.kind !== 'object') {
    throw new TypeError('A document is an object');
  }
  return serialize(withoutProperty(document, 'signatures'), {
    arrayNameOnce: options.arrayNameOnce ?? true,
  });
}

/** The UTF-8 bytes the signature's message digest covers. */
export function canonicalBytes(document: JsonText, options: CanonicalOptions = {}): Uint8Array {
  return new TextEncoder().encode(canonicalText(document, options));
}

/** SHA-256 of the canonical bytes, through Web Crypto (browsers, Node 20+). */
export async function canonicalDigest(
  document: JsonText,
  options: CanonicalOptions = {},
): Promise<Uint8Array> {
  const bytes = canonicalBytes(document, options);
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return new Uint8Array(digest);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/u.test(hex)) {
    throw new TypeError('Not lower-case hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
