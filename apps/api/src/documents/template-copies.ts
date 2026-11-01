import { randomUUID } from 'node:crypto';
import {
  type FileRecord,
  getPlatformDataSource,
  type LibraryContent,
  type LibraryFile,
  TEMPLATE_ASSET_ENTITY,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import { referencedFileIds, replaceFileIds, type TemplateDesign } from '@integr8/document-render';
import { ApiError, conflict } from '../http/errors.js';
import { planFor } from '../http/suspension.js';
import { assertUploadFits } from '../media/quota.js';
import {
  categoryOf,
  mediaKey,
  type MediaStorage,
  type ObjectStore,
  type StoredObject,
} from '../media/storage.js';
import { getStorage, StorageNotReadyError } from '../media/tenant-storage.js';

/**
 * Copying PDF templates and the pictures they use (form builder decisions 1
 * and 10, 1.3.0): within a company, to another company, into the library and
 * out of it again.
 *
 * A picture belongs to exactly one template (documents ADR-0001 D5): the
 * media ledger ties it to that template, retention leaves it alone because of
 * that, and only people who may see the template may read it. So a copied
 * template never shares a picture with its original: every picture is copied
 * too, under a new id, into the bucket of whoever now owns it — a company's own
 * bucket, counted in its storage and checked against its allowance, or the
 * platform's `platform-library` bucket for a library template, which belongs to
 * no company and which no company pays for.
 */

/** The platform's own bucket for the library's pictures, beside `platform-exports`. */
export const LIBRARY_BUCKET_KEY = 'platform-library';

/** Where a library picture lives in that bucket. */
export const libraryKey = (fileId: string) => `library/${fileId}`;

export async function getLibraryStore(media: MediaStorage): Promise<ObjectStore> {
  const bucket = media.bucketFor(LIBRARY_BUCKET_KEY);
  // Idempotent, and library changes are rare enough that repairing the
  // bucket's settings on the way past costs nothing worth saving.
  await media.provision(bucket);
  return media.open(bucket);
}

/** A picture to copy: where it is now. */
export interface PictureSource {
  id: string;
  storageKey: string;
  contentType: string;
  byteSize: number;
}

/** A picture copied: its new id and what storage reported for it. */
export interface PictureCopy {
  from: string;
  id: string;
  bucket: string;
  storageKey: string;
  contentType: string;
  stored: StoredObject;
}

/**
 * Copies pictures from one bucket into another under new ids. If any one
 * fails, whatever this call already wrote is removed again, so a failed copy
 * leaves no object without a record.
 */
export async function copyPictures(
  from: ObjectStore,
  to: ObjectStore,
  pictures: readonly PictureSource[],
  keyFor: (fileId: string) => string,
): Promise<PictureCopy[]> {
  const copies: PictureCopy[] = [];
  try {
    for (const picture of pictures) {
      const body = await from.get(picture.storageKey);
      if (body === undefined) {
        throw conflict(
          'document_template_image_missing',
          'A picture this template uses is no longer in storage; upload it again before copying.',
        );
      }
      const id = randomUUID();
      const storageKey = keyFor(id);
      const stored = await to.put({ key: storageKey, body, contentType: picture.contentType });
      copies.push({
        from: picture.id,
        id,
        bucket: to.bucket,
        storageKey,
        contentType: picture.contentType,
        stored,
      });
    }
  } catch (error) {
    await discardPictures(to, copies);
    throw error;
  }
  return copies;
}

/**
 * Writes pictures that arrived as bytes (an imported `.integr8form` file,
 * 1.3.0) into a bucket under new ids, as {@link copyPictures} does for
 * pictures already stored: `from` is the id the file's designs use. If any one
 * fails, whatever this call already wrote is removed again.
 */
export async function storePictures(
  to: ObjectStore,
  pictures: readonly { id: string; contentType: string; bytes: Uint8Array }[],
  keyFor: (fileId: string) => string,
): Promise<PictureCopy[]> {
  const copies: PictureCopy[] = [];
  try {
    for (const picture of pictures) {
      const id = randomUUID();
      const storageKey = keyFor(id);
      const stored = await to.put({
        key: storageKey,
        body: picture.bytes,
        contentType: picture.contentType,
      });
      copies.push({
        from: picture.id,
        id,
        bucket: to.bucket,
        storageKey,
        contentType: picture.contentType,
        stored,
      });
    }
  } catch (error) {
    await discardPictures(to, copies);
    throw error;
  }
  return copies;
}

/** Removes copies whose records were never written. Best effort: the sweep finds the rest. */
export async function discardPictures(
  store: ObjectStore,
  copies: readonly PictureCopy[],
): Promise<void> {
  if (copies.length === 0) {
    return;
  }
  await store.delete(copies.map((copy) => copy.storageKey)).catch(() => undefined);
}

/** Old id → new id, for {@link replaceFileIds}. */
export function renames(copies: readonly PictureCopy[]): Map<string, string> {
  return new Map(copies.map((copy) => [copy.from, copy.id]));
}

/** A company's bucket, as a 503 the client understands when it is not there yet. */
export async function companyStore(media: MediaStorage, tenantId: string): Promise<ObjectStore> {
  try {
    return await getStorage(media, tenantId);
  } catch (error) {
    if (error instanceof StorageNotReadyError) {
      throw new ApiError(
        503,
        'storage_not_ready',
        "This company's file storage is not available yet. Try again in a few minutes.",
      );
    }
    throw error;
  }
}

/** Refuses a copy that would take a company past a plan that blocks. */
export async function assertPicturesFit(
  tenantId: string,
  pictures: readonly { byteSize: number }[],
): Promise<void> {
  const bytes = pictures.reduce((sum, picture) => sum + picture.byteSize, 0);
  if (bytes === 0) {
    return;
  }
  await assertUploadFits({
    plan: await planFor(tenantId),
    usage: await withTenant(tenantId, (tx) => tx.files.usage()),
    incomingBytes: bytes,
  });
}

/**
 * The pictures a company's designs use, as stored. A picture deleted or gone
 * from the ledger cannot be copied, and the copy is refused rather than made
 * with a hole in it.
 */
export async function companyPictures(
  tx: TenantTransaction,
  designs: readonly TemplateDesign[],
): Promise<PictureSource[]> {
  const ids = [...new Set(designs.flatMap((design) => referencedFileIds(design)))];
  const files = new Map((await tx.files.findMany(ids)).map((file) => [file.id, file]));
  return ids.map((id) => {
    const file: FileRecord | undefined = files.get(id);
    if (file?.deletedAt !== null || file.purgedAt !== null) {
      throw conflict(
        'document_template_image_missing',
        'A picture this template uses is no longer in storage; upload it again before copying.',
      );
    }
    return {
      id: file.id,
      storageKey: file.storageKey,
      contentType: file.contentType,
      byteSize: file.byteSize,
    };
  });
}

/**
 * Records copied pictures in a company's ledger, each tied to the template
 * that now uses it — what retention and access read (0068).
 */
export async function recordCompanyPictures(
  tx: TenantTransaction,
  copies: readonly PictureCopy[],
  templateFor: (copy: PictureCopy) => string,
  by: string,
): Promise<void> {
  for (const copy of copies) {
    await tx.files.recordGenerated({
      id: copy.id,
      bucket: copy.bucket,
      storageKey: copy.storageKey,
      stored: copy.stored,
      category: categoryOf(copy.contentType),
      uploadedBy: by,
      linkedEntity: { type: TEMPLATE_ASSET_ENTITY, id: templateFor(copy) },
    });
  }
}

/** One PDF template on its way into a company. */
export interface IncomingTemplate {
  name: string;
  design: TemplateDesign;
}

/**
 * Copies pictures into a company's bucket and records each template there,
 * with its pictures renamed and tied to it. The caller has checked the
 * company's allowance. Returns how many templates and pictures arrived.
 */
export async function bringTemplatesIn(input: {
  tx: TenantTransaction;
  formId: string;
  templates: readonly IncomingTemplate[];
  copies: readonly PictureCopy[];
  by: string;
}): Promise<{ templateIds: string[]; pictures: number }> {
  const names = renames(input.copies);
  const owner = new Map<string, string>();
  const templateIds: string[] = [];
  for (const template of input.templates) {
    const id = randomUUID();
    const design = replaceFileIds(template.design, names);
    for (const fileId of referencedFileIds(design)) {
      if (!owner.has(fileId)) {
        owner.set(fileId, id);
      }
    }
    await input.tx.documentTemplates.create({
      id,
      formId: input.formId,
      name: template.name,
      design,
      by: input.by,
    });
    templateIds.push(id);
  }
  // A picture two of these designs share is tied to the first that uses it;
  // the ledger ties a file to one record.
  await recordCompanyPictures(
    input.tx,
    input.copies.filter((copy) => owner.has(copy.id)),
    (copy) => owner.get(copy.id) ?? '',
    input.by,
  );
  return { templateIds, pictures: input.copies.length };
}

/**
 * A company form's last published version and its PDF templates, made into
 * library content: the pictures copied into the library's bucket under new
 * ids. On any failure after the copy the caller discards `copies`.
 */
export async function libraryContentFromForm(input: {
  media: MediaStorage;
  tenantId: string;
  formId: string;
  includeDocumentTemplates: boolean;
}): Promise<{ content: LibraryContent; copies: PictureCopy[]; library: ObjectStore }> {
  const read = await withTenant(input.tenantId, async (tx) => {
    const form = await tx.forms.findForm(input.formId);
    if (form === undefined) {
      return undefined;
    }
    const version = await tx.forms.findLatestPublished(form.id);
    if (version === undefined) {
      throw conflict(
        'form_not_published',
        'This form has no published version yet; publish it before saving it to the library.',
      );
    }
    const templates = input.includeDocumentTemplates
      ? await tx.documentTemplates.list({ formId: form.id })
      : [];
    const designs = templates.map((template) => template.design as TemplateDesign);
    return {
      version,
      templates,
      pictures: await companyPictures(tx, designs),
    };
  });
  if (read === undefined) {
    throw new ApiError(404, 'not_found', 'This form does not exist.');
  }

  const library = await getLibraryStore(input.media);
  const copies =
    read.pictures.length === 0
      ? []
      : await copyPictures(
          await companyStore(input.media, input.tenantId),
          library,
          read.pictures,
          libraryKey,
        );
  const names = renames(copies);
  const files: LibraryFile[] = copies.map((copy) => ({
    id: copy.id,
    bucket: copy.bucket,
    storageKey: copy.storageKey,
    contentType: copy.contentType,
    byteSize: copy.stored.byteSize,
    etag: copy.stored.etag,
  }));
  return {
    content: {
      definition: read.version.definition,
      sourceVersionNumber: read.version.versionNumber ?? 1,
      documents: read.templates.map((template) => ({
        name: template.name,
        design: replaceFileIds(template.design as TemplateDesign, names),
      })),
      files,
    },
    copies,
    library,
  };
}

/**
 * A library template's PDF templates, ready to bring into a company: the
 * designs, and the pictures copied into the company's bucket. Checks the
 * company's allowance first. Empty for a template that carries none.
 */
export async function libraryTemplatesFor(input: {
  media: MediaStorage;
  tenantId: string;
  templateKey: string;
}): Promise<{ templates: IncomingTemplate[]; copies: PictureCopy[]; store: ObjectStore | null }> {
  const library = getPlatformDataSource().formTemplates;
  const documents = await library.documents(input.templateKey);
  if (documents.length === 0) {
    return { templates: [], copies: [], store: null };
  }
  const files = await library.files(input.templateKey);
  const used = new Set(
    documents.flatMap((document) =>
      referencedFileIds(document.design as unknown as TemplateDesign),
    ),
  );
  const pictures = files
    .filter((file) => used.has(file.id))
    .map((file) => ({
      id: file.id,
      storageKey: file.storageKey,
      contentType: file.contentType,
      byteSize: file.byteSize,
    }));
  await assertPicturesFit(input.tenantId, pictures);
  const store = await companyStore(input.media, input.tenantId);
  const copies =
    pictures.length === 0
      ? []
      : await copyPictures(await getLibraryStore(input.media), store, pictures, mediaKey);
  return {
    templates: documents.map((document) => ({
      name: document.name,
      design: document.design as unknown as TemplateDesign,
    })),
    copies,
    store,
  };
}
