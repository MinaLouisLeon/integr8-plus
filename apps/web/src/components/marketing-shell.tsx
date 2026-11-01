'use client';

import { isLocale, LOCALE_DESCRIPTORS, useTranslation } from '@integr8/i18n';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LegalLinks } from '~/components/legal-links';
import { Logo } from '~/components/site/logo';
import { Eyebrow, Grain, Magnetic, RevealText } from '~/components/site/motion';
import { LOCALE_COOKIE, rememberCookie } from '~/lib/cookies';
import { recordFunnelStep } from '~/lib/funnel';
import { getStartedHref, signupMode } from '~/lib/signup';

/**
 * The public surface's shell (P18), in the Integr8 Media look (Low 3).
 *
 * Separate from `AuthGuard` and `PlatformShell` because it guards nothing:
 * every page inside it is for somebody with no account, and running a session
 * check for a visitor reading the pricing page is work done to no purpose.
 *
 * It wears the company site's look: `data-look="integr8"` switches the design
 * tokens to its palette and faces (`@integr8/tokens`), and the frame is its
 * frame: a floating rounded bar that slides away while reading down and
 * comes back on the way up, a gradient line along the top for how far down
 * the page is, the film grain, and the lime pill. No preloader, no custom
 * cursor: those belong to a studio's showcase, not a product's front door.
 *
 * It also records the funnel step for whichever page it wraps. Doing it here
 * rather than in each page means a new public page is instrumented by existing,
 * which is the only way instrumentation survives contact with a deadline.
 */

/** The company behind the product, linked from the header and the footer. */
export const INTEGR8_MEDIA_URL = 'https://www.integr8-media.com';

/** The lime and white pills of the company site, and a quiet outline one. */
export function pillClass(
  variant: 'lime' | 'white' | 'outline' = 'lime',
  size: 'md' | 'sm' = 'md',
) {
  const sizing = size === 'sm' ? 'px-4 py-2 text-sm' : 'px-6 py-3 text-sm sm:text-base';
  const colour =
    variant === 'lime'
      ? 'bg-lime text-site-bg hover:scale-105'
      : variant === 'white'
        ? 'bg-site-fg text-site-bg hover:bg-white'
        : 'border border-site-line text-site-fg hover:border-white/30 hover:bg-white/5';
  return `inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap transition duration-200 motion-reduce:hover:scale-100 ${sizing} ${colour}`;
}

const NAV = [
  { href: '/features', key: 'features' },
  { href: '/pricing', key: 'pricing' },
  { href: '/help', key: 'help' },
  { href: '/download', key: 'download' },
] as const;

export function MarketingShell({
  children,
  step,
  width = 'page',
}: {
  children: ReactNode;
  /** Which funnel step this page is. Omitted for pages outside the funnel. */
  step?: 'landing.viewed' | 'features.viewed' | 'pricing.viewed' | 'signup.opened';
  /**
   * `page` centres the content in the site's column with room for the
   * floating bar; `full` leaves the width to the page's own sections (home).
   */
  width?: 'page' | 'full';
}) {
  useEffect(() => {
    if (step !== undefined) {
      recordFunnelStep(step);
    }
  }, [step]);

  return (
    <div data-look="integr8" className="relative flex min-h-dvh flex-col overflow-x-clip">
      <Grain />
      <SiteHeader />
      <main
        id="main"
        className={
          width === 'full'
            ? 'flex-1'
            : 'mx-auto w-full max-w-6xl flex-1 px-4 pt-32 pb-24 sm:px-8 sm:pt-36'
        }
      >
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

/**
 * The frame around the sign-in pages (company people, staff, invitations):
 * the same look and faces, a slim bar with the logo, the way back to
 * Integr8 Media and the language, and the page's own form in the middle.
 * Added by those routes' layouts, so the pages themselves keep their markup.
 */
export function AuthShell({
  children,
  audience = 'people',
}: {
  children: ReactNode;
  /** `staff` labels the bar for Integr8's own sign-in to the dashboard. */
  audience?: 'people' | 'staff';
}) {
  const { t } = useTranslation();

  return (
    <div data-look="integr8" className="relative isolate min-h-dvh overflow-x-clip">
      <Grain />
      <div aria-hidden="true" className="site-grid absolute inset-0 -z-10" />
      <div
        aria-hidden="true"
        className="site-glow -z-10 size-[26rem] bg-violet opacity-25"
        style={{ insetBlockStart: '-8rem', insetInlineStart: '-10rem' }}
      />
      <div
        aria-hidden="true"
        className="site-glow -z-10 size-[22rem] bg-lime opacity-10"
        style={{ insetBlockEnd: '-8rem', insetInlineEnd: '-8rem' }}
      />
      <header className="absolute inset-x-0 top-0 z-10 px-4 pt-4 sm:px-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 rounded-full border border-site-line bg-site-bg/70 py-2.5 ps-5 pe-2.5 backdrop-blur-xl">
          <Logo />
          <div className="flex items-center gap-2">
            <span className="hidden font-mono text-[11px] tracking-[0.15em] text-site-muted uppercase sm:inline rtl:tracking-normal">
              {audience === 'staff' ? t('site.auth.staffEyebrow') : t('site.auth.peopleEyebrow')}
            </span>
            <a
              href={INTEGR8_MEDIA_URL}
              title={t('site.brand.integr8MediaTitle')}
              className="hidden rounded-full px-3 py-2 text-sm text-site-muted transition-colors hover:text-lime md:inline"
            >
              {t('site.brand.byIntegr8Media')} <span aria-hidden="true">↗</span>
            </a>
            <LanguageToggle />
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}

/**
 * The bar along the top: logo, the four pages, the language, sign-in and the
 * lime pill; below `md` a round button opens the same links full screen.
 */
function SiteHeader() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const [hidden, setHidden] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [openOn, setOpenOn] = useState<string | null>(null);
  // Open for the page it was opened on: going anywhere closes it.
  const open = openOn === pathname;
  const progress = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let last = window.scrollY;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const y = window.scrollY;
        const room = document.documentElement.scrollHeight - window.innerHeight;
        if (progress.current !== null) {
          progress.current.style.transform = `scaleX(${room > 0 ? Math.min(1, y / room).toFixed(4) : '0'})`;
        }
        setHidden(y > last && y > 300);
        setScrolled(y > 20);
        last = y;
      });
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const opener = toggle.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenOn(null);
      }
    };
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, [open]);

  return (
    <>
      <div
        aria-hidden="true"
        className="site-progress fixed inset-x-0 top-0 z-[80] h-0.5"
        ref={progress}
      />
      <header
        className={[
          'fixed inset-x-0 top-0 z-[70] px-4 pt-4 transition-transform duration-300 ease-out sm:px-8',
          hidden && !open ? '-translate-y-[120%]' : 'translate-y-0',
        ].join(' ')}
      >
        <nav
          aria-label={t('site.nav.main')}
          className={[
            'mx-auto flex max-w-6xl items-center justify-between gap-3 rounded-full border py-2.5 ps-5 pe-2.5 transition-colors duration-300',
            scrolled || open
              ? 'border-site-line bg-site-bg/70 backdrop-blur-xl'
              : 'border-transparent',
          ].join(' ')}
        >
          <div className="flex min-w-0 items-center gap-4">
            <Logo />
            <a
              href={INTEGR8_MEDIA_URL}
              title={t('site.brand.integr8MediaTitle')}
              className="hidden font-mono text-[11px] tracking-[0.15em] text-site-muted uppercase transition-colors hover:text-lime lg:inline rtl:tracking-normal"
            >
              {t('site.brand.byIntegr8Media')} <span aria-hidden="true">↗</span>
            </a>
          </div>

          <ul className="hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <li key={item.href}>
                <Magnetic strength={0.4}>
                  <Link
                    href={item.href}
                    aria-current={pathname === item.href ? 'page' : undefined}
                    className={[
                      'block rounded-full px-3 py-2 text-sm transition-colors lg:px-4',
                      pathname === item.href
                        ? 'text-site-fg'
                        : 'text-site-muted hover:text-site-fg',
                    ].join(' ')}
                  >
                    {t(`site.nav.${item.key}`)}
                  </Link>
                </Magnetic>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-1.5 sm:gap-2">
            <LanguageToggle />
            <Link
              href="/sign-in"
              className="hidden rounded-full px-3 py-2 text-sm text-site-muted transition-colors hover:text-site-fg lg:block"
            >
              {t('site.nav.signIn')}
            </Link>
            <span className="hidden sm:block">
              <Magnetic>
                <GetStartedLink className={pillClass('lime', 'sm')} short />
              </Magnetic>
            </span>
            <button
              ref={toggle}
              type="button"
              aria-label={open ? t('site.nav.closeMenu') : t('site.nav.menu')}
              aria-expanded={open}
              aria-controls="site-menu"
              onClick={() => setOpenOn(open ? null : pathname)}
              className="flex size-10 flex-col items-center justify-center gap-1.5 rounded-full border border-site-line md:hidden"
            >
              <span
                className={`h-px w-5 bg-site-fg transition-transform duration-300 ${open ? 'translate-y-[3.5px] rotate-45' : ''}`}
              />
              <span
                className={`h-px w-5 bg-site-fg transition-transform duration-300 ${open ? '-translate-y-[3.5px] -rotate-45' : ''}`}
              />
            </button>
          </div>
        </nav>
      </header>

      <div
        id="site-menu"
        inert={!open}
        aria-hidden={!open}
        className={`site-menu fixed inset-0 z-[65] flex flex-col justify-center gap-3 bg-site-soft px-8 md:hidden ${open ? 'is-open' : ''}`}
      >
        {NAV.map((item, index) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpenOn(null)}
            className="site-menu-link font-display text-4xl font-extrabold"
            style={{ transitionDelay: open ? `${(0.2 + index * 0.07).toFixed(2)}s` : '0s' }}
          >
            {t(`site.nav.${item.key}`)}
          </Link>
        ))}
        <Link
          href="/sign-in"
          onClick={() => setOpenOn(null)}
          className="site-menu-link font-display text-4xl font-extrabold text-site-muted"
          style={{ transitionDelay: open ? '0.48s' : '0s' }}
        >
          {t('site.nav.signIn')}
        </Link>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <GetStartedLink className={pillClass('lime')} />
        </div>
        <a
          href={INTEGR8_MEDIA_URL}
          className="mt-6 font-mono text-xs tracking-[0.15em] text-site-muted uppercase rtl:tracking-normal"
        >
          {t('site.brand.byIntegr8Media')} <span aria-hidden="true">↗</span>
        </a>
      </div>
    </>
  );
}

function SiteFooter() {
  const { t } = useTranslation();
  const linkClass = 'text-sm text-site-muted transition-colors hover:text-lime';

  return (
    <footer className="relative border-t border-site-line px-4 py-14 sm:px-8">
      <div className="mx-auto grid max-w-6xl gap-10 sm:grid-cols-2 lg:grid-cols-[1.6fr_1fr_1fr_1fr]">
        <div className="flex flex-col items-start gap-4">
          <Logo />
          <p className="max-w-xs text-sm leading-relaxed text-site-muted">
            {t('site.footer.tagline')}
          </p>
          <a
            href={INTEGR8_MEDIA_URL}
            title={t('site.brand.integr8MediaTitle')}
            className="font-mono text-xs tracking-[0.15em] text-site-fg uppercase transition-colors hover:text-lime rtl:tracking-normal"
          >
            {t('site.brand.byIntegr8Media')} <span aria-hidden="true">↗</span>
          </a>
        </div>

        <nav aria-labelledby="footer-product" className="flex flex-col gap-3">
          <h2
            id="footer-product"
            className="font-mono text-xs tracking-[0.2em] text-site-fg uppercase rtl:tracking-normal"
          >
            {t('site.footer.product')}
          </h2>
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className={linkClass}>
              {t(`site.nav.${item.key}`)}
            </Link>
          ))}
        </nav>

        <nav aria-labelledby="footer-company" className="flex flex-col gap-3">
          <h2
            id="footer-company"
            className="font-mono text-xs tracking-[0.2em] text-site-fg uppercase rtl:tracking-normal"
          >
            {t('site.footer.company')}
          </h2>
          <Link href={getStartedHref()} className={linkClass}>
            {t('marketing.nav.contact')}
          </Link>
          <Link href="/sign-in" className={linkClass}>
            {t('site.nav.signIn')}
          </Link>
          <a href={INTEGR8_MEDIA_URL} className={linkClass}>
            {t('site.brand.integr8Media')}
          </a>
          <Link href="/platform/sign-in" className={linkClass}>
            {t('site.footer.staff')}
          </Link>
        </nav>

        <div className="flex flex-col gap-3">
          <h2 className="font-mono text-xs tracking-[0.2em] text-site-fg uppercase rtl:tracking-normal">
            {t('site.footer.legal')}
          </h2>
          {/* The terms, the privacy policy and the data processing terms (High 10). */}
          <LegalLinks listClassName="flex flex-col gap-3 text-sm text-site-muted" />
        </div>
      </div>

      <div className="mx-auto mt-12 flex max-w-6xl flex-wrap items-center justify-between gap-4 border-t border-site-line pt-6">
        <p className="font-mono text-xs text-site-muted">
          {t('site.footer.copyright', { year: new Date().getFullYear() })}
        </p>
        {/* A visitor reads these pages in either language, the legal ones above all. */}
        <LanguageToggle />
      </div>
    </footer>
  );
}

/**
 * The other language, by its own name: "العربية" on an English page,
 * "English" on an Arabic one. Remembered in the locale cookie, so the choice
 * holds on every later visit; without it every page is English.
 */
export function LanguageToggle({ className = '' }: { className?: string }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const current = i18n.resolvedLanguage ?? i18n.language;
  const other = LOCALE_DESCRIPTORS.find((entry) => entry.code !== current) ?? LOCALE_DESCRIPTORS[0];
  if (other === undefined) {
    return null;
  }

  return (
    <button
      type="button"
      lang={other.code}
      title={t('site.nav.language')}
      onClick={() => {
        if (!isLocale(other.code)) {
          return;
        }
        rememberCookie(LOCALE_COOKIE, other.code);
        void i18n.changeLanguage(other.code);
        router.refresh();
      }}
      className={`rounded-full border border-site-line px-3 py-2 text-sm text-site-fg transition-colors hover:border-lime hover:text-lime ${className}`}
    >
      {other.nativeName}
    </button>
  );
}

/**
 * A page's opening: the eyebrow, a heading whose last words carry the
 * gradient, and a line under it.
 */
export function PageIntro({
  eyebrow,
  title,
  gradient,
  subtitle,
  children,
}: {
  eyebrow: string;
  title: string;
  /** The heading's closing words, in the violet-to-lime gradient. */
  gradient?: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-col items-start pb-12 sm:pb-16">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h1 className="max-w-4xl font-display text-4xl leading-[1.1] font-semibold sm:text-6xl">
        <RevealText text={title} />
        {gradient === undefined ? null : (
          <>
            {' '}
            <span className="text-gradient">
              <RevealText text={gradient} delay={0.15} />
            </span>
          </>
        )}
      </h1>
      {subtitle === undefined ? null : (
        <p className="mt-6 max-w-2xl text-base leading-relaxed text-site-muted sm:text-lg">
          {subtitle}
        </p>
      )}
      {children}
    </header>
  );
}

/**
 * The one button every public page ends with.
 *
 * With public sign-up open it starts a trial; with it off — the default, since
 * Integr8 sets companies up — it goes to the contact page. One component, so
 * no page can keep offering a form the API refuses.
 */
export function GetStartedLink({
  className,
  short = false,
}: {
  className?: string;
  short?: boolean;
}) {
  const { t } = useTranslation();
  const open = signupMode() === 'open';

  return (
    <Link href={getStartedHref()} className={className ?? pillClass('lime')}>
      {short
        ? open
          ? t('marketing.nav.signUp')
          : t('marketing.nav.contact')
        : open
          ? t('marketing.hero.cta')
          : t('marketing.hero.ctaClosed')}
      {short ? null : (
        <span aria-hidden="true" className="inline-block rtl:-scale-x-100">
          →
        </span>
      )}
    </Link>
  );
}
