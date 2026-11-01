import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { type DocumentState, keys, useOperations } from '../api.js';
import {
  buttonClass,
  DashboardBackLink,
  Failure,
  Field,
  inputClass,
  Loading,
  useRowMenu,
} from '../ui.js';
import {
  DocumentMarks,
  documentState,
  DocumentStateBadge,
  localized,
  useDocumentAccess,
  useOpenDocument,
} from './document-parts.js';
import { UploadDocumentDialog } from './document-upload.js';

const STATES: readonly DocumentState[] = ['active', 'expired', 'pending', 'failed'];

/**
 * The company's documents (docs/documents ADR-0001 D8): every PDF made from a
 * submission and every PDF uploaded (0067), newest first, found by any of its
 * fields or its title, or by one field, and filtered by whether its link
 * opens. Uploaded and unshared documents are marked; those who may upload see
 * the button that does it.
 */
export function DocumentListScreen() {
  const { t } = useTranslation();
  const { client, navigate, paths, locale } = useOperations();
  const rowMenu = useRowMenu();
  const open = useOpenDocument();
  const access = useDocumentAccess();
  const [uploading, setUploading] = useState(false);
  const [text, setText] = useState('');
  const [field, setField] = useState('');
  const [state, setState] = useState<DocumentState | ''>('');
  const [searched, setSearched] = useState<{ q: string; fieldKey: string }>({
    q: '',
    fieldKey: '',
  });

  const query = {
    ...(searched.q === '' ? {} : { q: searched.q }),
    ...(searched.q === '' || searched.fieldKey === '' ? {} : { fieldKey: searched.fieldKey }),
    ...(state === '' ? {} : { state }),
    limit: 50,
  };
  const documents = useInfiniteQuery({
    queryKey: keys.documents(query),
    queryFn: async ({ pageParam }) =>
      (
        await client.GET('/v1/documents', {
          params: { query: { ...query, ...(pageParam === '' ? {} : { cursor: pageParam }) } },
        })
      ).data!,
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = useMemo(
    () => documents.data?.pages.flatMap((page) => page.items) ?? [],
    [documents.data],
  );
  const filtered = searched.q !== '' || state !== '';

  // The fields to search in, as the documents on screen name them.
  const fieldChoices = useMemo(() => {
    const seen = new Map<string, string>();
    for (const document of rows) {
      for (const candidate of document.fields) {
        if (!seen.has(candidate.key)) {
          seen.set(candidate.key, localized(candidate.label, locale));
        }
      }
    }
    if (searched.fieldKey !== '' && !seen.has(searched.fieldKey)) {
      seen.set(searched.fieldKey, searched.fieldKey);
    }
    return [...seen.entries()];
  }, [rows, locale, searched.fieldKey]);

  return (
    <div className="flex flex-col gap-6 text-start">
      <DashboardBackLink />
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-content">{t('documents.title')}</h1>
          <p className="text-sm text-content-muted">{t('documents.intro')}</p>
        </div>
        {access.upload ? (
          <button type="button" className={buttonClass.primary} onClick={() => setUploading(true)}>
            {t('documents.upload.action')}
          </button>
        ) : null}
      </header>
      {uploading ? (
        <UploadDocumentDialog
          onClose={() => setUploading(false)}
          onUploaded={(document) => {
            setUploading(false);
            navigate(paths.document(document.id));
          }}
        />
      ) : null}

      <form
        role="search"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSearched({ q: text.trim(), fieldKey: field });
        }}
      >
        <Field label={t('documents.search')} className="min-w-64 flex-1">
          {(id) => (
            <input
              id={id}
              type="search"
              className={inputClass}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('documents.searchIn')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={field}
              onChange={(event) => setField(event.target.value)}
            >
              <option value="">{t('documents.anyField')}</option>
              {fieldChoices.map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('documents.stateFilter')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={state}
              onChange={(event) => setState(event.target.value as DocumentState | '')}
            >
              <option value="">{t('documents.anyState')}</option>
              {STATES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {t(`documents.state.${candidate}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <button type="submit" className={buttonClass.secondary}>
          {t('documents.apply')}
        </button>
      </form>

      {documents.isPending ? (
        <Loading />
      ) : documents.isError ? (
        <Failure error={documents.error} onRetry={() => void documents.refetch()} />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {filtered ? t('documents.empty') : t('documents.emptyAll')}
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
            {rows.map((document) => {
              const current = documentState(document);
              return (
                <li
                  key={document.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  onContextMenu={rowMenu(
                    { kind: 'document', id: document.id, label: document.title },
                    () => [
                      {
                        key: 'open',
                        label: t('operations.rowActions.open'),
                        onSelect: () => navigate(paths.document(document.id)),
                      },
                      ...(document.status === 'ready'
                        ? [
                            {
                              key: 'view',
                              label: t('documents.view'),
                              onSelect: () => void open(document.id, 'inline'),
                            },
                            {
                              key: 'download',
                              label: t('documents.download'),
                              onSelect: () => void open(document.id, 'attachment'),
                            },
                          ]
                        : []),
                    ],
                  )}
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <a
                        href={paths.document(document.id)}
                        className="font-medium text-accent underline-offset-4 hover:underline"
                        onClick={(event) => {
                          event.preventDefault();
                          navigate(paths.document(document.id));
                        }}
                      >
                        <span dir="auto">{document.title}</span>
                      </a>
                      <DocumentStateBadge state={current} />
                      <DocumentMarks document={document} />
                    </span>
                    <span className="truncate text-sm text-content-muted">
                      {t(
                        document.source === 'uploaded' ? 'documents.upload.made' : 'documents.made',
                        {
                          date: formatDateTime(document.createdAt, { locale }),
                          name: document.createdBy.name,
                        },
                      )}
                    </span>
                  </div>
                  <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    {document.fields.slice(0, 3).map((candidate) => (
                      <div key={candidate.key} className="flex gap-1">
                        <dt className="text-content-muted">
                          {localized(candidate.label, locale)}:
                        </dt>
                        <dd className="text-content" dir="auto">
                          {candidate.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </li>
              );
            })}
          </ul>
          {documents.hasNextPage ? (
            <button
              type="button"
              className={`${buttonClass.secondary} self-center`}
              disabled={documents.isFetchingNextPage}
              onClick={() => void documents.fetchNextPage()}
            >
              {t('documents.loadMore')}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
