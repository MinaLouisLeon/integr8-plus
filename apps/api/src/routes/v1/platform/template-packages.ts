import { FORM_TEMPLATE_CATEGORIES, getPlatformDataSource, type LibraryFile } from '@integr8/db';
import { replaceFileIds, type TemplateDesign } from '@integr8/document-render';
import { withRequiredSchemaVersion } from '@integr8/form-engine';
import { FORM_TEMPLATES } from '@integr8/form-engine/templates';
import {
  FORM_PACKAGE_LIMITS,
  FORM_PACKAGE_MEDIA_TYPE,
  FormPackageError,
  type PackageImageType,
  packFormPackage,
} from '@integr8/form-package';
import { z } from 'zod';
import { VERSION } from '../../../app-info.js';
import {
  checkBody,
  EXPORTING_APP,
  packageCheckSchema,
  packageHeaders,
  packageOrigin,
  packageOriginSchema,
  packageRefusal,
  problemDetails,
  readPictures,
  readUpload,
} from '../../../documents/form-packages.js';
import {
  discardPictures,
  getLibraryStore,
  libraryKey,
  renames,
  storePictures,
} from '../../../documents/template-copies.js';
import { conflict, notFound, unprocessable } from '../../../http/errors.js';
import { defineRoute, noSchema } from '../../../http/routes.js';
import { recordPlatformAction } from './audit.js';
import { libraryTemplateBody, libraryTemplateSchema } from './templates.js';

/**
 * The template library and `.integr8form` files (form builder decision 14,
 * 1.3.0), from the dashboard's Templates page: a file imported as a new
 * staff-made library template — how a catalogue moves from one Integr8 Plus
 * server to another — and any library template exported as a file.
 *
 * An imported template is stored exactly as "Save as library template" stores
 * one: the form, its PDF templates, and their pictures in the platform's
 * `platform-library` bucket under new ids. Unlike a company import, a library
 * template is published content that every company may start from, so a file
 * whose form would not publish, or whose templates would not save against it,
 * is refused with the problems listed.
 */

/** Keys the code ships, synced or not yet: never a staff-made template's. */
const BUILT_IN_KEYS = new Set(FORM_TEMPLATES.map((template) => template.key));

/**
 * A key from a title, as the staff app suggests one: lower-case letters,
 * digits and underscores, starting with a letter.
 */
export function keyFromTitle(title: Record<string, string>): string {
  const source = title.en ?? Object.values(title)[0] ?? '';
  const key = source
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .replace(/^[^a-z]+/u, '')
    .slice(0, 56)
    .replace(/_+$/u, '');
  return key === '' ? 'form_template' : key;
}

export const importTemplateRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/form-templates/import',
  operationId: 'importPlatformFormTemplate',
  summary: 'Import a .integr8form file into the template library',
  description: `The body is the file itself, sent as \`${FORM_PACKAGE_MEDIA_TYPE}\`, at most ${String(FORM_PACKAGE_LIMITS.fileBytes / 1024 / 1024)} MB. It becomes a new staff-made library template, offered to every company, with its PDF templates and their pictures copied into the platform's library storage — exactly what "Save as library template" makes. Its key comes from the English title (\`_2\`, \`_3\` … when taken); its name is the form's title, its description empty, its category \`category\` (maintenance unless given): all can be changed afterwards. A file the format refuses answers 422 with the package's code (\`package_invalid\`, \`package_too_new\`, …); one whose form would not publish, or whose PDF templates would not save against it, answers 422 \`form_package_not_publishable\` with each problem in \`details\`. Audited (\`form_template.imported\`).`,
  tags: ['platform'],
  security: 'platform',
  fileBody: FORM_PACKAGE_MEDIA_TYPE,
  bodyLimit: FORM_PACKAGE_LIMITS.fileBytes,
  params: noSchema,
  query: z.object({ category: z.enum(FORM_TEMPLATE_CATEGORIES).default('maintenance') }),
  body: noSchema,
  responses: {
    201: {
      description: 'The new library template, and what the check would like looked at.',
      schema: z.object({
        template: libraryTemplateSchema,
        source: packageOriginSchema,
        documentTemplatesCreated: z.number().int(),
        imagesCopied: z.number().int(),
        check: packageCheckSchema,
      }),
    },
    413: { description: 'The file is larger than the limit (`body_too_large`).' },
    422: { description: 'The file is not one this server reads, or its form would not publish.' },
  },
  handler: async ({ query }, context) => {
    const { unpacked, check } = readUpload(context.fileBody);
    if (!check.ok) {
      throw unprocessable(
        'form_package_not_publishable',
        'A library template must be a form that publishes; fix the problems listed in the form builder, export it again and import that file.',
        problemDetails(check.problems),
      );
    }
    const library = getPlatformDataSource().formTemplates;
    const by = context.platform.platformUserId;
    const title = Object.fromEntries(
      Object.entries(unpacked.manifest.form.title).filter(([, text]) => text.trim() !== ''),
    );

    const store = await getLibraryStore(context.services.media);
    const copies = await storePictures(store, unpacked.files, libraryKey);
    const names = renames(copies);
    const files: LibraryFile[] = copies.map((copy) => ({
      id: copy.id,
      bucket: copy.bucket,
      storageKey: copy.storageKey,
      contentType: copy.contentType,
      byteSize: copy.stored.byteSize,
      etag: copy.stored.etag,
    }));
    const content = {
      definition: withRequiredSchemaVersion(unpacked.form),
      sourceVersionNumber: null,
      documents: unpacked.templates.map((template) => ({
        name: template.name,
        design: replaceFileIds(template.design, names),
      })),
      files,
    };

    const base = keyFromTitle(title);
    let key: string | undefined;
    try {
      for (let attempt = 1; attempt <= 100 && key === undefined; attempt += 1) {
        const candidate = attempt === 1 ? base : `${base}_${String(attempt)}`;
        if (BUILT_IN_KEYS.has(candidate)) {
          continue;
        }
        const created = await library.createStaff({
          key: candidate,
          title,
          description: {},
          category: query.category,
          origin: null,
          content,
          by,
        });
        if (created) {
          key = candidate;
        }
      }
      if (key === undefined) {
        throw conflict('form_template_key_taken', 'Every key this title suggests is taken.');
      }
    } catch (error) {
      await discardPictures(store, copies);
      throw error;
    }

    const origin = packageOrigin(unpacked);
    await recordPlatformAction(context, {
      action: 'form_template.imported',
      targetKind: 'form_template',
      targetId: key,
      metadata: {
        sourceApp: origin.app,
        sourceVersion: origin.version,
        exportedFrom: origin.exportedFrom,
        documentTemplates: content.documents.length,
        pictures: copies.length,
        warnings: check.warnings.length,
      },
    });

    const saved = await library.find(key);
    if (saved === undefined) {
      throw notFound(`No form template "${key}"`);
    }
    return {
      status: 201,
      body: {
        template: await libraryTemplateBody(saved),
        source: origin,
        documentTemplatesCreated: content.documents.length,
        imagesCopied: copies.length,
        check: checkBody(check),
      },
    };
  },
});

export const exportTemplateRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/form-templates/:key/export',
  operationId: 'exportPlatformFormTemplate',
  summary: 'Export a library template as a .integr8form file',
  description:
    'Any template, built-in or staff-made, retired or not: its form, and a staff-made one’s PDF templates with their pictures, in the file a company form exports to. Settings are the defaults (a library template has none of its own). Audited (`form_template.exported`).',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ key: z.string().min(1).max(100) }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The `.integr8form` file, as an attachment named after the template.',
      schema: z.string(),
      contentType: FORM_PACKAGE_MEDIA_TYPE,
    },
    404: { description: 'No such template.' },
    409: { description: 'A picture is gone from storage (`document_template_image_missing`).' },
  },
  handler: async ({ params }, context) => {
    const library = getPlatformDataSource().formTemplates;
    const template = await library.find(params.key);
    if (template === undefined) {
      throw notFound(`No form template "${params.key}"`);
    }
    const documents = await library.documents(template.key);
    const stored = documents.length === 0 ? [] : await library.files(template.key);
    const pictures =
      stored.length === 0
        ? []
        : await readPictures(
            await getLibraryStore(context.services.media),
            stored.map((file) => ({
              id: file.id,
              storageKey: file.storageKey,
              contentType: file.contentType,
              byteSize: file.byteSize,
            })),
          );
    let bytes: Uint8Array;
    try {
      bytes = packFormPackage({
        createdBy: { app: EXPORTING_APP, version: VERSION },
        definition: template.definition,
        source: 'published',
        versionNumber: template.origin?.versionNumber ?? null,
        templates: documents.map((document) => ({
          name: document.name,
          design: document.design as unknown as TemplateDesign,
        })),
        files: pictures.map((file) => ({
          ...file,
          contentType: file.contentType as PackageImageType,
        })),
      });
    } catch (error) {
      if (error instanceof FormPackageError) {
        throw packageRefusal(error, 409);
      }
      throw error;
    }
    await recordPlatformAction(context, {
      action: 'form_template.exported',
      targetKind: 'form_template',
      targetId: template.key,
      metadata: { documentTemplates: documents.length, pictures: pictures.length },
    });
    const name = template.title.en ?? Object.values(template.title)[0] ?? template.key;
    return { status: 200, body: Buffer.from(bytes), headers: packageHeaders(name) };
  },
});

export const platformTemplatePackageRoutes = [importTemplateRoute, exportTemplateRoute];
