import { useTranslation } from '@integr8/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMe } from '~/features/forms/api';
import { staffBridge } from '~/lib/staff-bridge';

/**
 * The banner that says you are acting as a company.
 *
 * The same rule as the web app's: not subtle and not dismissible, because a
 * staff member who forgets they are inside a customer's account is how the
 * worst incidents happen. It reads `/v1/me` rather than decoding the token,
 * so the server decides who you are.
 *
 * In the staff app it is also the way out (P42): **Back to the dashboard**
 * ends the grant and the company session and opens the company's page again.
 */
export function ImpersonationBanner() {
  const { t } = useTranslation();
  const me = useMe();
  const navigate = useNavigate();
  const queries = useQueryClient();
  const [leaving, setLeaving] = useState(false);
  const bridge = staffBridge();

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
      <span className="flex items-center gap-3">
        <span className="font-mono text-xs opacity-90">{impersonation.grantId}</span>
        {bridge?.insideCompany() === true ? (
          <button
            type="button"
            disabled={leaving}
            onClick={() => {
              setLeaving(true);
              void (async () => {
                const to = await bridge.leaveCompany();
                // Nothing of the company's on the dashboard's screens.
                queries.clear();
                void navigate(to, { replace: true });
              })();
            }}
            className="rounded-md border border-current px-3 py-1 text-xs font-semibold hover:bg-white/10 disabled:opacity-60"
          >
            {t('workspace.backToDashboard')}
          </button>
        ) : null}
      </span>
    </div>
  );
}
