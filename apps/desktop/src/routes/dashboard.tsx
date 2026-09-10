import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Button, ErrorState, LoadingState, Shell } from '~/components/ui';
import { isTauri } from '~/lib/platform';
import { session } from '~/lib/session';

/**
 * The dashboard.
 *
 * Shows who is signed in and which company they are in, which is P05's first
 * exit criterion, and reports whether it is running as a Tauri window or a
 * browser tab — which is how the second criterion is checked by eye.
 */
export function DashboardRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await session().client.GET('/v1/me');
      return data;
    },
  });

  if (me.isPending) {
    return (
      <Shell>
        <LoadingState />
      </Shell>
    );
  }

  if (me.isError) {
    return (
      <Shell>
        <ErrorState
          requestId={me.error instanceof ApiRequestError ? me.error.requestId : undefined}
          onRetry={() => void me.refetch()}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1 text-start">
          <h1 className="text-2xl font-semibold text-content">
            {t('workspace.signedInAs', { name: me.data?.displayName ?? '' })}
          </h1>
          <p className="text-sm text-content-muted">
            {t('workspace.company')}: <code className="font-mono">{me.data?.tenantId}</code>
          </p>
        </div>

        <Button
          variant="secondary"
          onClick={() => {
            void (async () => {
              await session().signOut();
              void navigate('/sign-in', { replace: true });
            })();
          }}
        >
          {t('common.signOut')}
        </Button>
      </header>

      <section className="rounded-lg border border-border-subtle bg-surface p-6 text-start">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <dt className="text-xs uppercase tracking-wide text-content-muted">
              {t('auth.email')}
            </dt>
            <dd className="text-sm text-content">{me.data?.email}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs uppercase tracking-wide text-content-muted">
              {t('common.runtime')}
            </dt>
            {/*
              A developer-facing diagnostic: it exists so P05's "identical in
              both" criterion can be checked by eye, and it goes once that has
              been signed off. Translated regardless — a string on screen is a
              string on screen, and the exception list is two error boundaries,
              not three.
            */}
            <dd className="text-sm text-content">{isTauri() ? 'Tauri window' : 'Browser tab'}</dd>
          </div>
        </dl>
      </section>
    </Shell>
  );
}
