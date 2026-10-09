import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { Link } from 'react-router';
import { CompanyMark } from '~/components/company-brand';
import { NavIconGlyph } from '~/components/nav-icon';
import { ErrorState, LoadingState, Shell } from '~/components/ui';
import { useMe } from '~/features/forms/api';
import { desktopNavigation } from '~/lib/navigation';
import { isTauri } from '~/lib/platform';

/**
 * The dashboard: the home screen, an overview.
 *
 * Shows who is signed in and which company they are in, which is P05's first
 * exit criterion, and a card for every section this seat may open — the same
 * list the side menu shows, drawn from the same model, with each section's
 * hint. It also reports whether it is running as a Tauri window or a browser
 * tab, which is how P05's second criterion is checked by eye.
 */
export function DashboardRoute() {
  const { t } = useTranslation();
  const me = useMe();

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

  const groups = desktopNavigation(me.data.permissions)
    .map((entry) => ({
      ...entry,
      // The dashboard is where we are; a card leading here would lead nowhere.
      sections: entry.sections.filter((section) => section.path !== 'dashboard'),
    }))
    .filter((entry) => entry.sections.length > 0);

  return (
    <Shell>
      <div className="flex flex-col gap-8 px-6 py-8">
        <header className="flex flex-col gap-1 text-start">
          <h1 className="text-2xl font-semibold text-content">
            {t('workspace.signedInAs', { name: me.data.displayName })}
          </h1>
          <CompanyMark company={me.data.company} />
        </header>

        {groups.map(({ group, sections }) => (
          <nav key={group} aria-label={t(`nav.group.${group}`)} className="flex flex-col gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-content-muted">
              {t(`nav.group.${group}`)}
            </h2>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {sections.map((section) => (
                <li key={section.key}>
                  <Link
                    to={section.to}
                    className="flex h-full flex-col gap-2 rounded-lg border border-border-subtle bg-surface p-6 text-start hover:bg-surface-muted"
                  >
                    <span className="flex items-center gap-2 text-lg font-semibold text-content">
                      <NavIconGlyph name={section.icon} className="shrink-0 text-accent" />
                      {t(`nav.section.${section.path}`)}
                    </span>
                    <span className="text-sm text-content-muted">
                      {t(`nav.hint.${section.path}`)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}

        <section className="rounded-lg border border-border-subtle bg-surface p-6 text-start">
          <dl className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <dt className="text-xs uppercase tracking-wide text-content-muted">
                {t('auth.email')}
              </dt>
              <dd className="text-sm text-content">{me.data.email}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-xs uppercase tracking-wide text-content-muted">
                {t('common.runtime')}
              </dt>
              {/*
                A developer-facing diagnostic: it exists so P05's "identical in
                both" criterion can be checked by eye, and it goes once that has
                been signed off.
              */}
              <dd className="text-sm text-content">
                {isTauri() ? t('common.runtimeTauri') : t('common.runtimeBrowser')}
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </Shell>
  );
}
