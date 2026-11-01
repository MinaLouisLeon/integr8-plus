'use client';

import { useTranslation } from '@integr8/i18n';
import { integr8Fonts } from '@integr8/tokens';
import Link from 'next/link';

/**
 * The product's mark in the Integr8 Media style: "Integr" and a lime "8" that
 * turns on hover, then "PLUS" spaced out where the company site says "MEDIA".
 *
 * A mark, not a sentence: it is drawn the same in both languages, left to
 * right and in the Latin faces, and its accessible name is the translated one.
 */
export function Logo({
  href = '/',
  label,
  className = '',
}: {
  href?: string;
  /** The link's name; the product's home by default. */
  label?: string;
  className?: string;
}) {
  const { t } = useTranslation();

  return (
    <Link
      href={href}
      aria-label={label ?? t('site.brand.home')}
      dir="ltr"
      className={`group inline-flex items-center text-lg font-extrabold text-site-fg ${className}`}
      style={{ fontFamily: integr8Fonts.display }}
    >
      <LogoMark />
    </Link>
  );
}

/** The mark's letters alone, for places that wrap it in something other than a link. */
export function LogoMark({ compact = false }: { compact?: boolean }) {
  return (
    <span aria-hidden="true" dir="ltr" className="inline-flex items-center">
      {compact ? null : 'Integr'}
      <span className="inline-block text-lime transition-transform duration-500 group-hover:rotate-90">
        8
      </span>
      {compact ? null : (
        <span
          className="ms-1.5 text-xs font-medium tracking-[0.3em] text-site-muted"
          style={{ fontFamily: integr8Fonts.body }}
        >
          PLUS
        </span>
      )}
    </span>
  );
}
