'use client';

import { isLocale, LOCALE_DESCRIPTORS, useTranslation, type Locale } from '@integr8/i18n';
import { useRouter } from 'next/navigation';

/**
 * Locale, theme and a right-to-left preview.
 *
 * The RTL toggle is the point of this component. P05's third exit criterion is
 * that forcing the app into RTL produces a correctly mirrored layout on every
 * screen, and there is no Arabic copy yet — so this flips the direction while
 * the words stay English, which is exactly the check.
 *
 * Preferences are cookies rather than component state because the root layout
 * is a server component: `dir` and `data-theme` have to be right in the first
 * byte, or a right-to-left layout visibly snaps into place after hydration.
 */

const YEAR = 60 * 60 * 24 * 365;

function remember(name: string, value: string): void {
  document.cookie = `${name}=${value}; path=/; max-age=${String(YEAR)}; samesite=lax`;
}

type ThemePreference = 'light' | 'dark' | 'system';

export interface PreferenceBarProps {
  locale: Locale;
  theme: ThemePreference;
  forceRtl: boolean;
}

/**
 * Values come from the server layout as props rather than being read from
 * `document.cookie` on mount. The server already resolved them to render `dir`
 * and `data-theme`; re-deriving them in the browser would mean the controls
 * briefly disagree with the page they control.
 */
export function PreferenceBar({ locale, theme, forceRtl }: PreferenceBarProps) {
  const { t } = useTranslation();
  const router = useRouter();

  const apply = (name: string, value: string) => {
    remember(name, value);
    // A refresh rather than local state: the layout that reads these is a
    // server component, so the server has to render again.
    router.refresh();
  };

  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-border-subtle pb-4 text-sm">
      <label className="flex items-center gap-2">
        <span className="text-content-muted">{t('common.language')}</span>
        <select
          value={locale}
          onChange={(event) => {
            const chosen = event.target.value;
            if (isLocale(chosen)) {
              apply('integr8_locale', chosen);
            }
          }}
          className="rounded-md border border-border-subtle bg-surface px-2 py-1 text-content"
        >
          {LOCALE_DESCRIPTORS.map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.nativeName}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-2">
        <span className="text-content-muted">{t('common.theme.label')}</span>
        <select
          value={theme}
          onChange={(event) => {
            apply('integr8_theme', event.target.value);
          }}
          className="rounded-md border border-border-subtle bg-surface px-2 py-1 text-content"
        >
          <option value="system">{t('common.theme.system')}</option>
          <option value="light">{t('common.theme.light')}</option>
          <option value="dark">{t('common.theme.dark')}</option>
        </select>
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={forceRtl}
          onChange={(event) => {
            apply('integr8_force_rtl', String(event.target.checked));
          }}
        />
        <span className="text-content-muted">{t('common.forceRtl')}</span>
      </label>
    </div>
  );
}
