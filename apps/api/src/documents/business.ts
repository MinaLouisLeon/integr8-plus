import { createHash, randomUUID } from 'node:crypto';
import {
  DOCUMENT_FILE_ENTITY,
  getPlatformDataSource,
  isBusinessDocumentKind,
  withTenant,
} from '@integr8/db';
import {
  type BusinessDocumentData,
  type BusinessLocale,
  renderBusinessDocumentHtml,
} from '@integr8/document-render';
import { ApiError } from '../http/errors.js';
import { planFor } from '../http/suspension.js';
import { assertUploadFits } from '../media/quota.js';
import type { ObjectStore } from '../media/storage.js';
import { getStorage, StorageNotReadyError } from '../media/tenant-storage.js';
import { underlayBackgrounds } from './backgrounds.js';
import { inlineImage } from './images.js';
import { PrinterUnavailableError, PrintTimeoutError } from './printer.js';
import {
  documentKey,
  NotPending,
  printable,
  RenderFailed,
  type RenderDeps,
  type RenderOutcome,
} from './render.js';

/**
 * Printing a business PDF (1.3.0, decision 11): a quote, an invoice, a
 * purchase order or a job report, from the snapshot the API took when the
 * person asked, in the company's look.
 *
 * The same pipeline as a form document's (`render.ts`): the same printer, the
 * same retries, the company's bucket and storage allowance, the media ledger,
 * and a document that ends ready or failed, never pending. Only what is
 * printed differs, so this queue is its own: a worker from before 1.3.0 that
 * does not know it dead-letters the job instead of failing the document.
 */

export const BUSINESS_DOCUMENT_QUEUE = 'documents.render_business';
export const BUSINESS_DOCUMENT_ATTEMPTS = 3;

/** Photos and signatures are printed small; this is plenty for a third of a page. */
const PHOTO_MAX_PX = 900;

/** What the API hands the worker. */
export interface BusinessDocumentJob {
  documentId: string;
  data: BusinessDocumentData;
  locale: BusinessLocale;
  qrUrl: string | null;
  qrOpensQuote: boolean;
}

/** The pictures a snapshot names: the job report's photos and the customer's signature. */
export function businessMediaIds(data: BusinessDocumentData): string[] {
  if (data.kind !== 'job_report') {
    return [];
  }
  return [
    ...data.photos.map((photo) => photo.fileId),
    ...(data.signoff?.signatureFileId == null ? [] : [data.signoff.signatureFileId]),
  ];
}

function jobOf(payload: Readonly<Record<string, unknown>>): BusinessDocumentJob | undefined {
  const data = payload.data as { kind?: unknown } | undefined;
  if (
    typeof payload.documentId !== 'string' ||
    data === undefined ||
    typeof data.kind !== 'string' ||
    !isBusinessDocumentKind(data.kind)
  ) {
    return undefined;
  }
  return {
    documentId: payload.documentId,
    data: payload.data as BusinessDocumentData,
    locale: payload.locale === 'ar' ? 'ar' : 'en',
    qrUrl: typeof payload.qrUrl === 'string' ? payload.qrUrl : null,
    qrOpensQuote: payload.qrOpensQuote === true,
  };
}

export async function renderBusinessDocument(
  deps: RenderDeps,
  job: { tenantId: string; attempt: number; payload: Readonly<Record<string, unknown>> },
): Promise<RenderOutcome> {
  const { tenantId } = job;
  const brand = await getPlatformDataSource().tenantSettings.brandByTenantId(tenantId);
  if (brand === undefined) {
    return { outcome: 'skipped', reason: 'company_gone' };
  }
  const documentId =
    typeof job.payload.documentId === 'string' ? job.payload.documentId : undefined;
  if (documentId === undefined) {
    return { outcome: 'skipped', reason: 'not_pending' };
  }
  try {
    const parsed = jobOf(job.payload);
    if (parsed === undefined) {
      throw new RenderFailed('source_missing', false, 'The job does not say what to print.');
    }
    return await print(deps, {
      tenantId,
      job: parsed,
      companyName: brand.name,
      brandColour: brand.brandColour,
      logoMediaId: brand.logoMediaId,
    });
  } catch (error) {
    if (error instanceof NotPending) {
      return { outcome: 'skipped', reason: 'not_pending' };
    }
    const failure =
      error instanceof RenderFailed
        ? error
        : new RenderFailed(
            'render_failed',
            true,
            error instanceof Error ? error.message : String(error),
          );
    if (failure.retry && job.attempt < BUSINESS_DOCUMENT_ATTEMPTS) {
      deps.logger.warn('Business PDF failed; will retry', {
        documentId,
        reason: failure.reason,
        error: failure.message,
        attempt: job.attempt,
      });
      throw failure;
    }
    deps.logger.error('Business PDF failed', {
      documentId,
      reason: failure.reason,
      error: failure.message,
      attempt: job.attempt,
    });
    await withTenant(tenantId, (tx) => tx.documents.markFailed(documentId, failure.reason));
    return { outcome: 'failed', reason: failure.reason };
  }
}

async function print(
  deps: RenderDeps,
  input: {
    tenantId: string;
    job: BusinessDocumentJob;
    companyName: string;
    brandColour: string | null;
    logoMediaId: string | null;
  },
): Promise<RenderOutcome> {
  const { tenantId, job } = input;

  // 1. The document, still waiting, and the pictures it names.
  const gathered = await withTenant(tenantId, async (tx) => {
    const document = await tx.documents.find(job.documentId);
    if (document?.status !== 'pending') {
      throw new NotPending();
    }
    if (document.source !== job.data.kind) {
      throw new RenderFailed('source_missing', false, 'The job is for another kind of document.');
    }
    const [settings, files] = await Promise.all([
      tx.settings.get(),
      tx.files.findMany([
        ...businessMediaIds(job.data),
        ...(input.logoMediaId === null ? [] : [input.logoMediaId]),
      ]),
    ]);
    return { document, timeZone: settings.timezone, files };
  });
  const { document, timeZone, files } = gathered;

  // 2. The pictures, from the company's bucket.
  let store: ObjectStore;
  try {
    store = await getStorage(deps.media, tenantId);
  } catch (error) {
    throw new RenderFailed(
      'storage_unavailable',
      !(error instanceof StorageNotReadyError),
      error instanceof Error ? error.message : String(error),
    );
  }
  const byId = new Map(files.map((file) => [file.id, file]));
  const inline = async (fileId: string | null, maxPx?: number): Promise<string | undefined> => {
    const file = fileId === null ? undefined : byId.get(fileId);
    if (file === undefined || !printable(file)) {
      return undefined;
    }
    let bytes: Uint8Array | undefined;
    try {
      bytes = await store.get(file.storageKey);
    } catch (error) {
      throw new RenderFailed(
        'storage_unavailable',
        true,
        error instanceof Error ? error.message : String(error),
      );
    }
    return bytes === undefined ? undefined : inlineImage(bytes, maxPx);
  };
  const logo = (await inline(input.logoMediaId)) ?? null;
  const media: Record<string, string> = {};
  for (const mediaId of businessMediaIds(job.data)) {
    const made = await inline(mediaId, PHOTO_MAX_PX);
    if (made !== undefined) {
      media[mediaId] = made;
    }
  }

  // 3. Print.
  const rendered = renderBusinessDocumentHtml({
    data: job.data,
    locale: job.locale,
    timeZone,
    qrUrl: job.qrUrl,
    qrOpensQuote: job.qrOpensQuote,
    images: { logo, media },
    // The company's colour and logo, in Noto Sans (both scripts). When the
    // shared look carries a font choice, its faces go in as `fontFaceCss`
    // (`documentFontFaces(look.fontKey)`).
    look: { brandColour: input.brandColour, fontKey: 'noto-sans', logo },
  });
  const status = await deps.pdf.status();
  if (!status.ok) {
    throw new RenderFailed('renderer_unavailable', false, status.reason);
  }
  let printed: Uint8Array;
  try {
    printed = await deps.pdf.print({ html: rendered.html, ...rendered.parts });
  } catch (error) {
    if (error instanceof PrinterUnavailableError) {
      throw new RenderFailed('renderer_unavailable', false, error.message);
    }
    if (error instanceof PrintTimeoutError) {
      throw new RenderFailed('render_timeout', true, error.message);
    }
    throw new RenderFailed(
      'render_failed',
      true,
      error instanceof Error ? error.message : String(error),
    );
  }
  // No background; this only names the PDF and counts its pages.
  const pdf = await underlayBackgrounds(
    printed,
    { every: null },
    { title: document.title, author: input.companyName },
  );

  // 4. Store it, within the company's allowance.
  try {
    await assertUploadFits({
      plan: await planFor(tenantId),
      usage: await withTenant(tenantId, (tx) => tx.files.usage()),
      incomingBytes: pdf.bytes.byteLength,
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'storage_quota_exceeded') {
      throw new RenderFailed('storage_quota_exceeded', false, error.message);
    }
    throw error;
  }
  const fileId = randomUUID();
  const key = documentKey(fileId);
  let stored;
  try {
    stored = await store.put({ key, body: pdf.bytes, contentType: 'application/pdf' });
  } catch (error) {
    throw new RenderFailed(
      'storage_unavailable',
      true,
      error instanceof Error ? error.message : String(error),
    );
  }
  const sha256 = createHash('sha256').update(pdf.bytes).digest('hex');
  const marked = await withTenant(tenantId, async (tx) => {
    await tx.files.recordGenerated({
      id: fileId,
      bucket: store.bucket,
      storageKey: key,
      stored: { byteSize: stored.byteSize, etag: stored.etag, contentType: 'application/pdf' },
      category: 'document',
      uploadedBy: document.createdBy,
      linkedEntity: { type: DOCUMENT_FILE_ENTITY, id: document.id },
    });
    const ready = await tx.documents.markReady(document.id, {
      fileId,
      byteSize: stored.byteSize,
      pageCount: pdf.pageCount,
      sha256,
    });
    if (!ready) {
      await tx.files.softDelete(fileId, document.createdBy, new Date());
    }
    return ready;
  });
  if (!marked) {
    throw new NotPending();
  }
  deps.logger.info('Business PDF printed', {
    documentId: document.id,
    kind: job.data.kind,
    fileId,
    pageCount: pdf.pageCount,
    byteSize: stored.byteSize,
  });
  return { outcome: 'ready', fileId, pageCount: pdf.pageCount, byteSize: stored.byteSize };
}
