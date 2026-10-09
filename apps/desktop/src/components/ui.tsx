import { useTranslation } from '@integr8/i18n';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';

/**
 * The desktop app's primitives.
 *
 * A near-copy of the web app's, and deliberately not shared. P01's rule is that
 * `packages/` holds tokens, types and clients but never widgets — and while
 * these two are both React DOM today, the desktop app will grow window chrome,
 * keyboard shortcuts and menu integration that a browser page has no use for.
 * Sharing them now buys a little and couples two apps that are about to
 * diverge.
 *
 * What *is* shared is everything that matters: the tokens, the copy, and the
 * client.
 *
 * Every className uses logical properties. The lint rule in
 * `@integr8/eslint-config` rejects the physical ones.
 */

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover',
  secondary: 'bg-surface text-content border border-border-subtle hover:bg-surface-muted',
  danger: 'bg-danger text-on-accent hover:bg-danger-hover',
  ghost: 'text-content hover:bg-surface-muted',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  busy?: boolean;
}

export function Button({ variant = 'primary', busy = false, children, ...rest }: ButtonProps) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled === true || busy}
      aria-busy={busy}
      className={[
        'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2',
        'text-sm font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-60',
        BUTTON_VARIANTS[variant],
        rest.className ?? '',
      ].join(' ')}
    >
      {busy ? <Spinner label={t('common.loading')} /> : null}
      {children}
    </button>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className="inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | undefined;
}

export function Field({ label, error, ...rest }: FieldProps) {
  const id = useId();

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-content">
        {label}
      </label>
      <input
        id={id}
        {...rest}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : `${id}-error`}
        className={[
          'rounded-md border bg-surface px-3 py-2 text-start text-sm text-content',
          error === undefined ? 'border-border-subtle' : 'border-danger',
        ].join(' ')}
      />
      {error === undefined ? null : (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function LoadingState({ label }: { label?: string }) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-center gap-3 py-12 text-content-muted">
      <Spinner label={label ?? t('states.loadingLabel')} />
      <span className="text-sm">{label ?? t('common.loading')}</span>
    </div>
  );
}

export function EmptyState({ title, body }: { title?: string; body?: string }) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border-subtle bg-surface px-6 py-12 text-center">
      <h2 className="text-lg font-semibold text-content">{title ?? t('states.emptyTitle')}</h2>
      <p className="max-w-prose text-sm text-content-muted">{body ?? t('states.emptyBody')}</p>
    </div>
  );
}

export function ErrorState({
  requestId,
  message,
  onRetry,
}: {
  requestId?: string | undefined;
  message?: string | undefined;
  onRetry?: (() => void) | undefined;
}) {
  const { t } = useTranslation();

  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-lg border border-danger bg-danger-subtle px-6 py-6 text-start"
    >
      <h2 className="text-lg font-semibold text-content">{t('errors.title')}</h2>
      <p className="max-w-prose text-sm text-content">
        {message ?? t('errors.body', { requestId: requestId ?? '—' })}
      </p>
      {onRetry === undefined ? null : (
        <Button variant="secondary" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}

/**
 * A centred column for a screen's content. The frame around every signed-in
 * screen owns the height and the scrolling, so this sets neither — a column
 * that insisted on being a viewport tall would scroll inside the frame for no
 * reason. Screens add their own padding; the builder adds none and fills the
 * window.
 */
export function Shell({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">{children}</div>;
}
