'use client';

import { LEGAL_DOCUMENTS, legalPath } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import Link from 'next/link';

/**
 * The three legal pages, as a row of links (High 10): in the public footer,
 * under the sign-in form and on the sign-up pages. The app stores and Egypt's
 * data protection law both expect the privacy policy to be one click away
 * from anywhere somebody hands over their details.
 */
export function LegalLinks({ className }: { className?: string }) {
  const { t } = useTranslation();

  return (
    <nav aria-label={t('legal.nav')} className={className}>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-content-muted">
        {LEGAL_DOCUMENTS.map((document) => (
          <li key={document}>
            <Link href={legalPath(document)} className="hover:text-content hover:underline">
              {t(`legal.documents.${document}`)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
