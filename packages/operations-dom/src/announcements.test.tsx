import { ar, en } from '@integr8/i18n';
import { act, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Announcement,
  AnnouncementBanners,
  announcementDirection,
  announcementText,
  DISMISSED_ANNOUNCEMENTS_KEY,
  liveAnnouncements,
} from './announcements.js';
import { accessibilityViolations, fakeApi, renderScreen } from './testing/render.js';

/**
 * Integr8's banners on the web and desktop screens (P15): in the reader's
 * language, most severe first, said in words as well as colour, dismissed on
 * this device only, and never leaving keyboard focus nowhere.
 */

const MAINTENANCE = '00000000-0000-4000-8000-000000000a01';
const REMINDER = '00000000-0000-4000-8000-000000000a02';
const PINNED = '00000000-0000-4000-8000-000000000a03';

function announcement(overrides: Partial<Announcement> & { id: string }): Announcement {
  return {
    severity: 'info',
    message: { en: 'Something to know.' },
    dismissible: true,
    startsAt: '2026-10-30T08:00:00.000Z',
    endsAt: null,
    ...overrides,
  };
}

function show(announcements: Announcement[] | undefined, locale: 'en' | 'ar' = 'en') {
  const { client } = fakeApi({});
  return renderScreen(
    <>
      <AnnouncementBanners announcements={announcements} />
      <main>
        <h1>The page</h1>
      </main>
    </>,
    client,
    { locale },
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('announcement banners', () => {
  it('shows nothing until /v1/me has answered, and nothing when there is nothing', () => {
    const { container, rerender } = show(undefined);
    expect(container.querySelector('section')).toBeNull();
    rerender(<AnnouncementBanners announcements={[]} />);
    expect(container.querySelector('section')).toBeNull();
  });

  it('puts the critical one first, as an alert, and says each severity in words', async () => {
    const { container } = show([
      announcement({ id: MAINTENANCE, message: { en: 'Maintenance on Friday night.' } }),
      announcement({
        id: REMINDER,
        severity: 'critical',
        message: { en: 'Your payment is overdue.' },
      }),
    ]);

    const region = screen.getByRole('region', { name: en.workspace.announcement.region });
    const alert = within(region).getByRole('alert');
    expect(alert).toHaveTextContent(en.workspace.announcement.critical);
    expect(alert).toHaveTextContent('Your payment is overdue.');
    const status = within(region).getByRole('status');
    expect(status).toHaveTextContent(en.workspace.announcement.info);
    expect(status).toHaveTextContent('Maintenance on Friday night.');
    expect(alert.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('shows the Arabic message on an Arabic screen, and English marked as English when that is all there is', () => {
    show(
      [
        announcement({
          id: MAINTENANCE,
          severity: 'warning',
          message: { en: 'Maintenance tonight.', ar: 'صيانة الليلة.' },
        }),
        announcement({ id: REMINDER, message: { en: 'Only in English.' } }),
      ],
      'ar',
    );

    const region = screen.getByRole('region', { name: ar.workspace.announcement.region });
    expect(region).toHaveTextContent('صيانة الليلة.');
    expect(region).not.toHaveTextContent('Maintenance tonight.');
    expect(region).toHaveTextContent(ar.workspace.announcement.warning);
    const english = screen.getByText('Only in English.');
    expect(english).toHaveAttribute('lang', 'en');
    expect(english).toHaveAttribute('dir', 'ltr');
    expect(screen.getByText('صيانة الليلة.')).toHaveAttribute('dir', 'rtl');
    expect(screen.getAllByRole('button', { name: ar.workspace.announcement.dismiss })).toHaveLength(
      2,
    );
  });

  it('forgets a dismissed banner on this device, for good, and moves focus to the next one', async () => {
    const user = userEvent.setup();
    const list = [
      announcement({ id: MAINTENANCE, message: { en: 'First.' } }),
      announcement({ id: REMINDER, message: { en: 'Second.' } }),
    ];
    const first = show(list);

    const [dismissFirst] = screen.getAllByRole('button', {
      name: en.workspace.announcement.dismiss,
    });
    expect(dismissFirst).toHaveAccessibleDescription('First.');
    await user.click(dismissFirst!);

    expect(screen.queryByText('First.')).toBeNull();
    expect(screen.getByRole('status')).toHaveFocus();
    expect(JSON.parse(window.localStorage.getItem(DISMISSED_ANNOUNCEMENTS_KEY) ?? '[]')).toEqual([
      MAINTENANCE,
    ]);

    first.unmount();
    show(list);
    expect(screen.queryByText('First.')).toBeNull();
    expect(screen.getByText('Second.')).toBeInTheDocument();
  });

  it('sends focus to the page once the last banner is dismissed', async () => {
    const user = userEvent.setup();
    show([announcement({ id: MAINTENANCE })]);

    await user.click(screen.getByRole('button', { name: en.workspace.announcement.dismiss }));

    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('keeps a banner staff made permanent, with no button, whatever this device remembers', () => {
    window.localStorage.setItem(DISMISSED_ANNOUNCEMENTS_KEY, JSON.stringify([PINNED]));
    show([announcement({ id: PINNED, dismissible: false, message: { en: 'Read this.' } })]);

    expect(screen.getByText('Read this.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows every banner when the remembered list is unreadable', () => {
    window.localStorage.setItem(DISMISSED_ANNOUNCEMENTS_KEY, '{not json');
    show([announcement({ id: MAINTENANCE, message: { en: 'Still here.' } })]);
    expect(screen.getByText('Still here.')).toBeInTheDocument();
  });

  it('takes a banner down when it ends, without asking the server again', () => {
    vi.useFakeTimers({ now: new Date('2026-10-31T10:00:00.000Z') });
    show([
      announcement({
        id: REMINDER,
        message: { en: 'Until eleven.' },
        endsAt: '2026-10-31T11:00:00.000Z',
      }),
      announcement({
        id: MAINTENANCE,
        message: { en: 'Already over.' },
        endsAt: '2026-10-31T09:00:00.000Z',
      }),
    ]);

    expect(screen.getByText('Until eleven.')).toBeInTheDocument();
    expect(screen.queryByText('Already over.')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(60 * 60 * 1000);
    });
    expect(screen.queryByText('Until eleven.')).toBeNull();
  });
});

describe('choosing the words', () => {
  it('prefers the exact tag, then the base language, then English, then anything', () => {
    expect(announcementText({ en: 'Hello', 'ar-EG': 'أهلًا' }, 'ar-EG')).toEqual({
      text: 'أهلًا',
      lang: 'ar-EG',
    });
    expect(announcementText({ en: 'Hello', ar: 'مرحبًا' }, 'ar-EG')).toEqual({
      text: 'مرحبًا',
      lang: 'ar',
    });
    expect(announcementText({ en: 'Hello' }, 'ar')).toEqual({ text: 'Hello', lang: 'en' });
    expect(announcementText({ fr: 'Bonjour' }, 'ar')).toEqual({ text: 'Bonjour', lang: 'fr' });
    expect(announcementText({ ar: '  ', en: 'Hello' }, 'ar')).toEqual({
      text: 'Hello',
      lang: 'en',
    });
  });

  it('lays a message out in its own language’s direction, not by its first letter', () => {
    expect(announcementDirection('ar')).toBe('rtl');
    expect(announcementDirection('ar-EG')).toBe('rtl');
    expect(announcementDirection('en')).toBe('ltr');
    expect(announcementDirection(undefined)).toBe('auto');
  });

  it('drops empty and ended banners, and orders by severity then the server’s order', () => {
    const now = Date.parse('2026-10-31T10:00:00.000Z');
    const live = liveAnnouncements(
      [
        announcement({ id: 'a', severity: 'info' }),
        announcement({ id: 'b', severity: 'warning' }),
        announcement({ id: 'c', severity: 'info', message: { en: ' ' } }),
        announcement({ id: 'd', severity: 'critical', endsAt: '2026-10-31T10:00:00.000Z' }),
        announcement({ id: 'e', severity: 'info' }),
        announcement({ id: 'f', severity: 'critical' }),
      ],
      new Set(['e']),
      now,
    );
    expect(live.map((item) => item.id)).toEqual(['f', 'b', 'a']);
  });
});
