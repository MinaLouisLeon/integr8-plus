import { randomUUID } from 'node:crypto';
import { withTenant } from '@integr8/db';
import {
  automaticMapping,
  checkDesignAgainstForm,
  designReferences,
  matchDesignReferences,
  parseDesign,
  referenceCandidates,
  referencedFileIds,
  replaceFileIds,
  rewriteDesignReferences,
  type TemplateDesign,
  unresolvedReferences,
} from '@integr8/document-render';
import { z } from 'zod';
import {
  assertPicturesFit,
  companyPictures,
  companyStore,
  copyPictures,
  discardPictures,
  recordCompanyPictures,
  renames,
} from '../../documents/template-copies.js';
import { conflict, type ErrorDetail, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { mediaKey } from '../../media/storage.js';
import { designRefused, templateBodies, templateSchema } from './documents.js';
import { compiledVersion } from './submissions.js';

/**
 * Copying a PDF template (form builder decision 10, 1.3.0): a duplicate beside
 * it, or a copy for another form of the same company.
 *
 * Copying to another form needs every question the template names found in
 * that form. The designer matches them first (`@integr8/document-render`'s
 * `matchDesignReferences`: the same answer key where its question fits, then
 * the same wording) and asks a person about the rest; it sends what they chose
 * as `answerMap`. The server matches again the same way, takes the person's
 * choices over its own, and refuses while anything is still undecided — so
 * nothing is saved until every reference is resolved. A duplicate is the same
 * route with the same form: everything matches itself.
 *
 * The copy's pictures are copies too, in the same bucket under new ids, tied
 * to the new template: the ledger ties a file to one template.
 */

const TAGS = ['documents'];

export const copyDocumentTemplateRoute = defineRoute({
  method: 'post',
  path: '/v1/document-templates/:templateId/copy',
  operationId: 'copyDocumentTemplate',
  summary: 'Duplicate a PDF template, or copy it to another form',
  description:
    'Staff only (`document.design`). Without `formId` (or with the template’s own form) this is a duplicate. With another form of the company, every question the template names must be found in that form’s last published version: the same answer key where the question fits, then the same wording in English or Arabic, then `answerMap` — the target’s answer key for each reference, or `null` to take out what used it (a block, or a row or column of a table). Anything still undecided answers 422 `document_template_unmatched`, one detail per reference with the questions that could stand in, and nothing is saved. Pictures are copied under new ids (409 `storage_quota_exceeded` past a blocking allowance). Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'document.design',
  feature: 'documents',
  idempotent: true,
  params: z.object({ templateId: z.uuid() }),
  query: noSchema,
  body: z.object({
    formId: z.uuid().optional(),
    name: z.string().trim().min(1).max(120),
    answerMap: z.record(z.string().max(64), z.string().max(64).nullable()).optional(),
  }),
  responses: {
    201: { description: 'The copy.', schema: templateSchema },
    404: { description: 'No such template or form.' },
    409: {
      description:
        'The target form was never published (`form_not_published`), a picture is gone (`document_template_image_missing`), or the company is out of storage (`storage_quota_exceeded`).',
    },
    422: {
      description:
        'A question is not matched (`document_template_unmatched`), a choice in `answerMap` does not fit (`document_template_mapping_invalid`), or the result does not fit the form (`document_template_invalid`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const { tenantId, userId } = context.principal;

    const prepared = await withTenant(tenantId, async (tx) => {
      const template = await tx.documentTemplates.find(params.templateId);
      if (template === undefined) {
        throw notFound('This template does not exist.');
      }
      const formId = body.formId ?? template.formId;
      const form = await tx.forms.findForm(formId);
      if (form === undefined) {
        throw notFound('This form does not exist.');
      }
      const targetVersion = await tx.forms.findLatestPublished(form.id);
      if (targetVersion === undefined) {
        throw conflict(
          'form_not_published',
          'This form has no published version yet; publish it before giving it PDF templates.',
        );
      }
      const sourceVersion =
        form.id === template.formId
          ? targetVersion
          : await tx.forms.findLatestPublished(template.formId);
      const target = compiledVersion(targetVersion);
      const source = sourceVersion === undefined ? null : compiledVersion(sourceVersion);
      const parsed = parseDesign(template.design);
      if (!parsed.ok) {
        designRefused(parsed.issues);
      }

      const matches = matchDesignReferences(parsed.design, source, target);
      const chosen = body.answerMap ?? {};
      const mapping: Record<string, string | null> = { ...automaticMapping(matches), ...chosen };

      const references = designReferences(parsed.design);
      const known = new Map(references.map((reference) => [reference.id, reference]));
      const invalid: ErrorDetail[] = [];
      for (const [id, choice] of Object.entries(chosen)) {
        const reference = known.get(id);
        if (reference === undefined) {
          invalid.push({
            field: `body.answerMap.${id}`,
            code: 'document_template_mapping_invalid',
            message: `The template does not name "${id}".`,
          });
          continue;
        }
        if (choice === null) {
          continue;
        }
        const candidates = referenceCandidates(
          reference,
          source,
          target,
          reference.section === undefined ? undefined : (mapping[reference.section] ?? null),
        );
        if (!candidates.includes(choice)) {
          invalid.push({
            field: `body.answerMap.${id}`,
            code: 'document_template_mapping_invalid',
            message: `"${choice}" cannot stand in for "${id}".`,
            params: { candidates: candidates.join(',') },
          });
        }
      }
      if (invalid.length > 0) {
        throw unprocessable(
          'document_template_mapping_invalid',
          'A question chosen for the copy cannot take the place it was chosen for.',
          invalid,
        );
      }

      const unresolved = unresolvedReferences(references, mapping);
      if (unresolved.length > 0) {
        throw unprocessable(
          'document_template_unmatched',
          'Some questions the template uses are not in the other form. Choose a question for each, or take out what uses it.',
          unresolved.map((reference) => ({
            field: `body.answerMap.${reference.id}`,
            code: 'document_template_unmatched',
            message: reference.id,
            params: {
              kind: reference.kind,
              candidates: referenceCandidates(
                reference,
                source,
                target,
                reference.section === undefined ? undefined : (mapping[reference.section] ?? null),
              ).join(','),
            },
          })),
        );
      }

      const rewritten = parseDesign(rewriteDesignReferences(parsed.design, mapping));
      if (!rewritten.ok) {
        designRefused(rewritten.issues);
      }
      const issues = checkDesignAgainstForm(rewritten.design, target);
      if (issues.length > 0) {
        designRefused(issues);
      }
      const removed = Object.entries(mapping)
        .filter(([, value]) => value === null)
        .map(([id]) => id);
      const renamed = Object.fromEntries(
        Object.entries(mapping).filter(([id, value]) => value !== null && value !== id),
      );
      return {
        template,
        formId: form.id,
        design: rewritten.design,
        pictures: await companyPictures(tx, [rewritten.design]),
        removed,
        renamed,
      };
    });

    await assertPicturesFit(tenantId, prepared.pictures);
    const store =
      prepared.pictures.length === 0 ? null : await companyStore(context.services.media, tenantId);
    const copies =
      store === null ? [] : await copyPictures(store, store, prepared.pictures, mediaKey);

    try {
      const created = await withTenant(tenantId, async (tx) => {
        const id = randomUUID();
        const design: TemplateDesign = replaceFileIds(prepared.design, renames(copies));
        const saved = await tx.documentTemplates.create({
          id,
          formId: prepared.formId,
          name: body.name,
          design,
          by: userId,
        });
        await recordCompanyPictures(tx, copies, () => id, userId);
        await tx.auditLog.append({
          actorKind: 'tenant_user',
          actorId: userId,
          actorLabel: userId,
          action: 'document_template.copied',
          resourceType: 'document_template',
          resourceId: id,
          requestId: context.requestId,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          metadata: {
            fromTemplateId: prepared.template.id,
            fromFormId: prepared.template.formId,
            formId: prepared.formId,
            name: body.name,
            pictures: copies.length,
            renamed: prepared.renamed,
            removed: prepared.removed,
            ...(context.principal.impersonatedBy === undefined
              ? {}
              : { impersonatedBy: context.principal.impersonatedBy }),
          },
        });
        // The copy names exactly the pictures that were copied for it.
        if (
          referencedFileIds(design).some((fileId) => !copies.some((copy) => copy.id === fileId))
        ) {
          throw conflict(
            'document_template_image_missing',
            'A picture this template uses is no longer in storage; upload it again before copying.',
          );
        }
        // Shown like any other template, checked against its form, so a copy of a
        // template that already needed attention says so.
        const [shown] = await templateBodies(tx, [saved]);
        return shown!;
      });
      return { status: 201, body: created };
    } catch (error) {
      if (store !== null) {
        await discardPictures(store, copies);
      }
      throw error;
    }
  },
});

export const documentTemplateCopyRoutes = [copyDocumentTemplateRoute];
