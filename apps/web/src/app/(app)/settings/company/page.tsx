'use client';

import { ApiRequestError } from '@integr8/api-client';
import { apiMediaAdapter } from '@integr8/form-renderer-dom/screens';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Button, ErrorState, Field, LoadingState } from '~/components/ui';
import { checkLogo, LOGO_MAX_BYTES, LOGO_TYPES } from '~/lib/logo';
import { formatBytes } from '~/lib/platform-format';
import { apiClient } from '~/lib/session';

/**
 * How this company works (P18).
 *
 * Branding, where they are, and when they work. Two details worth knowing:
 *
 * - **Hours are minutes from midnight, not times.** A time plus arithmetic
 *   across a daylight change is where this goes wrong, so the wire format is a
 *   number and only this form turns it into `08:00`.
 * - **The timezone list comes from the browser.** `Intl.supportedValuesOf`
 *   knows every zone this runtime has, which is the same question the API asks
 *   of its own runtime when it validates. A hand-maintained list would be wrong
 *   within a year.
 * - **The logo saves itself, outside the form.** It goes through the same
 *   three-step media upload a photo does, and the id is written to the
 *   settings the moment the upload confirms — not when "Save settings" is
 *   pressed. A file uploaded and then abandoned by closing the tab would
 *   otherwise sit in metered storage pointed at by nothing.
 */

const DAYS = [
  { value: 1, key: 'mon' },
  { value: 2, key: 'tue' },
  { value: 3, key: 'wed' },
  { value: 4, key: 'thu' },
  { value: 5, key: 'fri' },
  { value: 6, key: 'sat' },
  { value: 7, key: 'sun' },
] as const;

/** `480` to `08:00`, for an `<input type="time">`. */
function toTime(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function toMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function timezones(): string[] {
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.('timeZone');
    return supported ?? ['UTC'];
  } catch {
    return ['UTC'];
  }
}

interface Settings {
  logoMediaId: string | null;
  brandColour: string | null;
  timezone: string;
  currency: string;
  locale: string;
  workDayStarts: number;
  workDayEnds: number;
  workingDays: number[];
}

export default function CompanySettingsPage() {
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/settings');
      return data;
    },
  });

  if (settings.isPending) {
    return <LoadingState />;
  }

  if (settings.isError || settings.data === undefined) {
    return (
      <ErrorState
        requestId={settings.error instanceof ApiRequestError ? settings.error.requestId : undefined}
        onRetry={() => void settings.refetch()}
      />
    );
  }

  // The form is a separate component that takes the loaded settings as props,
  // so every field initialises from them once. Seeding state inside an effect
  // instead would re-run on every refetch and fight whoever was typing.
  return <SettingsForm initial={settings.data} />;
}

function SettingsForm({ initial }: { initial: Settings }) {
  const { t } = useTranslation();
  const queries = useQueryClient();

  const [brandColour, setBrandColour] = useState(initial.brandColour ?? '');
  const [timezone, setTimezone] = useState(initial.timezone);
  const [currency, setCurrency] = useState(initial.currency);
  const [locale, setLocale] = useState(initial.locale);
  const [startsAt, setStartsAt] = useState(toTime(initial.workDayStarts));
  const [endsAt, setEndsAt] = useState(toTime(initial.workDayEnds));
  const [days, setDays] = useState<number[]>(initial.workingDays);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const save = useMutation({
    mutationFn: async () => {
      await apiClient().PATCH('/v1/settings', {
        body: {
          brandColour: brandColour.trim() === '' ? null : brandColour.trim(),
          timezone,
          currency: currency.toUpperCase(),
          locale,
          workDayStarts: toMinutes(startsAt),
          workDayEnds: toMinutes(endsAt),
          workingDays: [...days].sort((a, b) => a - b),
        },
      });
    },
    onSuccess: () => {
      setSaved(true);
      setError(undefined);
      void queries.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (failure) => {
      setSaved(false);
      setError(
        failure instanceof ApiRequestError && failure.code === 'unknown_timezone'
          ? t('workspace.settings.unknownTimezone')
          : t('errors.unexpected'),
      );
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    save.mutate();
  };

  return (
    <main className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('workspace.settings.title')}</h1>
        <p className="text-sm text-content-muted">{t('workspace.settings.subtitle')}</p>
      </header>

      <form onSubmit={submit} className="flex max-w-xl flex-col gap-8" noValidate>
        <section className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-content">
            {t('workspace.settings.branding')}
          </h2>
          <LogoSection logoMediaId={initial.logoMediaId} />
          <Field
            label={t('workspace.settings.brandColour')}
            hint={t('workspace.settings.brandColourHint')}
            placeholder="#1D4ED8"
            maxLength={7}
            value={brandColour}
            onChange={(event) => setBrandColour(event.target.value)}
          />
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-content">{t('workspace.settings.place')}</h2>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-content">{t('workspace.settings.timezone')}</span>
            <select
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-content"
            >
              {timezones().map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
            <span className="text-xs text-content-muted">
              {t('workspace.settings.timezoneHint')}
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t('workspace.settings.currency')}
              maxLength={3}
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            />
            <Field
              label={t('workspace.settings.locale')}
              maxLength={12}
              value={locale}
              onChange={(event) => setLocale(event.target.value)}
            />
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-content">{t('workspace.settings.hours')}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t('workspace.settings.dayStarts')}
              type="time"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
            />
            <Field
              label={t('workspace.settings.dayEnds')}
              type="time"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
              {...(error === undefined ? {} : { error })}
            />
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-content">
              {t('workspace.settings.workingDays')}
            </legend>
            <div className="flex flex-wrap gap-2">
              {DAYS.map((day) => (
                <label
                  key={day.value}
                  className="flex items-center gap-2 rounded-md border border-border-subtle px-3 py-1.5 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={days.includes(day.value)}
                    onChange={(event) =>
                      setDays((current) =>
                        event.target.checked
                          ? [...current, day.value]
                          : current.filter((value) => value !== day.value),
                      )
                    }
                  />
                  {t(`workspace.settings.days.${day.key}`)}
                </label>
              ))}
            </div>
            {days.length === 0 ? (
              // Allowed, and worth saying out loud rather than silently
              // accepting: a company with no working days is closed.
              <p className="text-sm text-warning">{t('workspace.settings.closed')}</p>
            ) : null}
          </fieldset>
        </section>

        <div className="flex items-center gap-3">
          <Button type="submit" busy={save.isPending}>
            {t('workspace.settings.save')}
          </Button>
          {saved ? (
            <span role="status" className="text-sm text-content-muted">
              {t('workspace.settings.saved')}
            </span>
          ) : null}
        </div>
      </form>
    </main>
  );
}

/**
 * The company's logo: shown, replaced, removed.
 *
 * The upload is `apiMediaAdapter`, the same code that uploads a photo from a
 * form, so a logo is metered, thumbnailed and purged like any other file. What
 * is this screen's own is the gate in front of it — type and size, checked
 * before a byte is sent — and writing the id to the settings afterwards.
 */
function LogoSection({ logoMediaId }: { logoMediaId: string | null }) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'problem'; text: string } | null>(null);

  // The link to the current logo expires in five minutes; asking again a little
  // before that keeps the image from breaking under somebody reading the page.
  const link = useQuery({
    queryKey: ['settings', 'logo', logoMediaId],
    enabled: logoMediaId !== null,
    staleTime: 4 * 60 * 1000,
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/media/{mediaId}', {
        params: { path: { mediaId: logoMediaId ?? '' } },
      });
      return data?.url ?? null;
    },
  });

  const save = useMutation({
    mutationFn: async (file: File | null) => {
      let next: string | null = null;
      if (file !== null) {
        const stored = await apiMediaAdapter(apiClient()).upload(file, { contentType: file.type });
        next = stored.mediaId;
      }
      await apiClient().PATCH('/v1/settings', { body: { logoMediaId: next } });

      // The previous logo is now pointed at by nothing. Deleting it is a
      // courtesy to the company's storage allowance, not a requirement, so a
      // refusal — somebody else uploaded it, say — is not a failure here.
      if (logoMediaId !== null && logoMediaId !== next) {
        await apiClient()
          .DELETE('/v1/media/{mediaId}', { params: { path: { mediaId: logoMediaId } } })
          .catch(() => undefined);
      }
      return next;
    },
    onSuccess: (next) => {
      setNotice({
        kind: 'ok',
        text:
          next === null ? t('workspace.settings.logoRemoved') : t('workspace.settings.logoSaved'),
      });
      void queries.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: () => {
      setNotice({ kind: 'problem', text: t('workspace.settings.logoFailed') });
    },
  });

  const max = formatBytes(LOGO_MAX_BYTES);

  const chosen = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared so choosing the same file again, after fixing a problem, fires.
    event.target.value = '';
    if (file === undefined) {
      return;
    }
    const problem = checkLogo(file);
    if (problem !== null) {
      setNotice({
        kind: 'problem',
        text:
          problem === 'wrong_type'
            ? t('workspace.settings.logoWrongType')
            : t('workspace.settings.logoTooLarge', { max }),
      });
      return;
    }
    setNotice(null);
    save.mutate(file);
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-content">{t('workspace.settings.logo')}</span>
      <div className="flex flex-wrap items-center gap-4">
        {logoMediaId !== null && typeof link.data === 'string' ? (
          // A plain <img>: the source is a signed link that expires, which
          // Next's image optimiser would try to fetch and cache on the server.
          <img
            src={link.data}
            alt={t('workspace.settings.logoAlt')}
            className="h-16 w-16 rounded-md border border-border-subtle bg-surface object-contain"
          />
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-border-subtle p-1 text-center text-xs text-content-muted">
            {logoMediaId === null ? t('workspace.settings.logoNone') : ''}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <input
              ref={input}
              type="file"
              accept={LOGO_TYPES.join(',')}
              className="sr-only"
              aria-label={t('workspace.settings.logoChoose')}
              onChange={chosen}
            />
            <Button
              type="button"
              variant="secondary"
              busy={save.isPending}
              onClick={() => input.current?.click()}
            >
              {save.isPending
                ? t('workspace.settings.logoUploading')
                : logoMediaId === null
                  ? t('workspace.settings.logoChoose')
                  : t('workspace.settings.logoReplace')}
            </Button>
            {logoMediaId !== null ? (
              <Button
                type="button"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => {
                  setNotice(null);
                  save.mutate(null);
                }}
              >
                {t('workspace.settings.logoRemove')}
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-content-muted">{t('workspace.settings.logoHint', { max })}</p>
          {notice === null ? null : (
            <p
              role={notice.kind === 'problem' ? 'alert' : 'status'}
              className={`text-sm ${notice.kind === 'problem' ? 'text-danger' : 'text-content-muted'}`}
            >
              {notice.text}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
