import { ApiRequestError } from '@integr8/api-client';
import {
  documentFont,
  type DocumentFontKey,
  renderDocumentHtml,
  resolveDocumentFields,
  type ResolvedField,
  sampleAnswers,
  type TemplateDesign,
  designUsesLogo,
} from '@integr8/document-render';
import { type CompiledForm, mediaReferences } from '@integr8/form-engine';
import { apiErrorMessage, useTranslation } from '@integr8/i18n';
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Button } from '~/components/ui';
import { session } from '~/lib/session';
import { SelectInput } from './designer-inputs';
import { PdfViewer } from './pdf-viewer';

/**
 * The designer's preview: the live page, redrawn as the design changes, and
 * "Preview as PDF" (1.3.0 decision 12), the server printing the design as it
 * stands — saved or not — exactly as a document would be, without keeping it.
 *
 * Both fill the template with a recent submission of the form, or with
 * made-up answers to every question.
 */

const client = () => session().client;

/** A file in the company's bucket as a data link, for the preview to draw without a network. */
async function imageData(fileId: string): Promise<string | null> {
  const { data } = await client().GET('/v1/media/{mediaId}', {
    params: { path: { mediaId: fileId } },
  });
  if (data === undefined) {
    return null;
  }
  const response = await fetch(data.url);
  if (!response.ok) {
    return null;
  }
  const blob = await response.blob();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/**
 * The `@font-face` rules the app itself loaded for a font (`@integr8/tokens`'
 * fonts), for the preview page: its frame shares the app's origin, so the
 * same files serve it and nothing is fetched from elsewhere.
 */
function appFontFaces(key: DocumentFontKey): string {
  const families = new Set(documentFont(key).faces.map((face) => face.family));
  if (families.size === 0 || typeof document === 'undefined') {
    return '';
  }
  const rules: string[] = [];
  const visit = (list: CSSRuleList) => {
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSFontFaceRule) {
        const family = rule.style.getPropertyValue('font-family').replace(/["']/gu, '').trim();
        if (families.has(family)) {
          rules.push(rule.cssText);
        }
      } else if (rule instanceof CSSImportRule && rule.styleSheet !== null) {
        visit(rule.styleSheet.cssRules);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      // A sheet from another origin cannot be read; the fonts are not in one.
    }
  }
  return rules.join('\n');
}

const SAMPLE = 'sample';
const NONE = 'none';

export function Preview({
  templateId,
  design,
  form,
  formId,
  formTitle,
  locale,
  companyName,
  companyBrandColour,
  logoMediaId,
}: {
  templateId: string;
  design: TemplateDesign;
  form: CompiledForm;
  formId: string;
  formTitle: string;
  locale: string;
  companyName: string;
  companyBrandColour: string | null;
  logoMediaId: string | null;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState<string>(SAMPLE);
  const [mode, setMode] = useState<'live' | 'pdf'>('live');
  const submissionId = source === SAMPLE || source === NONE ? '' : source;

  const recent = useQuery({
    queryKey: ['documents', 'designer', 'submissions', formId],
    queryFn: async () =>
      (
        await client().GET('/v1/submissions', {
          params: { query: { formId, status: 'submitted', limit: 10 } },
        })
      ).data!,
  });
  const chosen = useQuery({
    queryKey: ['documents', 'designer', 'submission', submissionId],
    enabled: submissionId !== '',
    queryFn: async () =>
      (
        await client().GET('/v1/submissions/{submissionId}', {
          params: { path: { submissionId } },
        })
      ).data!,
  });
  const language = design.page.language ?? (locale.startsWith('ar') ? 'ar' : 'en');
  const today = new Date().toISOString().slice(0, 10);
  const answers = useMemo(
    () =>
      source === SAMPLE
        ? sampleAnswers(form, language, today)
        : submissionId === ''
          ? {}
          : (chosen.data?.submission.answers ?? {}),
    [source, form, language, today, submissionId, chosen.data],
  );

  // Every picture the preview may draw: the template's own, the logo, and the answer's photos.
  const wantsLogo = designUsesLogo(design) && logoMediaId !== null;
  const fileIds = useMemo(() => {
    const ids = new Set<string>();
    if (design.page.background !== null) {
      ids.add(design.page.background.fileId);
    }
    if (design.page.firstPage?.background != null) {
      ids.add(design.page.firstPage.background.fileId);
    }
    for (const block of design.blocks) {
      const inner =
        block.type === 'row' ? block.columns.flatMap((column) => column.blocks) : [block];
      for (const candidate of inner) {
        if (
          candidate.type === 'image' &&
          candidate.source.kind === 'file' &&
          candidate.source.fileId !== ''
        ) {
          ids.add(candidate.source.fileId);
        }
      }
    }
    for (const reference of mediaReferences(form.definition, answers).slice(0, 20)) {
      if (reference.media.contentType.startsWith('image/')) {
        ids.add(reference.media.mediaId);
      }
    }
    if (wantsLogo) {
      ids.add(logoMediaId);
    }
    return [...ids];
  }, [design, form, answers, wantsLogo, logoMediaId]);
  const pictures = useQueries({
    queries: fileIds.map((fileId) => ({
      queryKey: ['documents', 'designer', 'image', fileId],
      queryFn: () => imageData(fileId),
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
  const images = useMemo(() => {
    const files: Record<string, string> = {};
    fileIds.forEach((fileId, index) => {
      const data = pictures[index]?.data;
      if (typeof data === 'string') {
        files[fileId] = data;
      }
    });
    return {
      logo: logoMediaId === null ? null : (files[logoMediaId] ?? null),
      files,
      media: files,
    };
  }, [fileIds, pictures, logoMediaId]);
  const fontFaceCss = useMemo(() => appFontFaces(design.style.font), [design.style.font]);

  const html = useMemo(() => {
    const facts = {
      companyName,
      formTitle,
      submittedAt:
        chosen.data?.submission.submittedAt ??
        (source === SAMPLE ? new Date().toISOString() : null),
      submittedBy: chosen.data?.submission.submittedBy.name ?? null,
      workOrderReference: chosen.data?.submission.workOrder?.referenceLabel ?? null,
      assetReference: chosen.data?.asset?.reference ?? null,
      documentDate: new Date().toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    // Typed fields show their label, in brackets, where the person's words will go.
    const typed = Object.fromEntries(
      design.fields
        .filter((field) => field.source.kind === 'typed')
        .map((field) => [
          field.key,
          `[${field.label[language] ?? field.label.en ?? field.key}]`.slice(
            0,
            field.source.kind === 'typed' ? field.source.maxLength : 100,
          ),
        ]),
    );
    const resolved = resolveDocumentFields({
      design,
      form,
      answers,
      typed,
      facts,
      locale: language,
    });
    const fields: ResolvedField[] = resolved.ok ? resolved.fields : [];
    try {
      return renderDocumentHtml({
        design,
        form,
        answers,
        locale: language,
        facts,
        fields,
        qrUrl: null,
        images,
        mode: 'preview',
        companyBrandColour,
        fontFaceCss,
      }).html;
    } catch {
      return '';
    }
  }, [
    design,
    form,
    answers,
    language,
    images,
    companyName,
    formTitle,
    chosen.data,
    source,
    companyBrandColour,
    fontFaceCss,
  ]);

  const printed = useMutation({
    mutationFn: async () => {
      const { data } = await client().POST('/v1/document-templates/{templateId}/preview', {
        params: { path: { templateId } },
        body: {
          design: design,
          ...(submissionId === '' ? {} : { submissionId }),
        },
      });
      const binary = atob(data!.base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    },
  });

  return (
    <section
      className="flex min-w-0 flex-1 flex-col gap-2"
      aria-label={t('documents.designer.preview')}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex gap-1" role="tablist">
          {(['live', 'pdf'] as const).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={mode === name}
              onClick={() => setMode(name)}
              className={[
                'border-b-2 px-3 py-1.5 text-sm',
                mode === name
                  ? 'border-accent font-medium text-content'
                  : 'border-transparent text-content-muted hover:text-content',
              ].join(' ')}
            >
              {t(`documents.pdfBuilder.preview.${name}`)}
            </button>
          ))}
        </div>
        <div className="min-w-56">
          <SelectInput
            label={t('documents.designer.previewWith')}
            value={source}
            options={[
              { value: SAMPLE, label: t('documents.pdfBuilder.preview.sample') },
              { value: NONE, label: t('documents.designer.previewEmpty') },
              ...(recent.data?.items ?? []).map((item) => ({
                value: item.id,
                label: `${item.submittedBy.name} · ${item.submittedAt ?? item.createdAt}`,
              })),
            ]}
            onChange={setSource}
          />
        </div>
        {mode === 'pdf' ? (
          <Button busy={printed.isPending} onClick={() => printed.mutate()}>
            {printed.data === undefined
              ? t('documents.pdfBuilder.preview.print')
              : t('documents.pdfBuilder.preview.printAgain')}
          </Button>
        ) : null}
      </div>
      {mode === 'live' ? (
        <>
          <p className="text-xs text-content-muted">{t('documents.designer.previewHint')}</p>
          {/*
            No scripts run in the frame; it shares the app's origin only so the
            page can use the fonts the app already serves. Every text in the
            page was escaped by the renderer.
          */}
          <iframe
            title={t('documents.designer.preview')}
            sandbox="allow-same-origin"
            srcDoc={html}
            className="min-h-[70vh] w-full flex-1 rounded-md border border-border-subtle bg-surface-muted"
          />
        </>
      ) : (
        <>
          <p className="text-xs text-content-muted">{t('documents.pdfBuilder.preview.pdfHint')}</p>
          {printed.isError ? (
            <p
              role="alert"
              className="rounded-md border border-danger bg-danger-subtle p-3 text-sm"
            >
              {printed.error instanceof ApiRequestError
                ? apiErrorMessage(printed.error, t)
                : t('documents.pdfBuilder.preview.cannotShow')}
            </p>
          ) : null}
          {printed.data === undefined ? (
            <p className="rounded-md border border-dashed border-border-subtle p-6 text-center text-sm text-content-muted">
              {t('documents.pdfBuilder.preview.notYet')}
            </p>
          ) : (
            <PdfViewer bytes={printed.data} title={t('documents.pdfBuilder.preview.pdf')} />
          )}
        </>
      )}
    </section>
  );
}
