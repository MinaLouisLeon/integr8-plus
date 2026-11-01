import { ApiRequestError } from '@integr8/api-client';
import {
  type DocumentField,
  emptyDesign,
  parseDesign,
  renderDocumentHtml,
  resolveDocumentFields,
  type ResolvedField,
  type TemplateDesign,
} from '@integr8/document-render';
import { type CompiledForm, mediaReferences } from '@integr8/form-engine';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Button, EmptyState, ErrorState, Field, LoadingState } from '~/components/ui';
import { session } from '~/lib/session';
import { BlockList } from './block-editor';
import {
  CheckInput,
  ImageUpload,
  LocalizedInputs,
  NumberInput,
  QuestionInput,
  SelectInput,
  TextInput,
} from './designer-inputs';
import { moved, newField, questions } from './designer-model';
import { TemplateCopyActions } from './template-copy';

/**
 * The PDF template designer (docs/documents ADR-0001 D1–D3), a tab of the
 * form builder for Integr8 staff in a company's seat.
 *
 * A form's templates are listed on the left; the one open is edited in three
 * parts — the page, the document fields, the content — with a live preview
 * beside it, drawn by the same renderer the server prints with, filled with a
 * recent submission's answers when there is one. The preview marks where
 * pages end; the PDF itself is made by the server.
 */

const client = () => session().client;
const templateKeys = {
  list: (formId: string) => ['documents', 'templates', formId] as const,
};

type Template = NonNullable<Awaited<ReturnType<typeof listTemplates>>>['items'][number];

async function listTemplates(formId: string) {
  return (
    await client().GET('/v1/document-templates', {
      params: { query: { formId, includeArchived: 'true' } },
    })
  ).data!;
}

export function DocumentDesigner({
  formId,
  formTitle,
  form,
  locale,
  enabled,
  companyName,
}: {
  formId: string;
  formTitle: string;
  /** The form as last published, or null when it never was. */
  form: CompiledForm | null;
  locale: string;
  /** Whether the company has documents switched on. */
  enabled: boolean;
  companyName: string;
}) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState('');

  const templates = useQuery({
    queryKey: templateKeys.list(formId),
    queryFn: () => listTemplates(formId),
    enabled: enabled && form !== null,
  });
  const create = useMutation({
    mutationFn: async () =>
      (
        await client().POST('/v1/document-templates', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: { formId, name: name.trim() },
        })
      ).data!,
    onSuccess: (created) => {
      setName('');
      setSelected(created.id);
      void queries.invalidateQueries({ queryKey: templateKeys.list(formId) });
    },
  });

  if (!enabled) {
    return <EmptyState body={t('documents.designer.moduleOff')} />;
  }
  if (form === null) {
    return <EmptyState body={t('documents.designer.notPublished')} />;
  }
  if (templates.isPending) {
    return <LoadingState />;
  }
  if (templates.isError) {
    return (
      <ErrorState
        requestId={
          templates.error instanceof ApiRequestError ? templates.error.requestId : undefined
        }
        onRetry={() => void templates.refetch()}
      />
    );
  }

  const items = templates.data.items.filter((item) => showArchived || !item.archived);
  const open = templates.data.items.find((item) => item.id === selected) ?? items[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-6 py-4 text-start lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-60">
        <p className="text-sm text-content-muted">{t('documents.designer.intro')}</p>
        <h2 className="text-sm font-semibold text-content">{t('documents.designer.templates')}</h2>
        {items.length === 0 ? (
          <p className="text-sm text-content-muted">{t('documents.designer.none')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={item.id === open?.id ? 'true' : undefined}
                  onClick={() => setSelected(item.id)}
                  className={[
                    'w-full rounded-md px-3 py-2 text-start text-sm',
                    item.id === open?.id
                      ? 'bg-accent-subtle font-medium text-content'
                      : 'text-content hover:bg-surface-muted',
                  ].join(' ')}
                >
                  <span dir="auto">{item.name}</span>
                  {item.archived ? (
                    <span className="ms-2 text-xs text-content-muted">
                      {t('documents.designer.archived')}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
        <CheckInput
          label={t('documents.designer.showArchived')}
          checked={showArchived}
          onChange={setShowArchived}
        />
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() !== '') {
              create.mutate();
            }
          }}
        >
          <Field
            label={t('documents.designer.newName')}
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" busy={create.isPending} disabled={name.trim() === ''}>
            {t('documents.designer.create')}
          </Button>
          {create.isError ? <ServerProblems error={create.error} /> : null}
        </form>
      </aside>

      {open === undefined ? null : (
        <TemplateEditor
          key={open.id}
          template={open}
          form={form}
          formId={formId}
          formTitle={formTitle}
          locale={locale}
          companyName={companyName}
        />
      )}
    </div>
  );
}

function TemplateEditor({
  template,
  form,
  formId,
  formTitle,
  locale,
  companyName,
}: {
  template: Template;
  form: CompiledForm;
  formId: string;
  formTitle: string;
  locale: string;
  companyName: string;
}) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const initial = useMemo(() => {
    const parsed = parseDesign(template.design);
    return parsed.ok ? parsed.design : emptyDesign();
  }, [template.design]);
  const [design, setDesign] = useState<TemplateDesign>(initial);
  const [name, setName] = useState(template.name);
  const [revision, setRevision] = useState(template.revision);
  const [dirty, setDirty] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const change = (next: TemplateDesign) => {
    setDesign(next);
    setDirty(true);
    setJustSaved(false);
  };

  const save = useMutation({
    mutationFn: async () =>
      (
        await client().PATCH('/v1/document-templates/{templateId}', {
          params: { path: { templateId: template.id } },
          body: { revision, name: name.trim(), design },
        })
      ).data!,
    onSuccess: (saved) => {
      setRevision(saved.revision);
      setDirty(false);
      setJustSaved(true);
      void queries.invalidateQueries({ queryKey: templateKeys.list(formId) });
    },
  });
  const archive = useMutation({
    mutationFn: async (archived: boolean) =>
      (
        await client().POST('/v1/document-templates/{templateId}/archive', {
          params: { path: { templateId: template.id } },
          body: { archived },
        })
      ).data!,
    onSuccess: () => void queries.invalidateQueries({ queryKey: templateKeys.list(formId) }),
  });
  const changedElsewhere =
    save.error instanceof ApiRequestError && save.error.code === 'document_template_changed';

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 xl:flex-row">
      <div className="flex w-full min-w-0 flex-col gap-4 xl:max-w-xl">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <Field
              label={t('documents.designer.name')}
              value={name}
              maxLength={120}
              onChange={(event) => {
                setName(event.target.value);
                setDirty(true);
                setJustSaved(false);
              }}
            />
          </div>
          <Button
            busy={save.isPending}
            disabled={!dirty || name.trim() === ''}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t('documents.designer.saving') : t('documents.designer.save')}
          </Button>
          <Button
            variant="ghost"
            busy={archive.isPending}
            onClick={() => archive.mutate(!template.archived)}
          >
            {template.archived ? t('documents.designer.restore') : t('documents.designer.archive')}
          </Button>
          <TemplateCopyActions
            templateId={template.id}
            templateName={template.name}
            design={template.design}
            formId={formId}
            form={form}
            dirty={dirty}
          />
        </div>
        <p role="status" className="text-xs text-content-muted">
          {dirty ? t('documents.designer.unsaved') : justSaved ? t('documents.designer.saved') : ''}
        </p>
        {changedElsewhere ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-md bg-warning-subtle p-3 text-sm"
          >
            {t('documents.designer.changedElsewhere')}
            <Button
              variant="secondary"
              onClick={() =>
                void queries.invalidateQueries({ queryKey: templateKeys.list(formId) })
              }
            >
              {t('documents.designer.reload')}
            </Button>
          </div>
        ) : save.isError ? (
          <ServerProblems error={save.error} />
        ) : null}

        <Section title={t('documents.designer.section.page')}>
          <PageEditor design={design} onChange={change} />
        </Section>
        <Section title={t('documents.designer.section.fields')}>
          <FieldsEditor design={design} form={form} locale={locale} onChange={change} />
        </Section>
        <Section title={t('documents.designer.section.blocks')}>
          <BlockList
            blocks={design.blocks}
            context={{ design, form, locale }}
            onChange={(blocks) => change({ ...design, blocks: blocks })}
          />
        </Section>
      </div>
      <Preview
        design={design}
        form={form}
        formId={formId}
        formTitle={formTitle}
        locale={locale}
        companyName={companyName}
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface p-4">
      <h3 className="text-base font-semibold text-content">{title}</h3>
      {children}
    </section>
  );
}

/** The server's reasons for refusing a save, one per line. */
function ServerProblems({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!(error instanceof ApiRequestError)) {
    return <ErrorState />;
  }
  return (
    <div role="alert" className="rounded-md border border-danger bg-danger-subtle p-3 text-sm">
      <p className="text-content">{t('documents.designer.problems')}</p>
      <ul className="mt-1 list-disc ps-5 text-content">
        {error.details.length === 0 ? <li>{error.message}</li> : null}
        {error.details.map((detail, index) => (
          <li key={index}>
            <code dir="ltr" className="text-xs">
              {detail.field.replace(/^body\.design\./u, '')}
            </code>{' '}
            {detail.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PageEditor({
  design,
  onChange,
}: {
  design: TemplateDesign;
  onChange: (design: TemplateDesign) => void;
}) {
  const { t } = useTranslation();
  const page = design.page;
  const setPage = (next: Partial<TemplateDesign['page']>) =>
    onChange({ ...design, page: { ...page, ...next } });
  const margin = (side: 'top' | 'bottom' | 'start' | 'end') => (
    <NumberInput
      label={t(`documents.designer.page.${side}`)}
      value={page.margins[side]}
      min={0}
      max={60}
      onChange={(value) => setPage({ margins: { ...page.margins, [side]: value ?? 0 } })}
    />
  );
  const firstMode =
    page.firstPage === null ? 'same' : page.firstPage.background === null ? 'plain' : 'own';
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <SelectInput
          label={t('documents.designer.page.language')}
          value={page.language ?? 'company'}
          options={[
            { value: 'company', label: t('documents.designer.page.languageCompany') },
            { value: 'en', label: t('documents.designer.page.english') },
            { value: 'ar', label: t('documents.designer.page.arabic') },
          ]}
          onChange={(value) => setPage({ language: value === 'company' ? null : value })}
        />
        <NumberInput
          label={t('documents.designer.page.fontSize')}
          value={page.fontSize}
          min={7}
          max={16}
          step={0.5}
          onChange={(value) => setPage({ fontSize: value ?? 10 })}
        />
      </div>
      <span className="text-xs font-medium text-content-muted">
        {t('documents.designer.page.margins')}
      </span>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {margin('top')}
        {margin('bottom')}
        {margin('start')}
        {margin('end')}
      </div>
      <CheckInput
        label={t('documents.designer.page.pageNumbers')}
        checked={page.footer.pageNumbers}
        onChange={(pageNumbers) => setPage({ footer: { ...page.footer, pageNumbers } })}
      />
      <LocalizedInputs
        optional
        labels={{
          en: `${t('documents.designer.page.footerText')} · ${t('documents.designer.block.textEn')}`,
          ar: `${t('documents.designer.page.footerText')} · ${t('documents.designer.block.textAr')}`,
        }}
        value={page.footer.text}
        onChange={(text) => {
          const footer: TemplateDesign['page']['footer'] = { pageNumbers: page.footer.pageNumbers };
          setPage({ footer: text === undefined ? footer : { ...footer, text } });
        }}
      />
      <ImageUpload
        label={t('documents.designer.page.background')}
        fileId={page.background?.fileId ?? null}
        onChange={(fileId) => setPage({ background: fileId === null ? null : { fileId } })}
      />
      <SelectInput
        label={t('documents.designer.page.firstPage')}
        value={firstMode}
        options={[
          { value: 'same', label: t('documents.designer.page.firstSame') },
          { value: 'plain', label: t('documents.designer.page.firstPlain') },
          { value: 'own', label: t('documents.designer.page.firstOwn') },
        ]}
        onChange={(mode) =>
          setPage({
            firstPage:
              mode === 'same'
                ? null
                : {
                    background: mode === 'plain' ? null : (page.firstPage?.background ?? null),
                    topMargin: page.firstPage?.topMargin ?? null,
                  },
          })
        }
      />
      {page.firstPage === null ? null : (
        <>
          {firstMode === 'own' || page.firstPage.background !== null ? (
            <ImageUpload
              label={t('documents.designer.page.firstBackground')}
              fileId={page.firstPage.background?.fileId ?? null}
              onChange={(fileId) =>
                setPage({
                  firstPage: {
                    topMargin: page.firstPage?.topMargin ?? null,
                    background: fileId === null ? null : { fileId },
                  },
                })
              }
            />
          ) : null}
          <NumberInput
            label={t('documents.designer.page.firstTop')}
            hint={t('documents.designer.page.firstTopHint')}
            value={page.firstPage.topMargin}
            min={0}
            max={120}
            onChange={(topMargin) =>
              setPage({
                firstPage: { background: page.firstPage?.background ?? null, topMargin },
              })
            }
          />
        </>
      )}
    </div>
  );
}

function FieldsEditor({
  design,
  form,
  locale,
  onChange,
}: {
  design: TemplateDesign;
  form: CompiledForm;
  locale: string;
  onChange: (design: TemplateDesign) => void;
}) {
  const { t } = useTranslation();
  const setFields = (fields: DocumentField[]) => onChange({ ...design, fields });
  const update = (index: number, field: DocumentField) =>
    setFields(design.fields.map((candidate, at) => (at === index ? field : candidate)));
  const facts = [
    'form_title',
    'submitted_date',
    'submitted_by',
    'work_order_reference',
    'asset_reference',
    'document_date',
  ] as const;

  return (
    <div className="flex flex-col gap-3">
      {design.fields.map((field, index) => (
        <div key={index} className="flex flex-col gap-3 rounded-md border border-border-subtle p-3">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <TextInput
              label={t('documents.designer.field.key')}
              hint={t('documents.designer.field.keyHint')}
              value={field.key}
              dir="ltr"
              maxLength={64}
              onChange={(key) => update(index, { ...field, key: key.toLowerCase() })}
            />
            <SelectInput
              label={t('documents.designer.field.lookup')}
              value={field.lookup}
              options={[
                { value: 'none', label: t('documents.designer.field.lookupNone') },
                { value: 'key', label: t('documents.designer.field.lookupKey') },
                { value: 'confirm', label: t('documents.designer.field.lookupConfirm') },
              ]}
              onChange={(lookup) => update(index, { ...field, lookup })}
            />
          </div>
          <LocalizedInputs
            labels={{
              en: t('documents.designer.field.labelEn'),
              ar: t('documents.designer.field.labelAr'),
            }}
            value={field.label}
            onChange={(label) => update(index, { ...field, label: label ?? {} })}
          />
          <SelectInput
            label={t('documents.designer.field.source')}
            value={field.source.kind}
            options={[
              { value: 'typed', label: t('documents.designer.field.typed') },
              { value: 'answer', label: t('documents.designer.field.answer') },
              { value: 'submission', label: t('documents.designer.field.submission') },
            ]}
            onChange={(kind) =>
              update(index, {
                ...field,
                source:
                  kind === 'typed'
                    ? { kind, required: false, maxLength: 100 }
                    : kind === 'answer'
                      ? { kind, fieldId: questions(form)[0]?.id ?? '' }
                      : { kind, value: 'document_date' },
              })
            }
          />
          {field.source.kind === 'typed' ? (
            <div className="grid grid-cols-1 items-end gap-3 lg:grid-cols-2">
              <CheckInput
                label={t('documents.designer.field.required')}
                checked={field.source.required}
                onChange={(required) =>
                  update(index, {
                    ...field,
                    source: {
                      kind: 'typed',
                      required,
                      maxLength: field.source.kind === 'typed' ? field.source.maxLength : 100,
                    },
                  })
                }
              />
              <NumberInput
                label={t('documents.designer.field.maxLength')}
                value={field.source.maxLength}
                min={1}
                max={500}
                onChange={(maxLength) =>
                  update(index, {
                    ...field,
                    source: {
                      kind: 'typed',
                      required: field.source.kind === 'typed' && field.source.required,
                      maxLength: maxLength ?? 100,
                    },
                  })
                }
              />
            </div>
          ) : field.source.kind === 'answer' ? (
            <QuestionInput
              label={t('documents.designer.field.answerField')}
              value={field.source.fieldId}
              questions={questions(form)}
              locale={locale}
              onChange={(fieldId) =>
                update(index, { ...field, source: { kind: 'answer', fieldId } })
              }
            />
          ) : (
            <SelectInput
              label={t('documents.designer.field.fact')}
              value={field.source.value}
              options={facts.map((value) => ({
                value,
                label: t(`documents.designer.field.facts.${value}`),
              }))}
              onChange={(value) =>
                update(index, { ...field, source: { kind: 'submission', value } })
              }
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              disabled={index === 0}
              aria-label={t('documents.designer.block.moveUp')}
              onClick={() => setFields(moved(design.fields, index, -1))}
            >
              ↑
            </Button>
            <Button
              variant="ghost"
              disabled={index === design.fields.length - 1}
              aria-label={t('documents.designer.block.moveDown')}
              onClick={() => setFields(moved(design.fields, index, 1))}
            >
              ↓
            </Button>
            <Button
              variant="ghost"
              onClick={() => setFields(design.fields.filter((_field, at) => at !== index))}
            >
              {t('documents.designer.field.remove')}
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Button
          variant="secondary"
          disabled={design.fields.length >= 20}
          onClick={() => setFields([...design.fields, newField(design.fields)])}
        >
          {t('documents.designer.field.add')}
        </Button>
      </div>
    </div>
  );
}

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

function Preview({
  design,
  form,
  formId,
  formTitle,
  locale,
  companyName,
}: {
  design: TemplateDesign;
  form: CompiledForm;
  formId: string;
  formTitle: string;
  locale: string;
  companyName: string;
}) {
  const { t } = useTranslation();
  const [submissionId, setSubmissionId] = useState('');

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
  const answers = useMemo(
    () => (submissionId === '' ? {} : (chosen.data?.submission.answers ?? {})),
    [submissionId, chosen.data],
  );

  // Every picture the preview may draw: the template's own, and the answer's photos.
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
    return [...ids];
  }, [design, form, answers]);
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
    return { logo: null, files, media: files };
  }, [fileIds, pictures]);

  const language = design.page.language ?? (locale.startsWith('ar') ? 'ar' : 'en');
  const html = useMemo(() => {
    const facts = {
      companyName,
      formTitle,
      submittedAt: chosen.data?.submission.submittedAt ?? null,
      submittedBy: chosen.data?.submission.submittedBy.name ?? null,
      workOrderReference: chosen.data?.submission.workOrder?.referenceLabel ?? null,
      assetReference: chosen.data?.asset?.reference ?? null,
      documentDate: new Date(0).toISOString(),
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
      }).html;
    } catch {
      return '';
    }
  }, [design, form, answers, language, images, companyName, formTitle, chosen.data]);

  return (
    <section
      className="flex min-w-0 flex-1 flex-col gap-2"
      aria-label={t('documents.designer.preview')}
    >
      <div className="flex flex-wrap items-end gap-3">
        <h3 className="text-base font-semibold text-content">{t('documents.designer.preview')}</h3>
        <div className="min-w-56">
          <SelectInput
            label={t('documents.designer.previewWith')}
            value={submissionId === '' ? 'none' : submissionId}
            options={[
              { value: 'none', label: t('documents.designer.previewEmpty') },
              ...(recent.data?.items ?? []).map((item) => ({
                value: item.id,
                label: `${item.submittedBy.name} · ${item.submittedAt ?? item.createdAt}`,
              })),
            ]}
            onChange={(value) => setSubmissionId(value === 'none' ? '' : value)}
          />
        </div>
      </div>
      <p className="text-xs text-content-muted">{t('documents.designer.previewHint')}</p>
      <iframe
        title={t('documents.designer.preview')}
        sandbox=""
        srcDoc={html}
        className="min-h-[70vh] w-full flex-1 rounded-md border border-border-subtle bg-surface-muted"
      />
    </section>
  );
}
