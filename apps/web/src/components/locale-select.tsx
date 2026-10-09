'use client';

import { isLocale, LOCALE_DESCRIPTORS, useTranslation } from '@integr8/i18n';
import { useRouter } from 'next/navigation';
import { LOCALE_COOKIE, rememberCookie } from '~/lib/cookies';

/**
 * The language, chosen from the menu's footer.
 *
 * A cookie and a refresh rather than local state: `<html lang dir>` is rendered
 * by a server layout, so the server has to see the choice to mirror the page.
 * The instance is switched too, so the words change before the refresh lands
 * rather than a beat after it.
 *
 * `compact` is the collapsed menu: the select shrinks to the language code,
 * which is the one abbreviation every reader of that language recognises.
 */
export function LocaleSelect({ compact = false }: { compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const current = i18n.resolvedLanguage ?? i18n.language;

  return (
    <select
      value={isLocale(current) ? current : 'en'}
      aria-label={t('common.language')}
      title={compact ? t('common.language') : undefined}
      onChange={(event) => {
        const chosen = event.target.value;
        if (!isLocale(chosen)) {
          return;
        }
        rememberCookie(LOCALE_COOKIE, chosen);
        void i18n.changeLanguage(chosen);
        router.refresh();
      }}
      className={[
        'rounded-md border border-shell-border bg-shell text-sm text-shell-text',
        'hover:bg-shell-hover',
        compact ? 'w-full px-1 py-1.5 text-center uppercase' : 'w-full px-2 py-1.5',
      ].join(' ')}
    >
      {LOCALE_DESCRIPTORS.map((entry) => (
        <option key={entry.code} value={entry.code}>
          {compact ? entry.code : entry.nativeName}
        </option>
      ))}
    </select>
  );
}
