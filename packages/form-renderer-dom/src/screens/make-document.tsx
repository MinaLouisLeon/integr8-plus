import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { buttonClass, inputClass } from '../widgets/types.js';
import { keys, useScreens } from './api.js';
import { Dialog, Failure, Loading } from './parts.js';

/**
 * Making a PDF document from a submission (docs/documents ADR-0001 D6): pick
 * one of the form's templates, type the fields it asks for, and the server
 * prints it. The dialog waits for the PDF and then offers it.
 *
 * Offered to a seat with `document.create` in a company with documents
 * switched on, for a submission that is not a draft. The server checks all of
 * it again, and the right to read the submission besides.
 */
export function MakeDocumentButton({
  submissionId,
  formId,
  isDraft,
}: {
  submissionId: string;
  formId: string;
  isDraft: boolean;
}) {
  const { t } = useTranslation();
  const { client } = useScreens();
  const [open, setOpen] = useState(false);
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const allowed =
    me.data?.features.documents === true && me.data.permissions.includes('document.create');
  if (!allowed || isDraft) {
    return null;
  }
  return (
    <>
      <button type="button" className={buttonClass.secondary} onClick={() => setOpen(true)}>
        {t('documents.export.action')}
      </button>
      {open ? (
        <MakeDocumentDialog
          submissionId={submissionId}
          formId={formId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

interface TypedField {
  key: string;
  label: Record<string, string>;
  required: boolean;
  maxLength: number;
}

/** The fields a template asks the person to type, read from its design. */
function typedFields(design: Record<string, unknown>): TypedField[] {
  const fields = Array.isArray(design.fields) ? (design.fields as unknown[]) : [];
  return fields.flatMap((entry) => {
    const field = entry as {
      key?: unknown;
      label?: unknown;
      source?: { kind?: unknown; required?: unknown; maxLength?: unknown };
    };
    if (typeof field.key !== 'string' || field.source?.kind !== 'typed') {
      return [];
    }
    return [
      {
        key: field.key,
        label: (field.label ?? {}) as Record<string, string>,
        required: field.source.required === true,
        maxLength: typeof field.source.maxLength === 'number' ? field.source.maxLength : 200,
      },
    ];
  });
}

function labelIn(label: Record<string, string>, locale: string, fallback: string): string {
  return label[locale.startsWith('ar') ? 'ar' : 'en'] ?? label.en ?? fallback;
}

function MakeDocumentDialog({
  submissionId,
  formId,
  onClose,
}: {
  submissionId: string;
  formId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { client, locale, navigate, paths } = useScreens();
  const ids = useId();
  const [templateId, setTemplateId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [expiresAt, setExpiresAt] = useState('');
  const [documentId, setDocumentId] = useState<string | null>(null);
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  const templates = useQuery({
    queryKey: ['documents', 'templates', formId],
    queryFn: async () =>
      (await client.GET('/v1/document-templates', { params: { query: { formId } } })).data!,
  });
  const chosen =
    templates.data?.items.find((item) => item.id === templateId) ??
    (templates.data?.items.length === 1 ? templates.data.items[0] : undefined);
  const fields = chosen === undefined ? [] : typedFields(chosen.design);

  const make = useMutation({
    mutationFn: async () => {
      if (chosen === undefined) {
        throw new Error('no template');
      }
      const typed = Object.fromEntries(
        fields
          .map((field) => [field.key, (values[field.key] ?? '').trim()] as const)
          .filter(([, value]) => value !== ''),
      );
      const instant = expiresAt === '' ? null : new Date(expiresAt);
      const { data } = await client.POST('/v1/submissions/{submissionId}/documents', {
        params: { path: { submissionId }, header: { 'Idempotency-Key': idempotencyKey } },
        body: {
          templateId: chosen.id,
          fields: typed,
          ...(instant === null || Number.isNaN(instant.getTime())
            ? {}
            : { expiresAt: instant.toISOString() }),
        },
      });
      return data!;
    },
    onSuccess: (document) => setDocumentId(document.id),
  });

  const document = useQuery({
    queryKey: ['documents', 'document', documentId ?? ''],
    enabled: documentId !== null,
    queryFn: async () =>
      (
        await client.GET('/v1/documents/{documentId}', {
          params: { path: { documentId: documentId ?? '' } },
        })
      ).data!,
    refetchInterval: (query) =>
      query.state.data === undefined || query.state.data.status === 'pending' ? 1500 : false,
  });

  const openFile = async (disposition: 'inline' | 'attachment') => {
    if (documentId === null) {
      return;
    }
    const { data } = await client.GET('/v1/documents/{documentId}/file', {
      params: { path: { documentId }, query: { disposition } },
    });
    if (data !== undefined) {
      window.open(data.url, '_blank', 'noopener');
    }
  };

  const fieldProblem = (key: string): string | undefined => {
    const error = make.error;
    if (!(error instanceof ApiRequestError)) {
      return undefined;
    }
    const detail = error.details.find((candidate) => candidate.field === `body.fields.${key}`);
    return detail === undefined ? undefined : t('documents.export.required');
  };

  const status = document.data?.status;
  const footer =
    documentId === null ? (
      <>
        <button type="button" className={buttonClass.secondary} onClick={onClose}>
          {t('documents.export.close')}
        </button>
        <button
          type="submit"
          form={`${ids}-form`}
          className={buttonClass.primary}
          disabled={chosen === undefined || make.isPending}
        >
          {t('documents.export.make')}
        </button>
      </>
    ) : (
      <>
        {status === 'ready' && paths.document !== undefined ? (
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => navigate(paths.document!(documentId))}
          >
            {t('documents.export.open')}
          </button>
        ) : null}
        <button type="button" className={buttonClass.secondary} onClick={onClose}>
          {t('documents.export.close')}
        </button>
      </>
    );

  return (
    <Dialog title={t('documents.export.title')} onClose={onClose} footer={footer}>
      {templates.isPending ? (
        <Loading />
      ) : templates.isError ? (
        <Failure error={templates.error} onRetry={() => void templates.refetch()} />
      ) : templates.data.items.length === 0 ? (
        <p className="text-sm text-content-muted">{t('documents.export.noTemplates')}</p>
      ) : documentId !== null ? (
        <div className="flex flex-col gap-3" aria-live="polite">
          {status === 'ready' ? (
            <>
              <p className="text-sm text-content">{t('documents.export.ready')}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={buttonClass.primary}
                  onClick={() => void openFile('inline')}
                >
                  {t('documents.view')}
                </button>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => void openFile('attachment')}
                >
                  {t('documents.download')}
                </button>
              </div>
            </>
          ) : status === 'failed' ? (
            <p role="alert" className="text-sm text-content">
              {t('documents.export.failed')}
            </p>
          ) : (
            <p role="status" className="text-sm text-content-muted">
              {t('documents.export.making')}
            </p>
          )}
        </div>
      ) : (
        <form
          id={`${ids}-form`}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            make.mutate();
          }}
        >
          {templates.data.items.length > 1 ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={`${ids}-template`} className="text-sm font-medium text-content">
                {t('documents.export.template')}
              </label>
              <select
                id={`${ids}-template`}
                className={inputClass}
                value={chosen?.id ?? ''}
                required
                onChange={(event) => setTemplateId(event.target.value)}
              >
                <option value="" disabled>
                  {t('documents.designer.block.choose')}
                </option>
                {templates.data.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="text-sm text-content">
              {t('documents.export.template')}: <strong>{chosen?.name}</strong>
            </p>
          )}
          {chosen === undefined ? null : fields.length === 0 ? (
            <p className="text-sm text-content-muted">{t('documents.export.noFields')}</p>
          ) : (
            fields.map((field) => {
              const problem = fieldProblem(field.key);
              return (
                <div key={field.key} className="flex flex-col gap-1">
                  <label
                    htmlFor={`${ids}-${field.key}`}
                    className="text-sm font-medium text-content"
                  >
                    {labelIn(field.label, locale, field.key)}
                    {field.required ? ` (${t('documents.export.required')})` : null}
                  </label>
                  <input
                    id={`${ids}-${field.key}`}
                    className={inputClass}
                    dir="auto"
                    required={field.required}
                    maxLength={field.maxLength}
                    value={values[field.key] ?? ''}
                    aria-invalid={problem === undefined ? undefined : true}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                  />
                </div>
              );
            })
          )}
          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-expires`} className="text-sm font-medium text-content">
              {t('documents.export.expiresAt')}
            </label>
            <input
              id={`${ids}-expires`}
              type="datetime-local"
              className={inputClass}
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </div>
          {make.isError ? <Failure error={make.error} /> : null}
        </form>
      )}
    </Dialog>
  );
}
