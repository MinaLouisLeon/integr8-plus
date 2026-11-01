import { useTranslation } from '@integr8/i18n';
import { useSyncExternalStore } from 'react';
import {
  currentUpdateNotice,
  subscribeToUpdateNotice,
  type UpdateNotice,
} from '~/lib/client-update';

/**
 * A strip across the top of the window once the server has refused this build
 * as too old (Low 6), on every screen, sign-in included: nothing the app sends
 * will be accepted until it is replaced.
 *
 * The app usually updates itself first (`UpdateBanner`); the Update button is
 * the way out when it does not. It opens the web app's download page — this
 * company's, in a company's own build — outside the app window, the way every
 * other outside page is opened here.
 */
export function ClientTooOldBanner({ notice: given }: { notice?: UpdateNotice } = {}) {
  const { t } = useTranslation();
  const reported = useSyncExternalStore(
    subscribeToUpdateNotice,
    currentUpdateNotice,
    currentUpdateNotice,
  );
  const notice = given ?? reported;

  if (notice === undefined) {
    return null;
  }

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 bg-warning-subtle px-6 py-2 text-sm text-content"
    >
      <span>
        {t('clientUpdate.needed')} {t('clientUpdate.desktopHint')}
      </span>
      {notice.link === undefined ? null : (
        <a
          href={notice.link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover"
        >
          {t('clientUpdate.button')}
        </a>
      )}
    </div>
  );
}
