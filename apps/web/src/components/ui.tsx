'use client';

import { useTranslation } from '@integr8/i18n';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';

/**
 * The shared primitives, so no screen invents its own.
 *
 * Loading, empty and error are the three states every screen has and the three
 * every screen gets slightly differently if they are left to it: one spinner
 * centred, one not; one error with a retry, one without; one empty state that
 * looks like a bug.
 *
 * These are web-only. The desktop app has its own copy and the mobile app has a
 * React Native version — P01's rule stands, and React DOM and React Native do
 * not share widgets usefully. Tokens and copy are shared; the widgets are
 * written twice.
 *
 * Every className here uses logical properties (`ms-`, `pe-`, `text-start`).
 * The lint rule in `@integr8/eslint-config` rejects the physical ones, which is
 * what keeps the Arabic layout correct without anybody having to remember.
 */

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  busy?: boolean;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover',
  secondary: 'bg-surface text-content border border-border-subtle hover:bg-surface-muted',
  danger: 'bg-danger text-on-accent hover:bg-danger-hover',
  ghost: 'text-content hover:bg-surface-muted',
};

export function Button({ variant = 'primary', busy = false, children, ...rest }: ButtonProps) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled === true || busy}
      // `aria-busy` rather than only a spinner: a screen reader has no way to
      // see that the icon is spinning.
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
      // The label is for assistive technology; the animation is for everybody
      // else. Reduced motion is honoured globally in `globals.css`.
      role="status"
      aria-label={label}
      className="inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
}

export function Field({ label, error, hint, ...rest }: FieldProps) {
  const id = useId();
  const describedBy = [
    error === undefined ? null : `${id}-error`,
    hint === undefined ? null : `${id}-hint`,
  ]
    .filter((value): value is string => value !== null)
    .join(' ');

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-content">
        {label}
      </label>
      <input
        id={id}
        {...rest}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        className={[
          'rounded-md border bg-surface px-3 py-2 text-content',
          // `text-start`, not `text-left`: this input holds Arabic one day.
          'text-start text-sm',
          error === undefined ? 'border-border-subtle' : 'border-danger',
          rest.className ?? '',
        ].join(' ')}
      />
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-xs text-content-muted">
          {hint}
        </p>
      )}
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

export function EmptyState({
  title,
  body,
  action,
}: {
  title?: string;
  body?: string;
  action?: ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-border-subtle bg-surface px-6 py-12 text-center">
      <h2 className="text-lg font-semibold text-content">{title ?? t('states.emptyTitle')}</h2>
      <p className="max-w-prose text-sm text-content-muted">{body ?? t('states.emptyBody')}</p>
      {action}
    </div>
  );
}

export interface ErrorStateProps {
  /**
   * The request id from the failed call.
   *
   * Shown rather than hidden, because it is the one thing that turns "it didn't
   * work" into something answerable — the same id is on every server log line
   * for that request.
   */
  requestId?: string | undefined;
  message?: string | undefined;
  onRetry?: (() => void) | undefined;
}

export function ErrorState({ requestId, message, onRetry }: ErrorStateProps) {
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
