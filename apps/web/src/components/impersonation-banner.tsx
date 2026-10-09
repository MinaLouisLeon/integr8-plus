'use client';

import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '~/lib/session';

/**
 * The banner that says you are somebody else (P15).
 *
 * The plan is blunt about why this exists: *support engineers who forget they
 * are impersonating cause the worst incidents.* So it is deliberately not
 * subtle and deliberately not dismissible — a banner you can close is a banner
 * that is closed five minutes into the hour you needed it.
 *
 * It reads `/v1/me`, which the app already fetches, rather than decoding the
 * token: the server decides who you are, and a client that worked that out for
 * itself could disagree with the server about it.
 *
 * `sticky` under the top bar rather than fixed, so it never covers content at the bottom of a
 * long page, and `aria-live` so a screen reader announces it on arrival rather
 * than only when somebody tabs onto it.
 */
export function ImpersonationBanner() {
  const { t } = useTranslation();

  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/me');
      return data;
    },
  });

  const impersonation = me.data?.impersonatedBy;
  if (impersonation === undefined) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-14 z-40 -mx-6 flex flex-wrap items-center justify-between gap-2 bg-danger px-6 py-2 text-sm font-medium text-on-accent"
    >
      <span>{t('workspace.impersonationBanner', { name: me.data?.displayName ?? '' })}</span>
      <span className="font-mono text-xs opacity-90">{impersonation.grantId}</span>
    </div>
  );
}
