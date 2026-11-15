'use client';

import { tagCodeOf } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { LoadingState } from '~/components/ui';
import { apiClient } from '~/lib/api-client';

/**
 * A printed asset tag's QR code opens here (P42, the owner's decision D5).
 *
 * The company's phone app reads the code straight from the QR code and opens
 * the asset, so this page is for everybody else who scans it: it says whose
 * tag it is and to scan it with that company's phone app, and shows the code
 * large for typing into the app. Nothing about the asset itself, and the same
 * answer for any code that is unknown.
 */
export default function AssetTagPage() {
  const params = useParams<{ code: string }>();
  const { t } = useTranslation();
  const code = tagCodeOf(decodeURIComponent(params.code));

  const tag = useQuery({
    queryKey: ['public-asset-tag', code ?? ''],
    queryFn: async () =>
      (
        await apiClient().GET('/v1/public/asset-tags/{code}', {
          params: { path: { code: code! } },
        })
      ).data!,
    enabled: code !== undefined,
    retry: false,
  });

  if (code !== undefined && tag.isPending) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md items-center justify-center px-6">
        <LoadingState />
      </main>
    );
  }

  const company = tag.data?.company.name;
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-10 text-start">
      <h1 className="text-2xl font-semibold text-content">
        {company === undefined
          ? t('assets.publicTag.title')
          : t('assets.publicTag.titleFor', { company })}
      </h1>
      {company === undefined ? (
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">
          {t('assets.publicTag.unknown')}
        </p>
      ) : (
        <p className="text-sm text-content-muted">{t('assets.publicTag.scan', { company })}</p>
      )}
      {code === undefined ? null : (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-content-muted">{t('assets.publicTag.code')}</span>
          <span dir="ltr" className="font-mono text-2xl tracking-widest text-content">
            {code.slice(0, 4)}-{code.slice(4, 8)}-{code.slice(8)}
          </span>
        </div>
      )}
    </main>
  );
}
