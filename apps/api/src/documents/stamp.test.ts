import type { DocumentRecord } from '@integr8/db';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { needsReprint } from './render.js';
import { qrPlacementSchema, stampQr } from './stamp.js';

async function pdf(pages: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (let page = 0; page < pages; page += 1) {
    document.addPage([595, 842]);
  }
  return document.save();
}

/** The drawing instructions of each page, as text. */
async function contents(bytes: Uint8Array): Promise<string[]> {
  const document = await PDFDocument.load(bytes);
  return document.getPages().map((page) => {
    const stream = page.node.Contents();
    return stream === undefined ? '' : String(stream.toString().length);
  });
}

describe('stamping the share QR code into an uploaded PDF (0075)', () => {
  it('draws on the chosen pages only, and keeps every page', async () => {
    const original = await pdf(3);
    const link = 'https://www.example.com/documents/AbCdEfGhIjKlMnOpQrStUv';
    const last = await stampQr(original, { page: 'last', x: 0.8, y: 0.85, size: 0.15 }, link);
    expect(last.pageCount).toBe(3);
    const drawn = await contents(last.bytes);
    expect(drawn[0]).toBe('');
    expect(drawn[1]).toBe('');
    expect(drawn[2]).not.toBe('');

    const every = await stampQr(original, { page: 'all', x: 0, y: 0, size: 0.1 }, link);
    expect((await contents(every.bytes)).every((page) => page !== '')).toBe(true);
    // The PDF as uploaded is left as it was.
    expect((await contents(original)).every((page) => page === '')).toBe(true);
  });

  it('refuses a place off the page', () => {
    expect(qrPlacementSchema.safeParse({ page: 'first', x: 0.9, y: 0, size: 0.2 }).success).toBe(
      false,
    );
    expect(qrPlacementSchema.safeParse({ page: 'first', x: 0.1, y: 0.1, size: 0.6 }).success).toBe(
      false,
    );
    expect(qrPlacementSchema.safeParse({ page: 'first', x: 0.7, y: 0.9, size: 0.2 }).success).toBe(
      true,
    );
  });
});

describe('whether a document needs re-printing (0075)', () => {
  const base = {
    status: 'ready',
    source: 'generated',
    qrSpot: true,
    qrPrinted: false,
    shareable: false,
    originalFileId: null,
  } as unknown as DocumentRecord;
  const doc = (overrides: Partial<DocumentRecord>) => ({ ...base, ...overrides });

  it('re-prints a template PDF once shared, and only once', () => {
    expect(needsReprint(doc({}))).toBe(false);
    expect(needsReprint(doc({ shareable: true }))).toBe(true);
    expect(needsReprint(doc({ shareable: true, qrPrinted: true }))).toBe(false);
    expect(needsReprint(doc({ shareable: true, qrSpot: false }))).toBe(false);
    expect(needsReprint(doc({ shareable: true, status: 'pending' }))).toBe(false);
  });

  it('stamps an uploaded PDF when shared or moved, and restores it when its code goes', () => {
    const uploaded = (overrides: Partial<DocumentRecord>) =>
      doc({ source: 'uploaded', ...overrides });
    expect(needsReprint(uploaded({}))).toBe(false);
    expect(needsReprint(uploaded({ shareable: true }))).toBe(true);
    // Shared once, then stopped: a moved code is stamped again.
    expect(needsReprint(uploaded({ qrPrinted: true }))).toBe(true);
    // The code taken away from a stamped PDF: back to the original.
    expect(needsReprint(uploaded({ qrSpot: false, originalFileId: 'f' }))).toBe(true);
    expect(needsReprint(uploaded({ qrSpot: false }))).toBe(false);
  });
});
