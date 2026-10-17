'use client';

import { ApiRequestError, createClient } from '@integr8/api-client';
import { formatDate, useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { LoadingState } from '~/components/ui';

/**
 * A document's QR code opens here (docs/documents ADR-0001 D7).
 *
 * Whoever holds the link sees which company issued the document, for which
 * form and when, and may view or download the PDF — no account, no session.
 * The two buttons are plain links to the API, which answers with a short-lived
 * link to the file itself. A link the company stopped says so; any other bad
 * link gets the same answer, so a stranger learns nothing from guessing.
 */

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000').replace(
  /\/+$/u,
  '',
);

let publicClient: ReturnType<typeof createClient> | undefined;
function client() {
  publicClient ??= createClient({
    baseUrl: API_BASE,
    clientApp: 'web',
    clientVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.1.0',
    getAccessToken: () => null,
  });
  return publicClient;
}

export default function PublicDocumentPage() {
  const { code } = useParams<{ code: string }>();
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  const document = useQuery({
    queryKey: ['public-document', code],
    queryFn: async () =>
      (await client().GET('/v1/public/documents/{code}', { params: { path: { code } } })).data!,
    retry: false,
  });

  if (document.isPending) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md items-center justify-center px-6">
        <LoadingState label={t('documents.public.loading')} />
      </main>
    );
  }
  if (document.isError) {
    const expired =
      document.error instanceof ApiRequestError && document.error.code === 'document_expired';
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6">
        <h1 className="text-xl font-semibold text-content">{t('documents.public.title')}</h1>
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">
          {expired ? t('documents.public.expired') : t('documents.public.invalid')}
        </p>
      </main>
    );
  }

  const { company, document: issued } = document.data;
  const file = `${API_BASE}/v1/public/documents/${encodeURIComponent(code)}/file`;
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-10">
      <header className="flex items-center gap-3">
        {company.logoPath === null ? null : (
          <img
            src={`${API_BASE}${company.logoPath}`}
            alt=""
            className="h-12 w-12 rounded-md object-contain"
          />
        )}
        <p className="text-sm text-content-muted">
          {t('documents.public.issuedBy', { company: company.name })}
        </p>
      </header>
      <h1 className="text-2xl font-semibold text-content" dir="auto">
        {issued.title}
      </h1>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-content-muted">{t('documents.public.form')}</dt>
        <dd className="text-content" dir="auto">
          {issued.formTitle}
        </dd>
        <dt className="text-content-muted">{t('documents.public.date')}</dt>
        <dd className="text-content">{formatDate(issued.createdAt, { locale })}</dd>
        {issued.pageCount === null ? null : (
          <>
            <dt className="text-content-muted">{t('documents.public.pages')}</dt>
            <dd className="text-content">{issued.pageCount}</dd>
          </>
        )}
      </dl>
      <div className="flex flex-col gap-3 sm:flex-row">
        <a
          href={file}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover"
        >
          {t('documents.public.view')}
        </a>
        <a
          href={`${file}?download=true`}
          className="inline-flex items-center justify-center rounded-md border border-border-subtle bg-surface px-4 py-2 text-sm font-medium text-content hover:bg-surface-muted"
        >
          {t('documents.public.download')}
        </a>
      </div>
    </main>
  );
}
