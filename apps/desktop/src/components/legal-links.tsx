import { LEGAL_DOCUMENTS, legalUrl } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';

/**
 * The terms, the privacy policy and the data processing terms, under the
 * sign-in form (High 10).
 *
 * They are pages on the operator's website, not screens in this app: one text,
 * kept in one place, that the desktop and phone apps and the store listings all
 * point at. Opened outside the app window the way every other outside page is
 * here, as a new-window link, so the sign-in screen stays where it was.
 */
export function LegalLinks() {
  const { t } = useTranslation();

  return (
    <nav aria-label={t('legal.nav')}>
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm text-content-muted">
        {LEGAL_DOCUMENTS.map((document) => (
          <li key={document}>
            <a
              href={legalUrl(document)}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-content hover:underline"
            >
              {t(`legal.documents.${document}`)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
