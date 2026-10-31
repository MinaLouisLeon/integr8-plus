'use client';

import { useTranslation } from '@integr8/i18n';

/** What came of asking GitHub to build a company's apps (the API's `appBuild`). */
export interface AppBuild {
  status: 'started' | 'not_configured' | 'failed';
  runsUrl: string | null;
  runUrl: string | null;
  message: string | null;
}

/**
 * What GitHub said about a build the dashboard asked for, with where to watch
 * it: the run itself when GitHub named it, otherwise the workflow's runs, the
 * newest at the top. A server that cannot start builds says how to start one
 * by hand.
 */
export function AppBuildResult({ build, slug }: { build: AppBuild; slug: string }) {
  const { t } = useTranslation();
  if (build.status === 'not_configured') {
    return (
      <p role="status" className="text-sm text-content-muted">
        {t('platform.apps.buildNotConfigured', { slug })}
      </p>
    );
  }
  if (build.status === 'failed') {
    return (
      <p role="alert" className="text-sm text-danger">
        {t('platform.apps.buildFailed', { message: build.message ?? '' })}
      </p>
    );
  }
  const link = build.runUrl ?? build.runsUrl;
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 text-sm text-content">
      <span>{t('platform.apps.buildStarted')}</span>
      {link === null ? null : (
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline-offset-4 hover:underline"
        >
          {build.runUrl === null ? t('platform.apps.buildWatchAll') : t('platform.apps.buildWatch')}
        </a>
      )}
    </p>
  );
}
