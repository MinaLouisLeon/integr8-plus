import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Panel } from '~/features/platform/components/platform-bits';
import { Button, ErrorState, Field, LoadingState } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import { formatBytes, formatDate } from '~/lib/platform-format';
import { platformClient } from '~/features/platform/session';

/**
 * A company's apps on its page in the staff app (0023).
 *
 * Its newest installers, so staff can send a company its desktop app or the
 * phone APK (the invitation page shows them once and nothing public lists
 * them); and how its phone app is published: an APK staff send, or the
 * company's own Google Play and App Store accounts, with the reviewer account
 * the stores need to sign in.
 */

type Platform = 'windows' | 'macos' | 'linux' | 'android';
const PLATFORMS: readonly Platform[] = ['windows', 'macos', 'linux', 'android'];

/** The company's installers, each to download or copy the link of. */
export function CompanyInstallersPanel({ tenantId }: { tenantId: string }) {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState<string | null>(null);

  const apps = useQuery({
    queryKey: ['platform', 'company', tenantId, 'apps'],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/companies/{tenantId}/apps', {
        params: { path: { tenantId } },
      });
      return data!;
    },
  });

  const release = apps.data?.status === 'found' ? apps.data.release : null;

  const copy = (url: string) => {
    void navigator.clipboard.writeText(url).then(() => setCopied(url));
  };

  return (
    <Panel title={t('platform.phoneApps.installers.title')}>
      {apps.isPending ? <LoadingState /> : null}
      {apps.isError ? <ErrorState onRetry={() => void apps.refetch()} /> : null}
      {apps.data?.status === 'none' ? (
        <p className="text-sm text-content-muted">{t('platform.phoneApps.installers.none')}</p>
      ) : null}
      {apps.data?.status === 'unavailable' ? (
        <p className="text-sm text-content-muted">{t('site.download.unavailable')}</p>
      ) : null}
      {release === null ? null : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-content-muted">
            {t('site.download.company.version', { version: release.version })} ·{' '}
            {t('platform.phoneApps.installers.hint')}
          </p>
          {PLATFORMS.map((platform) => {
            const files = release.installers.filter((file) => file.platform === platform);
            if (files.length === 0) {
              return null;
            }
            return (
              <div key={platform} className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-content">
                  {t(`site.download.platforms.${platform}`)}
                </h3>
                <ul className="flex flex-col gap-2">
                  {files.map((file) => (
                    <li
                      key={file.name}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-subtle px-4 py-3"
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="text-sm text-content">
                          {t(`site.download.kinds.${file.kind}`)}
                        </span>
                        <span className="truncate font-mono text-xs text-content-muted">
                          {[
                            file.name,
                            file.arch === null
                              ? null
                              : t(`site.download.architecture.${file.arch}`),
                            file.size === null ? null : formatBytes(file.size, i18n.language),
                          ]
                            .filter((part) => part !== null)
                            .join(' · ')}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <a
                          href={file.url}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={t('site.download.file', { name: file.name })}
                          className="rounded-md border border-border-subtle px-3 py-1.5 text-sm text-content hover:border-accent"
                        >
                          {t('platform.phoneApps.installers.download')}
                        </a>
                        <Button type="button" variant="secondary" onClick={() => copy(file.url)}>
                          {copied === file.url
                            ? t('platform.phoneApps.installers.copied')
                            : t('platform.phoneApps.installers.copyLink')}
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

interface PhoneSettings {
  appsEnabled: boolean;
  phoneDistribution: 'apk' | 'stores';
  playTrack: 'internal' | 'production';
  appStoreId: string | null;
}

interface StoreReviewer {
  userId: string;
  email: string;
  status: string;
  createdAt: string;
}

/** How the company's phone app is published, and the stores' reviewer account. */
export function PhoneDistributionPanel({
  tenantId,
  settings,
  storeReviewer,
}: {
  tenantId: string;
  settings: PhoneSettings;
  storeReviewer: StoreReviewer | null;
}) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [distribution, setDistribution] = useState(settings.phoneDistribution);
  const [track, setTrack] = useState(settings.playTrack);
  const [appStoreId, setAppStoreId] = useState(settings.appStoreId ?? '');
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const appStoreIdOk = appStoreId.trim() === '' || /^[0-9]{6,12}$/u.test(appStoreId.trim());
  const unchanged =
    distribution === settings.phoneDistribution &&
    track === settings.playTrack &&
    (appStoreId.trim() === '' ? null : appStoreId.trim()) === settings.appStoreId;

  const save = useMutation({
    mutationFn: async () => {
      await platformClient().PATCH('/v1/platform/companies/{tenantId}/settings', {
        params: { path: { tenantId } },
        body: {
          phoneDistribution: distribution,
          playTrack: track,
          appStoreId: appStoreId.trim() === '' ? null : appStoreId.trim(),
        },
      });
    },
    onSuccess: () => {
      setProblem(undefined);
      void queries.invalidateQueries({ queryKey: ['platform', 'company', tenantId] });
    },
    onError: (error) => setProblem(messageForError(error, t)),
  });

  return (
    <Panel
      title={t('platform.phoneApps.distribution.title')}
      description={t('platform.phoneApps.distribution.description')}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <fieldset className="flex flex-col gap-2 text-sm text-content">
          <legend className="sr-only">{t('platform.phoneApps.distribution.title')}</legend>
          {(['apk', 'stores'] as const).map((value) => (
            <label key={value} className="flex items-start gap-2">
              <input
                type="radio"
                name={`phone-distribution-${tenantId}`}
                checked={distribution === value}
                onChange={() => setDistribution(value)}
                className="mt-1"
              />
              <span className="flex flex-col">
                {t(`platform.phoneApps.distribution.${value}`)}
                <span className="text-xs text-content-muted">
                  {t(`platform.phoneApps.distribution.${value}Hint`)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {distribution === 'stores' ? (
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-sm text-content">
              {t('platform.phoneApps.distribution.track')}
              <select
                value={track}
                onChange={(event) => setTrack(event.target.value as PhoneSettings['playTrack'])}
                className="rounded-md border border-border-subtle bg-surface px-3 py-2"
              >
                <option value="internal">
                  {t('platform.phoneApps.distribution.trackInternal')}
                </option>
                <option value="production">
                  {t('platform.phoneApps.distribution.trackProduction')}
                </option>
              </select>
            </label>
            <Field
              label={t('platform.phoneApps.distribution.appStoreId')}
              hint={t('platform.phoneApps.distribution.appStoreIdHint')}
              inputMode="numeric"
              value={appStoreId}
              onChange={(event) => setAppStoreId(event.target.value)}
              {...(appStoreIdOk
                ? {}
                : { error: t('platform.phoneApps.distribution.appStoreIdInvalid') })}
            />
          </div>
        ) : null}

        {distribution === 'stores' && !settings.appsEnabled ? (
          <p className="text-xs text-warning">{t('platform.phoneApps.distribution.appsOff')}</p>
        ) : null}

        <div className="flex items-center gap-3">
          <Button type="submit" busy={save.isPending} disabled={unchanged || !appStoreIdOk}>
            {t('platform.phoneApps.distribution.save')}
          </Button>
          {problem === undefined ? null : (
            <span role="alert" className="text-sm text-danger">
              {problem}
            </span>
          )}
        </div>
      </form>

      {settings.phoneDistribution === 'stores' || storeReviewer !== null ? (
        <StoreReviewerSection tenantId={tenantId} reviewer={storeReviewer} />
      ) : null}
    </Panel>
  );
}

function StoreReviewerSection({
  tenantId,
  reviewer,
}: {
  tenantId: string;
  reviewer: StoreReviewer | null;
}) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [shown, setShown] = useState<
    { email: string; password: string; workOrderReference: string | null } | undefined
  >(undefined);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const make = useMutation({
    mutationFn: async () => {
      const { data } = await platformClient().POST(
        '/v1/platform/companies/{tenantId}/store-reviewer',
        { params: { path: { tenantId } } },
      );
      return data!;
    },
    onSuccess: (data) => {
      setProblem(undefined);
      setCopied(false);
      setShown({
        email: data.email,
        password: data.password,
        workOrderReference: data.workOrderReference,
      });
      void queries.invalidateQueries({ queryKey: ['platform', 'company', tenantId] });
    },
    onError: (error) => setProblem(messageForError(error, t)),
  });

  const remove = useMutation({
    mutationFn: async () => {
      await platformClient().DELETE('/v1/platform/companies/{tenantId}/store-reviewer', {
        params: { path: { tenantId } },
      });
    },
    onSuccess: () => {
      setProblem(undefined);
      setShown(undefined);
      void queries.invalidateQueries({ queryKey: ['platform', 'company', tenantId] });
    },
    onError: (error) => setProblem(messageForError(error, t)),
  });

  return (
    <div className="flex flex-col gap-3 border-t border-border-subtle pt-4">
      <h3 className="text-sm font-semibold text-content">
        {t('platform.phoneApps.reviewer.title')}
      </h3>
      <p className="text-xs text-content-muted">{t('platform.phoneApps.reviewer.description')}</p>
      {reviewer === null ? null : (
        <p className="text-sm text-content">
          {t('platform.phoneApps.reviewer.exists', {
            email: reviewer.email,
            date: formatDate(reviewer.createdAt),
          })}
        </p>
      )}

      {shown === undefined ? null : (
        <div className="flex flex-col gap-2 rounded-md bg-warning-subtle px-3 py-3 text-sm text-content">
          <p className="font-medium">{t('platform.phoneApps.reviewer.shownOnce')}</p>
          <p>
            {t('platform.phoneApps.reviewer.email')}{' '}
            <span className="font-mono" dir="ltr">
              {shown.email}
            </span>
          </p>
          <p className="flex flex-wrap items-center gap-2">
            {t('platform.phoneApps.reviewer.password')}{' '}
            <span className="font-mono" dir="ltr">
              {shown.password}
            </span>
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                void navigator.clipboard.writeText(shown.password).then(() => setCopied(true))
              }
            >
              {copied
                ? t('platform.phoneApps.installers.copied')
                : t('platform.phoneApps.reviewer.copyPassword')}
            </Button>
          </p>
          {shown.workOrderReference === null ? null : (
            <p className="text-xs text-content-muted">
              {t('platform.phoneApps.reviewer.sampleJob', {
                reference: shown.workOrderReference,
              })}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          busy={make.isPending}
          onClick={() => make.mutate()}
        >
          {reviewer === null
            ? t('platform.phoneApps.reviewer.create')
            : t('platform.phoneApps.reviewer.newPassword')}
        </Button>
        {reviewer === null ? null : (
          <Button
            type="button"
            variant="secondary"
            busy={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {t('platform.phoneApps.reviewer.remove')}
          </Button>
        )}
        {problem === undefined ? null : (
          <span role="alert" className="text-sm text-danger">
            {problem}
          </span>
        )}
      </div>
    </div>
  );
}
