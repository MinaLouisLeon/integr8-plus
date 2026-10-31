import { useTranslation } from '@integr8/i18n';
import { useEffect, useId, useRef, useState } from 'react';

/**
 * Banners from Integr8, at the top of every signed-in screen (P15).
 *
 * Staff post them from the platform dashboard, and dunning posts its payment
 * reminders the same way. `GET /v1/me` already carries the ones live for this
 * company, so the web shell and the desktop frame hand over what they have
 * rather than either growing a poll of its own.
 *
 * - **The severity is said, not only coloured.** Each banner carries a visible
 *   word as well as its colour. A critical one is an alert, so a screen reader
 *   interrupts with it; the others are polite status messages.
 * - **The message is in the reader's language when there is one.** Staff write
 *   English today, so an Arabic screen often shows English: the text carries
 *   its own `lang` and the direction of that language, so it is read and laid
 *   out as English rather than mirrored into nonsense.
 * - **Dismissing is per device.** The ids of dismissed banners are remembered
 *   in `localStorage` and nothing else is: an id says nothing about anybody,
 *   and a dismissal that came back on the next page would be a banner people
 *   learn to click past. A banner staff marked as not dismissible has no
 *   button, and no remembered id hides it.
 * - **Focus is never dropped.** Closing one moves focus to the next banner, or
 *   to the page's main content when none is left, so a keyboard user is not
 *   sent back to the top of the document.
 * - **An ended banner goes when it ends**, not when `/v1/me` is next fetched:
 *   the desktop app stays open for days.
 */

export interface Announcement {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  /** By language tag. */
  message: Readonly<Record<string, string>>;
  dismissible: boolean;
  startsAt: string;
  endsAt: string | null;
}

/** Where dismissals are remembered, on this device only. */
export const DISMISSED_ANNOUNCEMENTS_KEY = 'integr8.announcements.dismissed';

/**
 * How many dismissals are remembered. Announcements end, and their ids are
 * never reused, so only the recent ones can still matter; dunning posts one
 * every three days, and a few years of those fit.
 */
const REMEMBERED = 200;

/** `setTimeout` takes a signed 32-bit delay; anything longer fires at once. */
const LONGEST_WAIT_MS = 2_147_483_647;

const SEVERITY_ORDER: Record<Announcement['severity'], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const TONE: Record<Announcement['severity'], string> = {
  info: 'border-accent bg-accent-subtle',
  warning: 'border-warning bg-warning-subtle',
  critical: 'border-danger bg-danger-subtle',
};

// The word on a plain surface, so it reads in both themes; the colour is in
// the border, which carries no text.
const BADGE: Record<Announcement['severity'], string> = {
  info: 'border-accent',
  warning: 'border-warning',
  critical: 'border-danger',
};

/** Languages written right to left, among those a message might be tagged with. */
const RIGHT_TO_LEFT = new Set(['ar', 'fa', 'he', 'ur']);

/**
 * The direction of a message's own language. From the tag rather than `auto`,
 * because `auto` follows the first letter, and an Arabic message that opens
 * with a product name in Latin letters would be laid out left to right.
 */
export function announcementDirection(lang: string | undefined): 'ltr' | 'rtl' | 'auto' {
  if (lang === undefined) {
    return 'auto';
  }
  return RIGHT_TO_LEFT.has(lang.split('-')[0]?.toLowerCase() ?? '') ? 'rtl' : 'ltr';
}

/**
 * The text to show, and the language it is in: the reader's exact tag, then
 * its base language, then English, then whatever is there.
 */
export function announcementText(
  message: Readonly<Record<string, string>>,
  locale: string,
): { text: string; lang: string | undefined } {
  const base = locale.split('-')[0] ?? locale;
  for (const tag of [locale, base, 'en']) {
    const text = message[tag];
    if (text !== undefined && text.trim() !== '') {
      return { text, lang: tag };
    }
  }
  const first = Object.entries(message).find(([, text]) => text.trim() !== '');
  return first === undefined ? { text: '', lang: undefined } : { text: first[1], lang: first[0] };
}

/**
 * What is on show now: not ended, not dismissed here (unless it may not be),
 * not empty; the most severe first, otherwise in the server's order.
 */
export function liveAnnouncements(
  announcements: readonly Announcement[],
  dismissed: ReadonlySet<string>,
  now: number,
): Announcement[] {
  return announcements
    .filter((announcement) => {
      if (announcement.dismissible && dismissed.has(announcement.id)) {
        return false;
      }
      if (announcement.endsAt !== null && Date.parse(announcement.endsAt) <= now) {
        return false;
      }
      return Object.values(announcement.message).some((text) => text.trim() !== '');
    })
    .map((announcement, index) => ({ announcement, index }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.announcement.severity] - SEVERITY_ORDER[b.announcement.severity] ||
        a.index - b.index,
    )
    .map(({ announcement }) => announcement);
}

/** The dismissals this device remembers. A blocked or garbled store is an empty one. */
export function readDismissedAnnouncements(): string[] {
  try {
    const raw = window.localStorage.getItem(DISMISSED_ANNOUNCEMENTS_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    // Private browsing, storage blocked by policy, or no window at all while
    // the web app renders on the server. Every banner shows, which is the safe
    // way to be wrong.
    return [];
  }
}

function rememberDismissedAnnouncements(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(DISMISSED_ANNOUNCEMENTS_KEY, JSON.stringify(ids));
  } catch {
    // The dismissal lasts until the page is reloaded, and no longer.
  }
}

/** The page's main content, made focusable for the moment it receives focus. */
function focusMainContent(): void {
  const main = document.querySelector<HTMLElement>('main');
  if (main === null) {
    return;
  }
  if (!main.hasAttribute('tabindex')) {
    main.setAttribute('tabindex', '-1');
  }
  main.focus({ preventScroll: true });
}

const MAIN = Symbol('main');

export function AnnouncementBanners({
  announcements,
  className,
}: {
  /** From `/v1/me`; undefined until it has answered. */
  announcements: readonly Announcement[] | undefined;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const ids = useId();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const [dismissed, setDismissed] = useState<readonly string[]>(readDismissedAnnouncements);
  const [now, setNow] = useState(() => Date.now());
  const banners = useRef(new Map<string, HTMLDivElement>());
  const focusNext = useRef<string | typeof MAIN | null>(null);

  const visible = liveAnnouncements(announcements ?? [], new Set(dismissed), now);

  // The next moment a banner on show ends: the clock is moved on then, so it
  // goes without anybody fetching `/v1/me` again.
  const nextEnd = visible.reduce<number | undefined>((soonest, announcement) => {
    if (announcement.endsAt === null) {
      return soonest;
    }
    const ends = Date.parse(announcement.endsAt);
    return soonest === undefined || ends < soonest ? ends : soonest;
  }, undefined);

  useEffect(() => {
    if (nextEnd === undefined) {
      return;
    }
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(Math.max(nextEnd - now, 0), LONGEST_WAIT_MS),
    );
    return () => clearTimeout(timer);
  }, [nextEnd, now]);

  useEffect(() => {
    const target = focusNext.current;
    if (target === null) {
      return;
    }
    focusNext.current = null;
    if (target === MAIN) {
      focusMainContent();
    } else {
      banners.current.get(target)?.focus();
    }
  });

  const dismiss = (id: string) => {
    const index = visible.findIndex((announcement) => announcement.id === id);
    focusNext.current = (visible[index + 1] ?? visible[index - 1])?.id ?? MAIN;
    const next = [...dismissed.filter((kept) => kept !== id), id].slice(-REMEMBERED);
    rememberDismissedAnnouncements(next);
    setDismissed(next);
  };

  if (visible.length === 0) {
    return null;
  }

  return (
    <section
      aria-label={t('workspace.announcement.region')}
      className={['flex flex-col gap-2 print:hidden', className ?? ''].join(' ')}
    >
      {visible.map((announcement) => {
        const { text, lang } = announcementText(announcement.message, locale);
        const messageId = `${ids}-${announcement.id}`;
        return (
          <div
            key={announcement.id}
            ref={(element) => {
              if (element === null) {
                banners.current.delete(announcement.id);
              } else {
                banners.current.set(announcement.id, element);
              }
            }}
            role={announcement.severity === 'critical' ? 'alert' : 'status'}
            tabIndex={-1}
            className={`flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md border border-s-4 px-4 py-3 text-start text-sm text-content ${TONE[announcement.severity]}`}
          >
            <span
              className={`shrink-0 rounded border bg-surface px-2 py-0.5 text-xs font-semibold text-content ${BADGE[announcement.severity]}`}
            >
              {t(`workspace.announcement.${announcement.severity}`)}
            </span>
            <p
              id={messageId}
              lang={lang}
              dir={announcementDirection(lang)}
              className="min-w-0 flex-1 whitespace-pre-line"
            >
              {text}
            </p>
            {announcement.dismissible ? (
              <button
                type="button"
                aria-describedby={messageId}
                onClick={() => dismiss(announcement.id)}
                className="shrink-0 rounded-md px-2 py-0.5 text-sm font-medium text-content underline-offset-4 hover:underline"
              >
                {t('workspace.announcement.dismiss')}
              </button>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
