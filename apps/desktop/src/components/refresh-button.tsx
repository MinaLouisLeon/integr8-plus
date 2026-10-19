import { useTranslation } from '@integr8/i18n';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ChromeIconGlyph } from '~/components/nav-icon';

/**
 * The top bar's Refresh: fetch what is on screen again.
 *
 * The app keeps what it fetched for a while and does not fetch again when the
 * window comes back into focus, so a change made somewhere else (a company
 * added from the dashboard, a form published by a colleague) shows only on
 * the next sign-in. This asks for everything again without signing out.
 */
export function RefreshButton() {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [busy, setBusy] = useState(false);
  const label = busy ? t('common.refreshing') : t('common.refresh');

  return (
    <button
      type="button"
      onClick={() => {
        if (busy) {
          return;
        }
        setBusy(true);
        void refreshAll(queries).finally(() => setBusy(false));
      }}
      disabled={busy}
      aria-busy={busy}
      title={label}
      className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-sm text-shell-text-muted hover:bg-shell-hover hover:text-shell-text disabled:cursor-wait disabled:opacity-70"
    >
      <ChromeIconGlyph
        name="refresh"
        className={busy ? 'animate-spin motion-reduce:animate-none' : undefined}
      />
      <span className="hidden sm:inline">{label}</span>
      <span className="sr-only sm:hidden">{label}</span>
    </button>
  );
}

/**
 * Marks everything the app has fetched as out of date and fetches again what
 * the open screen shows; anything else is fetched afresh when it is next
 * opened. Resolves once the screen's own fetches have finished, failed ones
 * included: each screen shows its own error and its own Try again.
 */
export function refreshAll(queries: QueryClient): Promise<void> {
  return queries.invalidateQueries();
}
