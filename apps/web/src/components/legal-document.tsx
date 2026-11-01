'use client';

import {
  LEGAL_DOCUMENTS,
  LEGAL_LAST_UPDATED,
  LEGAL_REVIEWED,
  legalPath,
  type LegalDocument,
} from '@integr8/core';
import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import Link from 'next/link';
import { MarketingShell } from '~/components/marketing-shell';
import { legalSections, operatorRows, parseLegalBody } from '~/lib/legal';

/**
 * One legal page: the terms of service, the privacy policy or the data
 * processing terms (High 10).
 *
 * Public and plain: a heading per section with an anchor, a list of them at
 * the top, and the operator's details at the end, leaving out any still to be
 * filled in rather than printing a blank. While the texts await a lawyer's
 * review the page says so under the date, because a policy that claims to be
 * final when it is not is the one thing these pages must not do.
 */
export function LegalDocumentPage({ document }: { document: LegalDocument }) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const locale = language === 'ar' ? 'ar' : 'en';
  const sections = legalSections(document, t);

  return (
    <MarketingShell>
      <article aria-labelledby="legal-title" className="mx-auto flex max-w-3xl flex-col gap-10">
        <header className="flex flex-col gap-4">
          {/* The other two documents. A list, not a second navigation landmark: the footer's is the one named "Legal". */}
          <ul className="flex flex-wrap gap-2 text-sm">
            {LEGAL_DOCUMENTS.map((other) => (
              <li key={other}>
                <Link
                  href={legalPath(other)}
                  aria-current={other === document ? 'page' : undefined}
                  className={[
                    'inline-flex rounded-full px-4 py-1.5',
                    other === document
                      ? 'bg-accent-subtle font-medium text-content'
                      : 'text-content-muted hover:bg-surface-muted hover:text-content',
                  ].join(' ')}
                >
                  {t(`legal.documents.${other}`)}
                </Link>
              </li>
            ))}
          </ul>
          <h1
            id="legal-title"
            className="font-display text-4xl leading-tight font-semibold text-content sm:text-5xl"
          >
            {t(`legal.documents.${document}`)}
          </h1>
          <p className="text-sm text-content-muted">
            {t('legal.lastUpdated', { date: formatCalendarDate(LEGAL_LAST_UPDATED, { locale }) })}
          </p>
          <p className="text-lg text-content-muted">{t(`legal.${document}.summary`)}</p>
          {LEGAL_REVIEWED ? null : (
            <p
              role="note"
              className="rounded-md border border-warning bg-warning-subtle px-3 py-2 text-sm text-content"
            >
              {t('legal.underReview')}
            </p>
          )}
        </header>

        <nav aria-labelledby="legal-contents" className="flex flex-col gap-2">
          <h2 id="legal-contents" className="text-sm font-semibold text-content">
            {t('legal.contents')}
          </h2>
          <ol className="flex list-decimal flex-col gap-1 ps-5 text-sm text-content-muted">
            {sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="hover:text-content hover:underline">
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        {sections.map((section) => (
          <section
            key={section.id}
            id={section.id}
            aria-labelledby={`${section.id}-title`}
            className="flex scroll-mt-28 flex-col gap-3"
          >
            <h2
              id={`${section.id}-title`}
              className="font-display text-xl font-semibold text-content"
            >
              {section.title}
            </h2>
            {parseLegalBody(section.body).map((block, blockIndex) =>
              block.kind === 'paragraph' ? (
                <p key={blockIndex} className="max-w-prose leading-relaxed text-content-muted">
                  {block.text}
                </p>
              ) : (
                <ul
                  key={blockIndex}
                  className="flex max-w-prose list-disc flex-col gap-1.5 ps-6 leading-relaxed text-content-muted"
                >
                  {block.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ),
            )}
          </section>
        ))}

        <section
          aria-labelledby="legal-operator"
          className="flex flex-col gap-3 rounded-3xl border border-border-subtle bg-surface p-7"
        >
          <h2 id="legal-operator" className="text-lg font-semibold text-content">
            {t('legal.operator.title')}
          </h2>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
            {operatorRows().map((row) => (
              <div key={row.key} className="contents">
                <dt className="font-medium text-content">{t(`legal.operator.${row.key}`)}</dt>
                <dd className="text-content-muted">
                  {row.key === 'email' ? (
                    <a
                      href={`mailto:${row.value}`}
                      dir="ltr"
                      className="text-accent hover:underline"
                    >
                      {row.value}
                    </a>
                  ) : (
                    row.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </article>
    </MarketingShell>
  );
}
