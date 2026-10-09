import { ApiRequestError } from '@integr8/api-client';
import { useTranslation, type TFunction } from '@integr8/i18n';
import { brandAccent, brandShell, colours, parseHexColour, type Theme } from '@integr8/tokens';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { useMediaUrl, useSystemTheme } from '~/components/company-brand';
import { ChromeIconGlyph, NavIconGlyph } from '~/components/nav-icon';
import { Button, ErrorState, LoadingState, Shell } from '~/components/ui';
import { useMe } from '~/features/forms/api';
import { COMPANY_THEMES, type CompanyTheme } from '~/lib/company-theme';
import {
  checkAppIcon,
  checkImageFile,
  IMAGE_TYPES,
  type ImageProblem,
  uploadMedia,
} from '~/lib/media-upload';
import { session } from '~/lib/session';

/**
 * The company's look, set by Integr8 while acting as the company.
 *
 * A company's apps are built for it and arrive wearing its brand, so nobody in
 * the company changes the brand any more than they change their forms: the
 * screen is for a staff seat (`branding.manage`), and anybody else is sent to
 * the dashboard. Everything is edited as a draft and previewed on a miniature
 * of the shell before it is saved, because a colour is a thing to see rather
 * than to read; saving repaints the real shell at once, since the frame reads
 * `/v1/me`.
 */

interface Settings {
  logoMediaId: string | null;
  appIconMediaId: string | null;
  brandColour: string | null;
  shellColour: string | null;
  defaultTheme: CompanyTheme;
  websiteUrl: string | null;
  appsEnabled: boolean;
}

interface Draft {
  logoMediaId: string | null;
  appIconMediaId: string | null;
  /** `#rrggbb`, or empty for the product's own colour. */
  brandColour: string;
  shellColour: string;
  defaultTheme: CompanyTheme;
  websiteUrl: string;
  appsEnabled: boolean;
}

type DraftField = keyof Draft;
type FieldErrors = Partial<Record<DraftField, string>>;

const SETTINGS_KEY = ['settings'] as const;

export function BrandingRoute() {
  const me = useMe();
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: async () => (await session().client.GET('/v1/settings')).data!,
    enabled: me.data?.permissions.includes('branding.manage') === true,
  });

  if (me.isPending) {
    return (
      <Shell>
        <LoadingState />
      </Shell>
    );
  }
  if (me.isError) {
    return (
      <Shell>
        <ErrorState
          requestId={me.error instanceof ApiRequestError ? me.error.requestId : undefined}
          onRetry={() => void me.refetch()}
        />
      </Shell>
    );
  }
  if (!me.data.permissions.includes('branding.manage')) {
    return <Navigate to="/dashboard" replace />;
  }
  if (settings.isPending) {
    return (
      <Shell>
        <LoadingState />
      </Shell>
    );
  }
  if (settings.isError) {
    return (
      <Shell>
        <ErrorState
          requestId={
            settings.error instanceof ApiRequestError ? settings.error.requestId : undefined
          }
          onRetry={() => void settings.refetch()}
        />
      </Shell>
    );
  }

  return <BrandingForm initial={settings.data} />;
}

function toDraft(settings: Settings): Draft {
  return {
    logoMediaId: settings.logoMediaId,
    appIconMediaId: settings.appIconMediaId,
    brandColour: settings.brandColour ?? '',
    shellColour: settings.shellColour ?? '',
    defaultTheme: settings.defaultTheme,
    websiteUrl: settings.websiteUrl ?? '',
    appsEnabled: settings.appsEnabled,
  };
}

function isHexColour(value: string): boolean {
  return parseHexColour(value) !== null;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** What is wrong with the draft, before the API is asked. */
function validate(draft: Draft, t: TFunction): FieldErrors {
  const errors: FieldErrors = {};
  if (draft.brandColour !== '' && !isHexColour(draft.brandColour)) {
    errors.brandColour = t('workspace.branding.invalidColour');
  }
  if (draft.shellColour !== '' && !isHexColour(draft.shellColour)) {
    errors.shellColour = t('workspace.branding.invalidColour');
  }
  const website = draft.websiteUrl.trim();
  if (website !== '' && !isHttpsUrl(website)) {
    errors.websiteUrl = t('workspace.branding.invalidWebsite');
  }
  return errors;
}

const DRAFT_FIELDS: readonly DraftField[] = [
  'logoMediaId',
  'appIconMediaId',
  'brandColour',
  'shellColour',
  'defaultTheme',
  'websiteUrl',
  'appsEnabled',
];

/** The API names a field as `websiteUrl` or `body.websiteUrl`; either way, the last part is ours. */
function fieldErrorsFrom(failure: ApiRequestError, t: TFunction): FieldErrors {
  const errors: FieldErrors = {};
  for (const detail of failure.details) {
    const name = detail.field.split('.').pop() ?? '';
    if ((DRAFT_FIELDS as readonly string[]).includes(name)) {
      errors[name as DraftField] = t('workspace.branding.invalid');
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

function BrandingForm({ initial }: { initial: Settings }) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<{ kind: 'ok' | 'problem'; text: string } | null>(null);

  const change = <K extends DraftField>(field: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) =>
      current[field] === undefined ? current : { ...current, [field]: undefined },
    );
    setNotice(null);
  };

  const save = useMutation({
    mutationFn: async (next: Draft) => {
      const website = next.websiteUrl.trim();
      const { data } = await session().client.PATCH('/v1/settings', {
        body: {
          logoMediaId: next.logoMediaId,
          appIconMediaId: next.appIconMediaId,
          brandColour: next.brandColour === '' ? null : next.brandColour.toLowerCase(),
          shellColour: next.shellColour === '' ? null : next.shellColour.toLowerCase(),
          defaultTheme: next.defaultTheme,
          websiteUrl: website === '' ? null : website,
          appsEnabled: next.appsEnabled,
        },
      });
      return data!;
    },
    onSuccess: (saved) => {
      setDraft(toDraft(saved));
      setErrors({});
      setNotice({ kind: 'ok', text: t('workspace.branding.saved') });
      // The frame reads `/v1/me`; invalidating it is what repaints the shell now.
      void queries.invalidateQueries({ queryKey: ['me'] });
      void queries.invalidateQueries({ queryKey: SETTINGS_KEY });
    },
    onError: (failure) => {
      if (failure instanceof ApiRequestError) {
        if (failure.status === 403) {
          setNotice({ kind: 'problem', text: t('workspace.branding.integr8Sets') });
          return;
        }
        if (failure.isValidation) {
          const fromApi = fieldErrorsFrom(failure, t);
          setErrors(fromApi);
          setNotice(
            Object.keys(fromApi).length === 0
              ? { kind: 'problem', text: t('workspace.branding.failed') }
              : null,
          );
          return;
        }
      }
      setNotice({ kind: 'problem', text: t('workspace.branding.failed') });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = validate(draft, t);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      return;
    }
    save.mutate(draft);
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-8 text-start">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('workspace.branding.title')}</h1>
        <p className="text-sm text-content-muted">{t('workspace.branding.subtitle')}</p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <form onSubmit={submit} noValidate className="flex flex-col gap-8">
          <section className="grid gap-6 sm:grid-cols-2">
            <ImagePicker
              label={t('workspace.branding.logo')}
              hint={t('workspace.branding.logoHint')}
              emptyLabel={t('workspace.branding.logoNone')}
              alt={t('workspace.branding.logoAlt')}
              mediaId={draft.logoMediaId}
              kind="logo"
              onChange={(mediaId) => change('logoMediaId', mediaId)}
              error={errors.logoMediaId}
            />
            <ImagePicker
              label={t('workspace.branding.appIcon')}
              hint={t('workspace.branding.appIconHint')}
              emptyLabel={t('workspace.branding.appIconNone')}
              alt={t('workspace.branding.appIconAlt')}
              mediaId={draft.appIconMediaId}
              kind="icon"
              onChange={(mediaId) => change('appIconMediaId', mediaId)}
              error={errors.appIconMediaId}
            />
          </section>

          <section className="grid gap-6 sm:grid-cols-2">
            <ColourField
              label={t('workspace.branding.accent')}
              hint={t('workspace.branding.accentHint')}
              value={draft.brandColour}
              fallback={colours.light.accent}
              onChange={(value) => change('brandColour', value)}
              error={errors.brandColour}
            />
            <ColourField
              label={t('workspace.branding.shell')}
              hint={t('workspace.branding.shellHint')}
              value={draft.shellColour}
              fallback={colours.light.shell}
              onChange={(value) => change('shellColour', value)}
              error={errors.shellColour}
            />
          </section>

          <ThemeChoice
            value={draft.defaultTheme}
            onChange={(value) => change('defaultTheme', value)}
          />

          <WebsiteField
            value={draft.websiteUrl}
            onChange={(value) => change('websiteUrl', value)}
            error={errors.websiteUrl}
          />

          <div className="flex items-start gap-3">
            <input
              id="branding-apps-enabled"
              type="checkbox"
              checked={draft.appsEnabled}
              onChange={(event) => change('appsEnabled', event.target.checked)}
              aria-describedby="branding-apps-enabled-hint"
              className="mt-1"
            />
            <div className="flex flex-col gap-1">
              <label htmlFor="branding-apps-enabled" className="text-sm font-medium text-content">
                {t('workspace.branding.appsEnabled')}
              </label>
              <p id="branding-apps-enabled-hint" className="text-xs text-content-muted">
                {t('workspace.branding.appsEnabledHint')}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" busy={save.isPending}>
              {save.isPending ? t('workspace.branding.saving') : t('workspace.branding.save')}
            </Button>
            {notice === null ? null : (
              <p
                role={notice.kind === 'problem' ? 'alert' : 'status'}
                className={`text-sm ${notice.kind === 'problem' ? 'text-danger' : 'text-content-muted'}`}
              >
                {notice.text}
              </p>
            )}
          </div>
        </form>

        <BrandPreview draft={draft} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

function problemMessage(problem: ImageProblem, t: TFunction): string {
  switch (problem) {
    case 'wrong_type':
      return t('workspace.branding.wrongType');
    case 'too_large':
      return t('workspace.branding.tooLarge');
    case 'not_square':
      return t('workspace.branding.notSquare');
    case 'too_small':
      return t('workspace.branding.tooSmall');
    case 'unreadable':
      return t('workspace.branding.unreadable');
  }
}

/**
 * A stored image and the means to replace or remove it. The file is checked
 * here and uploaded at once; only its id goes into the draft, and only "Save"
 * writes that id to the settings.
 */
function ImagePicker({
  label,
  hint,
  emptyLabel,
  alt,
  mediaId,
  kind,
  onChange,
  error,
}: {
  label: string;
  hint: string;
  emptyLabel: string;
  alt: string;
  mediaId: string | null;
  kind: 'logo' | 'icon';
  onChange: (mediaId: string | null) => void;
  error: string | undefined;
}) {
  const { t } = useTranslation();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const url = useMediaUrl(mediaId);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const found = kind === 'icon' ? await checkAppIcon(file) : checkImageFile(file);
      if (found !== null) {
        throw new ImageRefused(found);
      }
      return uploadMedia(session().client, file);
    },
    onSuccess: (stored) => {
      setProblem(undefined);
      onChange(stored);
    },
    onError: (failure) => {
      setProblem(
        failure instanceof ImageRefused
          ? problemMessage(failure.problem, t)
          : t('workspace.branding.uploadFailed'),
      );
    },
  });

  const chosen = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared so choosing the same file again, after fixing a problem, fires.
    event.target.value = '';
    if (file !== undefined) {
      upload.mutate(file);
    }
  };

  const shown = error ?? problem;
  const frame = kind === 'icon' ? 'size-20 rounded-2xl' : 'h-20 w-28 rounded-md';

  return (
    <div className="flex flex-col gap-2">
      <span id={`${id}-label`} className="text-sm font-medium text-content">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-4">
        {mediaId !== null && typeof url.data === 'string' ? (
          <img
            src={url.data}
            alt={alt}
            className={`${frame} border border-border-subtle bg-surface object-contain`}
          />
        ) : (
          <div
            className={`${frame} flex items-center justify-center border border-dashed border-border-subtle p-1 text-center text-xs text-content-muted`}
          >
            {mediaId === null ? emptyLabel : ''}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <input
            ref={input}
            id={id}
            type="file"
            accept={IMAGE_TYPES.join(',')}
            className="sr-only"
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-hint`}
            onChange={chosen}
          />
          <Button
            type="button"
            variant="secondary"
            busy={upload.isPending}
            onClick={() => input.current?.click()}
          >
            {upload.isPending
              ? t('workspace.branding.uploading')
              : mediaId === null
                ? t('workspace.branding.choose')
                : t('workspace.branding.replace')}
          </Button>
          {mediaId === null ? null : (
            <Button
              type="button"
              variant="ghost"
              disabled={upload.isPending}
              onClick={() => {
                setProblem(undefined);
                onChange(null);
              }}
            >
              {t('workspace.branding.remove')}
            </Button>
          )}
        </div>
      </div>
      <p id={`${id}-hint`} className="text-xs text-content-muted">
        {hint}
      </p>
      {shown === undefined ? null : (
        <p role="alert" className="text-xs text-danger">
          {shown}
        </p>
      )}
    </div>
  );
}

class ImageRefused extends Error {
  constructor(readonly problem: ImageProblem) {
    super(problem);
    this.name = 'ImageRefused';
  }
}

/** A colour picker and a hex field, kept in step; empty means the product's own. */
function ColourField({
  label,
  hint,
  value,
  fallback,
  onChange,
  error,
}: {
  label: string;
  hint: string;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
  error: string | undefined;
}) {
  const { t } = useTranslation();
  const id = useId();
  const picked = isHexColour(value) ? value : fallback;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`${id}-hex`} className="text-sm font-medium text-content">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={picked}
          aria-label={t('workspace.branding.picker')}
          onChange={(event) => onChange(event.target.value)}
          className="size-10 shrink-0 cursor-pointer rounded-md border border-border-subtle bg-surface p-0.5"
        />
        <input
          id={`${id}-hex`}
          type="text"
          value={value}
          placeholder={fallback}
          spellCheck={false}
          autoComplete="off"
          aria-label={t('workspace.branding.hex')}
          aria-invalid={error !== undefined}
          aria-describedby={`${id}-hint${error === undefined ? '' : ` ${id}-error`}`}
          onChange={(event) => onChange(event.target.value.trim())}
          className={`w-32 rounded-md border bg-surface px-3 py-2 font-mono text-sm text-content ${
            error === undefined ? 'border-border-subtle' : 'border-danger'
          }`}
          dir="ltr"
        />
        {value === '' ? null : (
          <Button type="button" variant="ghost" onClick={() => onChange('')}>
            {t('workspace.branding.useDefault')}
          </Button>
        )}
      </div>
      <p id={`${id}-hint`} className="text-xs text-content-muted">
        {hint}
      </p>
      {error === undefined ? null : (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function ThemeChoice({
  value,
  onChange,
}: {
  value: CompanyTheme;
  onChange: (value: CompanyTheme) => void;
}) {
  const { t } = useTranslation();
  const labels: Record<CompanyTheme, string> = {
    light: t('workspace.branding.themeLight'),
    dark: t('workspace.branding.themeDark'),
    system: t('workspace.branding.themeSystem'),
  };

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium text-content">{t('workspace.branding.theme')}</legend>
      <div className="flex flex-wrap gap-4">
        {COMPANY_THEMES.map((theme) => (
          <label key={theme} className="flex items-center gap-2 text-sm text-content">
            <input
              type="radio"
              name="defaultTheme"
              value={theme}
              checked={value === theme}
              onChange={() => onChange(theme)}
            />
            {labels[theme]}
          </label>
        ))}
      </div>
      <p className="text-xs text-content-muted">{t('workspace.branding.themeHint')}</p>
    </fieldset>
  );
}

function WebsiteField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error: string | undefined;
}) {
  const { t } = useTranslation();
  const id = useId();

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium text-content">
        {t('workspace.branding.website')}
      </label>
      <input
        id={id}
        type="url"
        inputMode="url"
        autoComplete="url"
        placeholder="https://"
        value={value}
        aria-invalid={error !== undefined}
        aria-describedby={`${id}-hint${error === undefined ? '' : ` ${id}-error`}`}
        onChange={(event) => onChange(event.target.value)}
        className={`rounded-md border bg-surface px-3 py-2 text-sm text-content ${
          error === undefined ? 'border-border-subtle' : 'border-danger'
        }`}
        dir="ltr"
      />
      <p id={`${id}-hint`} className="text-xs text-content-muted">
        {t('workspace.branding.websiteHint')}
      </p>
      {error === undefined ? null : (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

const PREVIEW_SECTIONS = [
  { path: 'dashboard', icon: 'home' },
  { path: 'workOrders', icon: 'briefcase' },
  { path: 'customers', icon: 'users' },
  { path: 'forms', icon: 'clipboard' },
] as const;

/**
 * A miniature of the shell in the draft's colours and theme, drawn with inline
 * styles because the colours are the draft's and not yet anybody's tokens.
 */
function BrandPreview({ draft }: { draft: Draft }) {
  const { t } = useTranslation();
  const system = useSystemTheme();
  const theme: Theme = draft.defaultTheme === 'system' ? system : draft.defaultTheme;
  const base = colours[theme];
  const shell = brandShell(draft.shellColour) ?? {
    shell: base.shell,
    shellHover: base.shellHover,
    shellActive: base.shellActive,
    shellText: base.shellText,
    shellTextMuted: base.shellTextMuted,
    shellBorder: base.shellBorder,
  };
  const accent = brandAccent(draft.brandColour, theme) ?? {
    accent: base.accent,
    accentHover: base.accentHover,
    accentSubtle: base.accentSubtle,
    onAccent: base.onAccent,
  };

  return (
    <figure className="flex flex-col gap-2 lg:sticky lg:top-0 lg:self-start">
      <figcaption className="flex flex-col gap-1">
        <span className="text-sm font-medium text-content">{t('workspace.branding.preview')}</span>
        <span className="text-xs text-content-muted">{t('workspace.branding.previewHint')}</span>
      </figcaption>
      <div
        className="flex aspect-[4/3] overflow-hidden rounded-lg border text-[10px]"
        style={{
          backgroundColor: base.background,
          color: base.text,
          borderColor: base.border,
          colorScheme: theme,
        }}
      >
        <div
          className="flex w-2/5 flex-col gap-1 border-e p-2"
          style={{
            backgroundColor: shell.shell,
            color: shell.shellText,
            borderColor: shell.shellBorder,
          }}
        >
          <div
            className="mb-1 flex items-center gap-1.5 border-b pb-2"
            style={{ borderColor: shell.shellBorder }}
          >
            <span
              className="flex size-4 items-center justify-center rounded text-[8px] font-semibold"
              style={{ backgroundColor: accent.accent, color: accent.onAccent }}
            >
              A
            </span>
            <span className="truncate font-semibold">{t('common.appName')}</span>
          </div>
          {PREVIEW_SECTIONS.map((section, index) => (
            <div
              key={section.path}
              className="flex items-center gap-1.5 rounded px-1.5 py-1"
              style={
                index === 0
                  ? { backgroundColor: shell.shellActive, color: shell.shellText }
                  : { color: shell.shellTextMuted }
              }
            >
              <NavIconGlyph name={section.icon} size={10} />
              <span className="truncate">{t(`nav.section.${section.path}`)}</span>
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            className="flex items-center gap-1.5 border-b px-2 py-1.5 font-semibold"
            style={{
              backgroundColor: shell.shell,
              color: shell.shellText,
              borderColor: shell.shellBorder,
            }}
          >
            <ChromeIconGlyph name="menu" size={10} />
            <span className="truncate">{t('nav.section.dashboard')}</span>
          </div>
          <div className="flex flex-1 flex-col gap-2 p-2">
            <div
              className="flex flex-col gap-1 rounded border p-2"
              style={{ backgroundColor: base.surface, borderColor: base.border }}
            >
              <span className="h-1.5 w-2/3 rounded" style={{ backgroundColor: base.textMuted }} />
              <span className="h-1.5 w-1/2 rounded" style={{ backgroundColor: base.border }} />
              <span className="sr-only">{t('workspace.branding.previewBody')}</span>
            </div>
            <span
              className="self-start rounded px-2 py-1 font-medium"
              style={{ backgroundColor: accent.accent, color: accent.onAccent }}
            >
              {t('workspace.branding.previewButton')}
            </span>
            <span
              className="self-start rounded px-2 py-1"
              style={{ backgroundColor: accent.accentSubtle, color: base.text }}
            >
              {t('workspace.branding.previewBody')}
            </span>
          </div>
        </div>
      </div>
    </figure>
  );
}
