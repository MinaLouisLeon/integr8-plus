import { ApiRequestError } from '@integr8/api-client';
import type { NavIcon } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { Link } from 'react-router';
import { CompanyMark } from '~/components/company-brand';
import { NavIconGlyph } from '~/components/nav-icon';
import { ErrorState, LoadingState, Shell } from '~/components/ui';
import { assistantShown, useAiCapabilities, useMe } from '~/features/forms/api';
import { WarrantyAlerts } from '~/features/operations/screens';
import { desktopNavigation } from '~/lib/navigation';

/**
 * The dashboard: the home screen, an overview.
 *
 * Shows who is signed in and which company they are in, which is P05's first
 * exit criterion, and a card for every section this seat may open — the same
 * list the side menu shows, drawn from the same model, with each section's
 * hint.
 */
export function DashboardRoute() {
  const { t } = useTranslation();
  const me = useMe();
  const capabilities = useAiCapabilities();

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

  // The assistant's switches have no row in the shared menu model (its
  // company settings and people pages are web-only), so the seat that may
  // throw them finds them here, with the rest of the setup.
  const maySetUpAssistant =
    me.data.permissions.includes('tenant.update') || me.data.permissions.includes('member.read');

  const groups = desktopNavigation(
    me.data.permissions,
    me.data.features,
    assistantShown(capabilities.data),
  )
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

        {/* Assets whose warranty ends soon (E3); shown only with the assets module. */}
        <WarrantyAlerts />

        {groups.map(({ group, sections }) => (
          <nav key={group} aria-label={t(`nav.group.${group}`)} className="flex flex-col gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-content-muted">
              {t(`nav.group.${group}`)}
            </h2>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {sections.map((section) => (
                <li key={section.key}>
                  <SectionCard
                    to={section.to}
                    icon={section.icon}
                    title={t(`nav.section.${section.path}`)}
                    hint={t(`nav.hint.${section.path}`)}
                  />
                </li>
              ))}
              {group === 'setup' && maySetUpAssistant ? (
                <li>
                  <SectionCard
                    to="/settings/assistant"
                    icon="sparkles"
                    title={t('workspace.settings.ai.manage')}
                    hint={t('workspace.settings.ai.manageHint')}
                  />
                </li>
              ) : null}
            </ul>
          </nav>
        ))}

        <section className="rounded-lg border border-border-subtle bg-surface p-6 text-start">
          <dl className="grid gap-4">
            <div className="flex flex-col gap-1">
              <dt className="text-xs uppercase tracking-wide text-content-muted">
                {t('auth.email')}
              </dt>
              <dd className="text-sm text-content">{me.data.email}</dd>
            </div>
          </dl>
        </section>
      </div>
    </Shell>
  );
}

function SectionCard({
  to,
  icon,
  title,
  hint,
}: {
  to: string;
  icon: NavIcon;
  title: string;
  hint: string;
}) {
  return (
    <Link
      to={to}
      className="flex h-full flex-col gap-2 rounded-lg border border-border-subtle bg-surface p-6 text-start hover:bg-surface-muted"
    >
      <span className="flex items-center gap-2 text-lg font-semibold text-content">
        <NavIconGlyph name={icon} className="shrink-0 text-accent" />
        {title}
      </span>
      <span className="text-sm text-content-muted">{hint}</span>
    </Link>
  );
}
