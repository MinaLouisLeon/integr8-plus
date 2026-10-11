'use client';

import { createClient } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { QuoteDocument } from '@integr8/operations-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, Field, LoadingState } from '~/components/ui';
import { messageForError } from '~/lib/errors';

/**
 * The customer's quote (CRM/ERP plan, phase S1; ADR-0006).
 *
 * The office copied this link and sent it on. Whoever holds it reads the
 * issued quote, prints it or saves it as a PDF, and accepts or declines it —
 * with no account and no session, until the quote's expiry. The token is a
 * capability, so the page asks for nothing but a name, and says the same
 * thing for a spent, replaced, withdrawn and never-real link alike.
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

export default function PublicQuotePage() {
  const { token } = useParams<{ token: string }>();
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [answered, setAnswered] = useState<'accepted' | 'rejected' | null>(null);

  const quote = useQuery({
    queryKey: ['public-quote', token],
    queryFn: async () =>
      (await client().GET('/v1/public/quotes/{token}', { params: { path: { token } } })).data!,
    retry: false,
  });
  const answer = useMutation({
    mutationFn: async (status: 'accepted' | 'rejected') =>
      (
        await client().POST('/v1/public/quotes/{token}/answer', {
          params: { path: { token } },
          body: {
            status,
            name: name.trim(),
            ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
          },
        })
      ).data!,
    onSuccess: (_next, status) => {
      setAnswered(status);
    },
  });

  if (quote.isPending) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-3xl items-center justify-center px-6">
        <LoadingState />
      </main>
    );
  }
  if (quote.isError) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-6">
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">
          {t('sales.public.invalid')}
        </p>
      </main>
    );
  }

  const data = answer.data ?? quote.data;
  const company = data.company.name;
  const document = {
    company: {
      name: company,
      logoUrl: data.company.logoPath === null ? null : `${API_BASE}${data.company.logoPath}`,
    },
    reference: data.quote.reference,
    title: data.quote.title,
    issuedAt: data.quote.issuedAt,
    validUntil: data.quote.validUntil,
    customerName: data.quote.customerName,
    customerAddress: data.quote.customerAddress,
    contactName: data.quote.contactName,
    introduction: data.quote.introduction,
    terms: data.quote.terms,
    currencyCode: data.quote.currencyCode,
    lines: data.lines,
    totals: data.totals,
    answer: data.quote.answer,
  };

  const submit = (status: 'accepted' | 'rejected') => (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== '') {
      answer.mutate(status);
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 px-4 py-8 print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-content-muted">{t('sales.public.from', { company })}</p>
        <Button type="button" variant="secondary" onClick={() => window.print()}>
          {t('sales.public.print')}
        </Button>
      </div>

      <div className="rounded-lg border border-border-subtle shadow-sm print:border-0 print:shadow-none">
        <QuoteDocument document={document} locale={locale} />
      </div>

      <section className="flex flex-col gap-4 print:hidden" aria-live="polite">
        {answered === 'accepted' ? (
          <p className="rounded-md bg-success-subtle px-3 py-2 text-sm text-content">
            {t('sales.public.thanksAccepted', { company })}
          </p>
        ) : answered === 'rejected' ? (
          <p className="rounded-md bg-surface-muted px-3 py-2 text-sm text-content">
            {t('sales.public.thanksRejected')}
          </p>
        ) : data.quote.expired ? (
          <p className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">
            {t('sales.public.expired', { company })}
          </p>
        ) : data.canAnswer ? (
          <form className="flex flex-col gap-4" onSubmit={submit('accepted')} noValidate>
            <p className="text-sm text-content">{t('sales.public.answerIntro')}</p>
            <Field
              label={t('sales.public.yourName')}
              hint={t('sales.public.yourNameHint')}
              autoComplete="name"
              required
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
              {...(answer.isError ? { error: messageForError(answer.error, t) } : {})}
            />
            <Field
              label={t('sales.public.reason')}
              maxLength={1000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <div className="flex flex-wrap gap-3">
              <Button type="submit" busy={answer.isPending} disabled={name.trim() === ''}>
                {answer.isPending ? t('sales.public.accepting') : t('sales.public.accept')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={name.trim() === '' || answer.isPending}
                onClick={() => answer.mutate('rejected')}
              >
                {t('sales.public.reject')}
              </Button>
            </div>
          </form>
        ) : null}
      </section>
    </main>
  );
}
