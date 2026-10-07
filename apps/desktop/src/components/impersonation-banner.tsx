import { useTranslation } from '@integr8/i18n';
import { useMe } from '~/features/forms/api';

/**
 * The banner that says you are acting as a company.
 *
 * The same rule as the web app's: not subtle and not dismissible, because a
 * staff member who forgets they are inside a customer's account is how the
 * worst incidents happen. It reads `/v1/me` rather than decoding the token,
 * so the server decides who you are.
 */
export function ImpersonationBanner() {
  const { t } = useTranslation();
  const me = useMe();

  const impersonation = me.data?.impersonatedBy;
  if (impersonation === undefined) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center justify-between gap-2 bg-danger px-6 py-2 text-sm font-medium text-on-accent"
    >
      <span>{t('workspace.impersonationBanner', { name: me.data?.displayName ?? '' })}</span>
      <span className="font-mono text-xs opacity-90">{impersonation.grantId}</span>
    </div>
  );
}
