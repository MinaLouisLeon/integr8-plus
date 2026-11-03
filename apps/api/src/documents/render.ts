import { createHash, randomUUID } from 'node:crypto';
import {
  DOCUMENT_FILE_ENTITY,
  type DocumentRecord,
  type FileRecord,
  getPlatformDataSource,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import {
  allBlocks,
  designFileIds,
  designHasShareQr,
  designMediaFields,
  designUsesLogo,
  type DocumentLocale,
  mediaIdsOf,
  parseDesign,
  renderDocumentHtml,
  type RenderImages,
  type ResolvedField,
  type SubmissionFacts,
  type TemplateDesign,
} from '@integr8/document-render';
import type { CompiledForm } from '@integr8/form-engine';
import type { ApiConfig } from '../config.js';
import { ApiError } from '../http/errors.js';
import type { Logger } from '../http/logger.js';
import { planFor } from '../http/suspension.js';
import { assertUploadFits } from '../media/quota.js';
import type { MediaStorage, ObjectStore } from '../media/storage.js';
import { getStorage, StorageNotReadyError } from '../media/tenant-storage.js';
import { type Backgrounds, underlayBackgrounds } from './backgrounds.js';
import { documentFontFaces } from './fonts.js';
import { backgroundImage, inlineImage } from './images.js';
import { type PdfPrinter, PrinterUnavailableError, PrintTimeoutError } from './printer.js';
import { documentSources } from './sources.js';
import { stampQr } from './stamp.js';

/**
 * The render job (ADR-0001 D4, D5, D12): a pending document becomes a PDF in
 * the company's bucket, recorded in the media ledger and linked to the
 * document, or a failed document with a reason the person who asked can read.
 *
 * Every way it can end leaves the document ready or failed, never pending: a
 * failure that another attempt might fix (a timeout, storage unreachable) is
 * retried until the last attempt, which records it.
 */

export const DOCUMENT_RENDER_QUEUE = 'documents.render';
/**
 * Brings a ready document's file in line with its share QR code (0075): a
 * document with a place for the code gets it once shared, by a re-print (made
 * from a template) or a stamp (uploaded); an uploaded PDF whose code was
 * moved is stamped again from its original, or goes back to it.
 */
export const DOCUMENT_REPRINT_QUEUE = 'documents.reprint';
/** Attempts before a render that keeps failing is recorded as failed. */
export const DOCUMENT_RENDER_ATTEMPTS = 3;

/** Why a document failed, as the apps show it. */
export type RenderFailure =
  | 'renderer_unavailable'
  | 'render_timeout'
  | 'render_failed'
  | 'template_invalid'
  | 'source_missing'
  | 'storage_unavailable'
  | 'storage_quota_exceeded';

/** Where a document's PDF lives in its company's bucket. */
export const documentKey = (fileId: string) => `documents/${fileId}.pdf`;

/**
 * The link a document's QR code opens (D7).
 *
 * The company's own website when Integr8 set an address for it (0075), such as
 * `https://example.com/documents/{code}`, so a customer lands on the company's
 * site rather than ours; Integr8's `/d/<code>` page otherwise. Codes already
 * printed keep opening `/d/` either way: that page is never taken away.
 */
export function documentLink(
  config: ApiConfig,
  publicCode: string,
  pattern?: string | null,
): string | null {
  if (pattern?.includes(DOCUMENT_CODE_PLACEHOLDER) === true) {
    return pattern.split(DOCUMENT_CODE_PLACEHOLDER).join(encodeURIComponent(publicCode));
  }
  return config.WEB_APP_URL === undefined
    ? null
    : `${config.WEB_APP_URL.replace(/\/+$/u, '')}/d/${publicCode}`;
}

/** Where the code goes in a company's document link address (0075). */
export const DOCUMENT_CODE_PLACEHOLDER = '{code}';

/**
 * Why a document link address cannot be used, or null when it can: https, with
 * `{code}` in its path or query, and on the company's registered website (the
 * same host, or one under it), so a link never sends a customer somewhere the
 * company did not register with Integr8.
 */
export function documentLinkPatternProblem(
  pattern: string,
  websiteUrl: string | null,
): 'document_link_invalid' | 'document_link_needs_website' | 'document_link_other_site' | null {
  if (pattern.length > 500 || !pattern.includes(DOCUMENT_CODE_PLACEHOLDER) || /\s/u.test(pattern)) {
    return 'document_link_invalid';
  }
  let url: URL;
  try {
    url = new URL(pattern.split(DOCUMENT_CODE_PLACEHOLDER).join('code'));
  } catch {
    return 'document_link_invalid';
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return 'document_link_invalid';
  }
  // The code goes in the path or the query, never in the host name.
  const authority = pattern.replace(/^https:\/\//u, '').split(/[/?#]/u)[0] ?? '';
  if (authority.includes(DOCUMENT_CODE_PLACEHOLDER)) {
    return 'document_link_invalid';
  }
  if (websiteUrl === null) {
    return 'document_link_needs_website';
  }
  let site: string;
  try {
    site = new URL(websiteUrl).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return 'document_link_needs_website';
  }
  const host = url.hostname.toLowerCase();
  return host === site || host.endsWith(`.${site}`) ? null : 'document_link_other_site';
}

/** At most this many photos and signatures are printed in one document. */
const MAX_MEDIA_IMAGES = 120;

export interface RenderDeps {
  media: MediaStorage;
  pdf: PdfPrinter;
  config: ApiConfig;
  logger: Logger;
}

export type RenderOutcome =
  | { outcome: 'ready'; fileId: string; pageCount: number; byteSize: number }
  | { outcome: 'failed'; reason: RenderFailure }
  | { outcome: 'skipped'; reason: 'not_pending' | 'company_gone' };

export class RenderFailed extends Error {
  constructor(
    readonly reason: RenderFailure,
    readonly retry: boolean,
    detail: string,
  ) {
    super(detail);
    this.name = 'RenderFailed';
  }
}

export async function renderDocument(
  deps: RenderDeps,
  job: { tenantId: string; documentId: string; attempt: number; design?: unknown },
): Promise<RenderOutcome> {
  const { tenantId, documentId } = job;
  const brand = await getPlatformDataSource().tenantSettings.brandByTenantId(tenantId);
  if (brand === undefined) {
    return { outcome: 'skipped', reason: 'company_gone' };
  }

  try {
    return await render(deps, {
      ...job,
      companyName: brand.name,
      logoMediaId: brand.logoMediaId,
      brandColour: brand.brandColour,
      documentLinkPattern: brand.documentLinkPattern,
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
    if (failure.retry && job.attempt < DOCUMENT_RENDER_ATTEMPTS) {
      deps.logger.warn('Document render failed; will retry', {
        documentId,
        reason: failure.reason,
        error: failure.message,
        attempt: job.attempt,
      });
      throw failure;
    }
    deps.logger.error('Document render failed', {
      documentId,
      reason: failure.reason,
      error: failure.message,
      attempt: job.attempt,
    });
    await withTenant(tenantId, (tx) => tx.documents.markFailed(documentId, failure.reason));
    return { outcome: 'failed', reason: failure.reason };
  }
}

/** The document was deleted or settled by someone else: nothing to do. */
export class NotPending extends Error {}

async function render(
  deps: RenderDeps,
  job: {
    tenantId: string;
    documentId: string;
    design?: unknown;
    companyName: string;
    logoMediaId: string | null;
    brandColour: string | null;
    /** Where the company's document links point (0075); null for Integr8's page. */
    documentLinkPattern?: string | null;
  },
): Promise<RenderOutcome> {
  const { tenantId, documentId } = job;

  // 1. What to print, read in one go.
  const gathered = await withTenant(tenantId, async (tx) => {
    const document = await tx.documents.find(documentId);
    if (document?.status !== 'pending') {
      throw new NotPending();
    }
    // Only a generated document is ever printed; an uploaded one is ready from the start.
    const { templateId, submissionId } = document;
    if (templateId === null || submissionId === null) {
      throw new RenderFailed('source_missing', false, 'An uploaded document has nothing to print.');
    }
    const [template, submission] = await Promise.all([
      tx.documentTemplates.find(templateId),
      tx.submissions.findById(submissionId),
    ]);
    if (template === undefined || submission === undefined) {
      throw new RenderFailed('source_missing', false, 'The template or the submission is gone.');
    }
    // The design as it was when the document was asked for; the template's
    // current one only for a job queued before designs travelled with it.
    const parsed = parseDesign(job.design ?? template.design);
    if (!parsed.ok) {
      throw new RenderFailed('template_invalid', false, JSON.stringify(parsed.issues.slice(0, 5)));
    }
    const design = parsed.design;
    const sources = await documentSources(tx, {
      submission,
      design,
      companyName: job.companyName,
      documentDate: document.createdAt,
    });
    return { document, design, sources };
  });
  const { document, design, sources } = gathered;
  // The share QR code is printed only once the document is shared (0075);
  // until then its place stays blank, and sharing it re-prints it.
  const shareLink = document.shareable
    ? documentLink(deps.config, document.publicCode, job.documentLinkPattern)
    : null;

  // 2 and 3. Pictures from the company's bucket, printed, backgrounds laid underneath.
  const { pdf, store } = await printDesign(deps, {
    tenantId,
    design,
    form: sources.form,
    answers: sources.answers,
    locale: sources.locale,
    facts: sources.facts,
    fields: document.fields,
    qrUrl: shareLink,
    qrBlank: true,
    today: sources.today,
    logoMediaId: job.logoMediaId,
    brandColour: job.brandColour,
    title: document.title,
  });

  // 4. Store it, within the company's allowance (D5).
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
      qrPrinted: shareLink !== null && designHasShareQr(design),
    });
    if (!ready) {
      // Deleted or settled while printing: the file goes the way of any
      // deleted file, through the restore window to the purge.
      await tx.files.softDelete(fileId, document.createdBy, new Date());
      return ready;
    }
    // Shared while it was printing: the code is added now.
    await queueReprintIfNeeded(tx, document.id);
    return ready;
  });
  if (!marked) {
    throw new NotPending();
  }
  deps.logger.info('Document rendered', {
    documentId,
    fileId,
    pageCount: pdf.pageCount,
    byteSize: stored.byteSize,
  });
  return { outcome: 'ready', fileId, pageCount: pdf.pageCount, byteSize: stored.byteSize };
}

/** Everything a design is printed with, besides the company's files. */
export interface PrintInput {
  tenantId: string;
  design: TemplateDesign;
  form: CompiledForm;
  answers: Readonly<Record<string, unknown>>;
  locale: DocumentLocale;
  facts: SubmissionFacts;
  fields: readonly ResolvedField[];
  qrUrl: string | null;
  today: string;
  logoMediaId: string | null;
  /** The company's accent colour, for a template whose brand colour is the company's. */
  brandColour: string | null;
  /** The PDF's title. */
  title: string;
  /** With no `qrUrl`, leave a share QR code's place empty rather than marked (0075). */
  qrBlank?: boolean;
}

/**
 * A design filled with answers, as PDF bytes: its pictures read from the
 * company's bucket, its fonts embedded, printed by Chromium, its backgrounds
 * drawn underneath. Shared by the render job, which stores the result, and
 * the designer's preview (1.3.0), which only returns it. Failures are
 * {@link RenderFailed}, with whether another attempt might help.
 */
export async function printDesign(
  deps: Pick<RenderDeps, 'media' | 'pdf'>,
  input: PrintInput,
): Promise<{ pdf: { bytes: Uint8Array; pageCount: number }; store: ObjectStore }> {
  const { tenantId, design } = input;
  const mediaIds = designMediaFields(design, input.form)
    .flatMap((fieldId) => mediaIdsInAnswers(input.answers, fieldId))
    .slice(0, MAX_MEDIA_IMAGES);
  const wantsLogo = designUsesLogo(design);
  const files = await withTenant(tenantId, (tx) =>
    tx.files.findMany([
      ...designFileIds(design),
      ...mediaIds,
      ...(wantsLogo && input.logoMediaId !== null ? [input.logoMediaId] : []),
    ]),
  );

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
  const read = async (fileId: string | null | undefined): Promise<Uint8Array | undefined> => {
    const file = fileId === null || fileId === undefined ? undefined : byId.get(fileId);
    if (file === undefined || !printable(file)) {
      return undefined;
    }
    try {
      return await store.get(file.storageKey);
    } catch (error) {
      throw new RenderFailed(
        'storage_unavailable',
        true,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const inline = async (fileId: string | null | undefined) => {
    const bytes = await read(fileId);
    return bytes === undefined ? undefined : inlineImage(bytes);
  };

  const images: {
    logo: string | null;
    files: Record<string, string>;
    media: Record<string, string>;
  } = {
    logo: wantsLogo ? ((await inline(input.logoMediaId)) ?? null) : null,
    files: {},
    media: {},
  };
  for (const block of allBlocks(design)) {
    if (block.type === 'image' && block.source.kind === 'file') {
      const made = await inline(block.source.fileId);
      if (made !== undefined) {
        images.files[block.source.fileId] = made;
      }
    }
  }
  for (const mediaId of mediaIds) {
    const made = await inline(mediaId);
    if (made !== undefined) {
      images.media[mediaId] = made;
    }
  }
  const backgrounds = await readBackgrounds(design, read);

  const rendered = renderDocumentHtml({
    design,
    form: input.form,
    answers: input.answers,
    locale: input.locale,
    facts: input.facts,
    fields: input.fields,
    qrUrl: input.qrUrl,
    qrBlank: input.qrBlank ?? false,
    images: images satisfies RenderImages,
    mode: 'pdf',
    today: input.today,
    companyBrandColour: input.brandColour,
    fontFaceCss: await documentFontFaces(design.style.font),
  });
  const status = await deps.pdf.status();
  if (!status.ok) {
    throw new RenderFailed('renderer_unavailable', false, status.reason);
  }
  let printed: Uint8Array;
  try {
    printed = await deps.pdf.print(rendered);
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
  const pdf = await underlayBackgrounds(printed, backgrounds, {
    title: input.title,
    author: input.facts.companyName,
  });
  return { pdf, store };
}

/** A file's bytes may go into a document: not deleted, and a picture. */
export function printable(file: FileRecord): boolean {
  return file.deletedAt === null && file.purgedAt === null && file.contentType.startsWith('image/');
}

function mediaIdsInAnswers(answers: Readonly<Record<string, unknown>>, fieldId: string): string[] {
  const ids = mediaIdsOf(answers[fieldId]);
  // Inside repeating sections the answer sits in each entry's values.
  for (const value of Object.values(answers)) {
    if (Array.isArray(value)) {
      for (const entry of value as unknown[]) {
        const values = (entry as { values?: unknown } | null)?.values;
        if (values !== null && typeof values === 'object') {
          ids.push(...mediaIdsOf((values as Record<string, unknown>)[fieldId]));
        }
      }
    }
  }
  return ids;
}

async function readBackgrounds(
  design: TemplateDesign,
  read: (fileId: string) => Promise<Uint8Array | undefined>,
): Promise<Backgrounds> {
  const load = async (background: { fileId: string } | null) => {
    if (background === null) {
      return null;
    }
    const bytes = await read(background.fileId);
    return bytes === undefined
      ? null
      : ((await backgroundImage(bytes, design.page.orientation)) ?? null);
  };
  const every = await load(design.page.background);
  const firstPage = design.page.firstPage;
  return firstPage === null ? { every } : { every, first: await load(firstPage.background) };
}

// ---------------------------------------------------------------------------
// The share QR code, once shared (0075)
// ---------------------------------------------------------------------------

/** Whether a document's file is out of line with its share QR code. */
export function needsReprint(document: DocumentRecord): boolean {
  if (document.status !== 'ready' || !document.qrSpot) {
    return document.source === 'uploaded' && document.originalFileId !== null && !document.qrSpot;
  }
  if (document.source === 'uploaded') {
    // Stamped once shared, and kept after; moved, stamped again.
    return document.shareable || document.qrPrinted;
  }
  return document.shareable && !document.qrPrinted;
}

/** Queues the re-print when the document needs one; at most one waits at a time per document. */
export async function queueReprintIfNeeded(
  tx: TenantTransaction,
  documentId: string,
): Promise<boolean> {
  const document = await tx.documents.find(documentId);
  if (document === undefined || !needsReprint(document)) {
    return false;
  }
  await tx.jobs.enqueue({
    queue: DOCUMENT_REPRINT_QUEUE,
    payload: { documentId },
    maxAttempts: DOCUMENT_RENDER_ATTEMPTS,
  });
  return true;
}

export type ReprintOutcome =
  | { outcome: 'reprinted'; fileId: string }
  | { outcome: 'restored'; fileId: string }
  | { outcome: 'skipped'; reason: 'nothing_to_do' | 'company_gone' | 'source_missing' };

/**
 * Makes the file a document serves match its share QR code: re-printed from
 * the design it was first printed from, or stamped from the PDF as uploaded,
 * or (an uploaded PDF whose code was taken away) the original again. The old
 * file goes through the media restore window like any replaced file. A
 * failure that another attempt might fix is retried; the document keeps
 * serving the file it had meanwhile, so nobody is left without a PDF.
 */
export async function reprintDocument(
  deps: RenderDeps,
  job: { tenantId: string; documentId: string; attempt: number },
): Promise<ReprintOutcome> {
  const { tenantId, documentId } = job;
  const brand = await getPlatformDataSource().tenantSettings.brandByTenantId(tenantId);
  if (brand === undefined) {
    return { outcome: 'skipped', reason: 'company_gone' };
  }
  const document = await withTenant(tenantId, (tx) => tx.documents.find(documentId));
  if (document === undefined || !needsReprint(document)) {
    return { outcome: 'skipped', reason: 'nothing_to_do' };
  }
  const link = documentLink(deps.config, document.publicCode, brand.documentLinkPattern);
  if (link === null) {
    return { outcome: 'skipped', reason: 'nothing_to_do' };
  }

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

  if (document.source === 'uploaded') {
    const originalId = document.originalFileId ?? document.fileId;
    const original = await withTenant(tenantId, (tx) => tx.files.find(originalId ?? ''));
    // A missing file reads as `undefined`, which is not null: refused with a deleted one.
    if (original?.deletedAt !== null) {
      return { outcome: 'skipped', reason: 'source_missing' };
    }
    const bytes = await store.get(original.storageKey);
    if (bytes === undefined) {
      return { outcome: 'skipped', reason: 'source_missing' };
    }
    if (document.qrPlacement === null) {
      // The code was taken away: the PDF as uploaded is served again.
      const done = await withTenant(tenantId, async (tx) => {
        const replaced = await tx.documents.replaceFile(document.id, {
          fileId: original.id,
          byteSize: original.byteSize,
          pageCount: document.pageCount,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          qrPrinted: false,
          originalFileId: null,
        });
        await retire(tx, replaced?.previousFileId, original.id, document, deps.config);
        return replaced !== undefined;
      });
      return done
        ? { outcome: 'restored', fileId: original.id }
        : { outcome: 'skipped', reason: 'nothing_to_do' };
    }
    let stamped: { bytes: Uint8Array; pageCount: number };
    try {
      stamped = await stampQr(bytes, document.qrPlacement, link);
    } catch (error) {
      // A PDF pdf-lib cannot open (encrypted, damaged) keeps its file as it is.
      deps.logger.warn('Uploaded PDF could not be stamped', {
        documentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { outcome: 'skipped', reason: 'source_missing' };
    }
    const fileId = await storeReprint(store, tenantId, document, stamped.bytes);
    await withTenant(tenantId, async (tx) => {
      const replaced = await tx.documents.replaceFile(document.id, {
        fileId: fileId.id,
        byteSize: fileId.byteSize,
        pageCount: stamped.pageCount,
        sha256: fileId.sha256,
        qrPrinted: true,
        originalFileId: original.id,
      });
      if (replaced === undefined) {
        await tx.files.softDelete(fileId.id, document.createdBy, new Date());
        return;
      }
      await retire(tx, replaced.previousFileId, original.id, document, deps.config);
    });
    deps.logger.info('Uploaded PDF stamped with its share QR code', { documentId });
    return { outcome: 'reprinted', fileId: fileId.id };
  }

  // Made from a template: printed again from the very design and answers it was made with.
  const gathered = await withTenant(tenantId, async (tx) => {
    const { templateId, submissionId } = document;
    if (templateId === null || submissionId === null) {
      return undefined;
    }
    const [template, submission, kept] = await Promise.all([
      tx.documentTemplates.find(templateId),
      tx.submissions.findById(submissionId),
      tx.documents.printedDesign(document.id),
    ]);
    if (template === undefined || submission === undefined) {
      return undefined;
    }
    const parsed = parseDesign(kept ?? template.design);
    if (!parsed.ok) {
      return undefined;
    }
    const sources = await documentSources(tx, {
      submission,
      design: parsed.design,
      companyName: brand.name,
      documentDate: document.createdAt,
    });
    return { design: parsed.design, sources };
  });
  if (gathered === undefined) {
    return { outcome: 'skipped', reason: 'source_missing' };
  }
  const { pdf } = await printDesign(deps, {
    tenantId,
    design: gathered.design,
    form: gathered.sources.form,
    answers: gathered.sources.answers,
    locale: gathered.sources.locale,
    facts: gathered.sources.facts,
    fields: document.fields,
    qrUrl: link,
    qrBlank: true,
    today: gathered.sources.today,
    logoMediaId: brand.logoMediaId,
    brandColour: brand.brandColour,
    title: document.title,
  });
  const stored = await storeReprint(store, tenantId, document, pdf.bytes);
  await withTenant(tenantId, async (tx) => {
    const replaced = await tx.documents.replaceFile(document.id, {
      fileId: stored.id,
      byteSize: stored.byteSize,
      pageCount: pdf.pageCount,
      sha256: stored.sha256,
      qrPrinted: true,
    });
    if (replaced === undefined) {
      await tx.files.softDelete(stored.id, document.createdBy, new Date());
      return;
    }
    await retire(tx, replaced.previousFileId, null, document, deps.config);
  });
  deps.logger.info('Document re-printed with its share QR code', { documentId });
  return { outcome: 'reprinted', fileId: stored.id };
}

/** Stores a re-printed or stamped PDF, within the company's allowance. */
async function storeReprint(
  store: ObjectStore,
  tenantId: string,
  document: DocumentRecord,
  bytes: Uint8Array,
): Promise<{ id: string; byteSize: number; sha256: string }> {
  try {
    await assertUploadFits({
      plan: await planFor(tenantId),
      usage: await withTenant(tenantId, (tx) => tx.files.usage()),
      incomingBytes: bytes.byteLength,
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'storage_quota_exceeded') {
      throw new RenderFailed('storage_quota_exceeded', false, error.message);
    }
    throw error;
  }
  const id = randomUUID();
  const key = documentKey(id);
  let stored;
  try {
    stored = await store.put({ key, body: bytes, contentType: 'application/pdf' });
  } catch (error) {
    throw new RenderFailed(
      'storage_unavailable',
      true,
      error instanceof Error ? error.message : String(error),
    );
  }
  await withTenant(tenantId, (tx) =>
    tx.files.recordGenerated({
      id,
      bucket: store.bucket,
      storageKey: key,
      stored: { byteSize: stored.byteSize, etag: stored.etag, contentType: 'application/pdf' },
      category: 'document',
      uploadedBy: document.createdBy,
      linkedEntity: { type: DOCUMENT_FILE_ENTITY, id: document.id },
    }),
  );
  return {
    id,
    byteSize: stored.byteSize,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** The file a document stopped serving, unless it is the original kept beside it. */
async function retire(
  tx: TenantTransaction,
  previousFileId: string | null | undefined,
  keep: string | null,
  document: DocumentRecord,
  config: ApiConfig,
): Promise<void> {
  if (previousFileId == null || previousFileId === keep) {
    return;
  }
  await tx.files.softDelete(
    previousFileId,
    document.createdBy,
    new Date(Date.now() + config.MEDIA_RESTORE_DAYS * 24 * 60 * 60 * 1000),
  );
}
