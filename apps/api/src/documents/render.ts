import { createHash, randomUUID } from 'node:crypto';
import {
  DOCUMENT_FILE_ENTITY,
  type FileRecord,
  getPlatformDataSource,
  withTenant,
} from '@integr8/db';
import {
  allBlocks,
  designFileIds,
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

/** The link a document's QR code opens (D7). */
export function documentLink(config: ApiConfig, publicCode: string): string | null {
  return config.WEB_APP_URL === undefined
    ? null
    : `${config.WEB_APP_URL.replace(/\/+$/u, '')}/d/${publicCode}`;
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
class NotPending extends Error {}

async function render(
  deps: RenderDeps,
  job: {
    tenantId: string;
    documentId: string;
    design?: unknown;
    companyName: string;
    logoMediaId: string | null;
    brandColour: string | null;
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

  // 2 and 3. Pictures from the company's bucket, printed, backgrounds laid underneath.
  const { pdf, store } = await printDesign(deps, {
    tenantId,
    design,
    form: sources.form,
    answers: sources.answers,
    locale: sources.locale,
    facts: sources.facts,
    fields: document.fields,
    qrUrl: documentLink(deps.config, document.publicCode),
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
    });
    if (!ready) {
      // Deleted or settled while printing: the file goes the way of any
      // deleted file, through the restore window to the purge.
      await tx.files.softDelete(fileId, document.createdBy, new Date());
    }
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
function printable(file: FileRecord): boolean {
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
