'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Button, EmptyState, ErrorState, Field, LoadingState } from '~/components/ui';
import { StatusBadge } from '~/components/platform-bits';
import { messageForError } from '~/lib/errors';
import {
  formatBytes,
  formatDate,
  isValidSlug,
  isValidWebsite,
  suggestSlug,
} from '~/lib/platform-format';
import { platformClient } from '~/lib/platform-session';

/**
 * The company directory, and onboarding (P15).
 *
 * The first screen, and the one that has to stay fast: it is one request, and
 * the API answers it with one query rather than a fan-out per company.
 *
 * Onboarding lives here rather than on a page of its own because it is one
 * short form and because the thing you do straight afterwards is look at the
 * company you just made.
 */
export default function CompaniesPage() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [onboarding, setOnboarding] = useState(false);

  const companies = useQuery({
    queryKey: ['platform', 'companies', search, includeCancelled],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/companies', {
        params: {
          query: {
            includeCancelled: includeCancelled ? 'true' : 'false',
            ...(search.trim() === '' ? {} : { search: search.trim() }),
          },
        },
      });
      return data?.items ?? [];
    },
  });

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl font-semibold text-content">{t('platform.companies.title')}</h1>
        <Button onClick={() => setOnboarding((open) => !open)}>
          {t('platform.companies.onboard')}
        </Button>
      </header>

      {onboarding ? <OnboardForm onDone={() => setOnboarding(false)} /> : null}

      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-64 flex-1">
          <Field
            label={t('platform.companies.search')}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-content-muted">
          <input
            type="checkbox"
            checked={includeCancelled}
            onChange={(event) => setIncludeCancelled(event.target.checked)}
          />
          {t('platform.companies.includeCancelled')}
        </label>
      </div>

      {companies.isPending ? <LoadingState /> : null}

      {companies.isError ? (
        <ErrorState
          requestId={
            companies.error instanceof ApiRequestError ? companies.error.requestId : undefined
          }
          onRetry={() => void companies.refetch()}
        />
      ) : null}

      {companies.isSuccess && companies.data.length === 0 ? (
        <EmptyState title={t('platform.companies.empty')} />
      ) : null}

      {companies.isSuccess && companies.data.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-start text-content-muted">
                <th scope="col" className="py-2 text-start">
                  {t('platform.companies.name')}
                </th>
                <th scope="col" className="py-2 text-start">
                  {t('platform.companies.status')}
                </th>
                <th scope="col" className="py-2 text-start">
                  {t('platform.companies.plan')}
                </th>
                <th scope="col" className="py-2 text-end">
                  {t('platform.companies.people')}
                </th>
                <th scope="col" className="py-2 text-end">
                  {t('platform.companies.storage')}
                </th>
                <th scope="col" className="py-2 text-start">
                  {t('platform.companies.created')}
                </th>
                <th scope="col" className="py-2 text-start">
                  {t('platform.companies.lastActivity')}
                </th>
              </tr>
            </thead>
            <tbody>
              {companies.data.map((company) => (
                <tr key={company.id} className="border-b border-border-subtle">
                  <td className="py-2">
                    <Link
                      href={`/platform/companies/${company.id}`}
                      className="font-medium text-content underline-offset-2 hover:underline"
                    >
                      {company.name}
                    </Link>
                    <div className="font-mono text-xs text-content-muted">{company.slug}</div>
                  </td>
                  <td className="py-2">
                    <StatusBadge
                      status={company.status}
                      deletionScheduledFor={company.deletionScheduledFor}
                    />
                  </td>
                  <td className="py-2">{company.plan}</td>
                  <td className="py-2 text-end tabular-nums">
                    {company.seats === null
                      ? company.activeMembers
                      : t('platform.companies.seatsUsed', {
                          used: company.activeMembers,
                          total: company.seats,
                        })}
                  </td>
                  <td className="py-2 text-end tabular-nums">
                    {formatBytes(company.storageBytes)}
                  </td>
                  <td className="py-2">{formatDate(company.createdAt)}</td>
                  <td className="py-2">
                    {company.lastActivityAt === null
                      ? t('platform.companies.never')
                      : formatDate(company.lastActivityAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </main>
  );
}

/**
 * Onboarding, in one form.
 *
 * The slug is suggested from the name and stays editable, because it cannot be
 * changed afterwards. It is validated here against the same rule the API uses,
 * so a typo is caught before a company is half-created.
 */
function OnboardForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const queries = useQueryClient();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [plan, setPlan] = useState('trial');
  const [seats, setSeats] = useState('');
  // Invoiced by default: the people onboarded here are customers Integr8 has
  // already agreed terms with. Self-serve is the exception, chosen on purpose.
  const [billingMode, setBillingMode] = useState<'self_serve' | 'invoiced'>('invoiced');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [copied, setCopied] = useState(false);

  const effectiveSlug = slugTouched ? slug : suggestSlug(name);

  const onboard = useMutation({
    mutationFn: async () => {
      const { data } = await platformClient().POST('/v1/platform/companies', {
        body: {
          name: name.trim(),
          slug: effectiveSlug,
          plan: plan as 'trial' | 'starter' | 'standard' | 'enterprise',
          seats: seats.trim() === '' ? null : Number(seats),
          billingMode,
          ownerEmail: ownerEmail.trim(),
          websiteUrl: website.trim() === '' ? null : website.trim(),
        },
      });
      return data;
    },
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['platform', 'companies'] });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onboard.mutate();
  };

  if (onboard.isSuccess && onboard.data !== undefined) {
    const result = onboard.data;
    return (
      <section className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface-muted p-4">
        <p className="text-content">{t('platform.onboard.done', { name: result.company.name })}</p>
        <p className="text-sm text-content-muted">
          {t('platform.onboard.invitationSent', { email: result.ownerInvitation.email })}
        </p>

        {result.storage.bucket === '' ? (
          <p className="text-sm text-warning">{t('platform.onboard.storageMissing')}</p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {result.ownerInvitation.acceptUrl === null ? null : (
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard
                  .writeText(result.ownerInvitation.acceptUrl ?? '')
                  .then(() => setCopied(true));
              }}
            >
              {copied ? t('platform.onboard.copied') : t('platform.onboard.copyInvitation')}
            </Button>
          )}
          <Link
            href={`/platform/companies/${result.company.id}`}
            className="rounded-md bg-accent px-3 py-2 text-sm text-on-accent"
          >
            {result.company.name}
          </Link>
          <Button variant="secondary" onClick={onDone}>
            {t('common.close')}
          </Button>
        </div>
      </section>
    );
  }

  const slugProblem =
    effectiveSlug !== '' && !isValidSlug(effectiveSlug)
      ? t('platform.onboard.slugHint')
      : undefined;
  const websiteOk = website.trim() === '' || isValidWebsite(website.trim());

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-4 rounded-lg border border-border-subtle bg-surface-muted p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-content">{t('platform.onboard.title')}</h2>
        <p className="text-sm text-content-muted">{t('platform.onboard.subtitle')}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('platform.onboard.name')}
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Field
          label={t('platform.onboard.slug')}
          hint={t('platform.onboard.slugHint')}
          required
          value={effectiveSlug}
          onChange={(event) => {
            setSlugTouched(true);
            setSlug(event.target.value);
          }}
          {...(slugProblem === undefined ? {} : { error: slugProblem })}
        />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-content">{t('platform.onboard.plan')}</span>
          <select
            value={plan}
            onChange={(event) => setPlan(event.target.value)}
            className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-content"
          >
            <option value="trial">trial</option>
            <option value="starter">starter</option>
            <option value="standard">standard</option>
            <option value="enterprise">enterprise</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-content">{t('platform.onboard.billingMode')}</span>
          <select
            value={billingMode}
            onChange={(event) => setBillingMode(event.target.value as 'self_serve' | 'invoiced')}
            className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-content"
          >
            <option value="invoiced">{t('platform.billingMode.invoiced')}</option>
            <option value="self_serve">{t('platform.billingMode.self_serve')}</option>
          </select>
          <span className="text-content-muted">{t('platform.onboard.billingModeHint')}</span>
        </label>
        <Field
          label={t('platform.onboard.seats')}
          hint={t('platform.onboard.seatsHint')}
          type="number"
          min={1}
          value={seats}
          onChange={(event) => setSeats(event.target.value)}
        />
        <Field
          label={t('platform.onboard.ownerEmail')}
          type="email"
          required
          value={ownerEmail}
          onChange={(event) => setOwnerEmail(event.target.value)}
          {...(onboard.isError ? { error: messageForError(onboard.error, t) } : {})}
        />
        <Field
          label={t('platform.onboard.website')}
          hint={t('platform.onboard.websiteHint')}
          type="url"
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
          {...(websiteOk ? {} : { error: t('platform.onboard.websiteInvalid') })}
        />
      </div>

      <div className="flex gap-2">
        <Button
          type="submit"
          busy={onboard.isPending}
          disabled={!isValidSlug(effectiveSlug) || ownerEmail.trim() === '' || !websiteOk}
        >
          {onboard.isPending ? t('platform.onboard.busy') : t('platform.onboard.submit')}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
