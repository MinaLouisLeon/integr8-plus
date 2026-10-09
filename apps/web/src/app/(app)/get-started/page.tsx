'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Button, ErrorState, LoadingState } from '~/components/ui';
import { apiClient } from '~/lib/session';

/**
 * The guided first run (P18).
 *
 * The plan is blunt that this matters more than the landing page: *companies
 * churn in week one because nothing happened, not because the marketing was
 * weak.* So this is a list of five things, each a link to the screen that does
 * it, and it tells the truth about which are done.
 *
 * **Nothing here is stored.** Every tick is computed from what actually exists
 * when the page loads, so it cannot claim somebody has invited an engineer
 * after that engineer has been removed. The cost is a handful of cheap counts;
 * the benefit is a checklist nobody has to distrust.
 */

// Forms are built in the desktop app, not here: the step links to the article
// that says so and where to get it. `/forms` is not a page this app has.
const LINKS: Record<string, string> = {
  job_type: '/settings/job-types',
  form: '/help#build-a-form',
  member: '/settings/people',
  customer: '/customers',
  submission: '/fill',
};

export default function GetStartedPage() {
  const { t } = useTranslation();
  const queries = useQueryClient();

  const progress = useQuery({
    queryKey: ['onboarding'],
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/onboarding');
      return data;
    },
  });

  const demo = useMutation({
    mutationFn: async (action: 'load' | 'remove') => {
      if (action === 'load') {
        await apiClient().POST('/v1/onboarding/demo', {});
      } else {
        await apiClient().DELETE('/v1/onboarding/demo', {});
      }
    },
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['onboarding'] });
    },
  });

  if (progress.isPending) {
    return <LoadingState />;
  }

  if (progress.isError || progress.data === undefined) {
    return (
      <ErrorState
        requestId={progress.error instanceof ApiRequestError ? progress.error.requestId : undefined}
        onRetry={() => void progress.refetch()}
      />
    );
  }

  const data = progress.data;
  const done = data.steps.filter((step) => step.done).length;

  return (
    <main className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('workspace.firstRun.title')}</h1>
        {data.complete ? (
          <p className="text-sm text-content-muted">{t('workspace.firstRun.done')}</p>
        ) : (
          <p className="flex flex-wrap gap-x-3 text-sm text-content-muted">
            <span>{t('workspace.firstRun.subtitle')}</span>
            <span>{t('workspace.firstRun.progress', { done, total: data.steps.length })}</span>
          </p>
        )}
      </header>

      <ol className="flex flex-col gap-3">
        {data.steps.map((step) => (
          <li
            key={step.key}
            className="flex items-start gap-3 rounded-lg border border-border-subtle bg-surface p-4"
          >
            <span
              aria-hidden
              className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs ${
                step.done ? 'bg-accent text-on-accent' : 'border border-border-subtle'
              }`}
            >
              {step.done ? '✓' : ''}
            </span>
            <div className="flex flex-1 flex-col gap-1">
              <Link
                href={LINKS[step.key] ?? '/dashboard'}
                className="text-base font-medium text-content hover:underline"
              >
                {t(`workspace.firstRun.steps.${step.key}`)}
              </Link>
              <p className="text-sm text-content-muted">
                {t(`workspace.firstRun.steps.${step.key}Hint`)}
              </p>
            </div>
          </li>
        ))}
      </ol>

      <section className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface p-6">
        <h2 className="text-base font-semibold text-content">
          {t('workspace.firstRun.demo.title')}
        </h2>
        <p className="text-sm text-content-muted">{t('workspace.firstRun.demo.body')}</p>

        {data.demo.loaded ? (
          <>
            <p className="text-sm text-content">
              {t('workspace.firstRun.demo.loaded', {
                customers: data.demo.customers,
                sites: data.demo.sites,
                workOrders: data.demo.workOrders,
              })}
            </p>
            {/* The reassurance that makes the button safe to press. */}
            <p className="text-xs text-content-muted">{t('workspace.firstRun.demo.safe')}</p>
            <div>
              <Button
                variant="secondary"
                busy={demo.isPending}
                onClick={() => demo.mutate('remove')}
              >
                {t('workspace.firstRun.demo.remove')}
              </Button>
            </div>
          </>
        ) : (
          <div>
            <Button variant="secondary" busy={demo.isPending} onClick={() => demo.mutate('load')}>
              {t('workspace.firstRun.demo.load')}
            </Button>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-content">
          {t('workspace.firstRun.apps.title')}
        </h2>
        <p className="text-sm text-content-muted">{t('workspace.firstRun.apps.body')}</p>
      </section>
    </main>
  );
}
