import { ApiRequestError } from '@integr8/api-client';
import { formatDateTime, formatNumber, useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from 'react';
import {
  keys,
  type Priority,
  type RowAction,
  type RowTarget,
  useOperations,
  type WorkOrderState,
} from './api.js';

/**
 * The small pieces every operational screen is built from. Logical properties
 * throughout (`ps-`, `text-start`), so each screen mirrors correctly in Arabic.
 */

export const inputClass = [
  'w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-start text-sm text-content',
  'disabled:cursor-not-allowed disabled:opacity-70 aria-[invalid=true]:border-danger',
].join(' ');

export const buttonClass = {
  primary:
    'inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60',
  secondary:
    'inline-flex items-center justify-center gap-2 rounded-md border border-border-subtle bg-surface px-4 py-2 text-sm font-medium text-content hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60',
  ghost:
    'inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm text-content hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60',
  danger:
    'inline-flex items-center justify-center gap-2 rounded-md border border-danger bg-surface px-4 py-2 text-sm font-medium text-danger hover:bg-danger-subtle disabled:cursor-not-allowed disabled:opacity-60',
} as const;

export const cardClass =
  'flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface p-4 text-start';

/** A request that failed: what went wrong in the server's words where it has some, and the reference. */
export function Failure({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  const known = error instanceof ApiRequestError;
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-lg border border-danger bg-danger-subtle p-4 text-start"
    >
      <p className="text-sm text-content">
        {known && error.status >= 400 && error.status < 500 && error.status !== 401
          ? error.message
          : t('errors.body', { requestId: known ? error.requestId : '—' })}
      </p>
      {known && error.details.length > 0 && error.status !== 404 ? (
        <ul className="list-disc ps-5 text-sm text-content">
          {error.details.map((detail) => (
            <li key={`${detail.field}-${detail.code}`}>{detail.message}</li>
          ))}
        </ul>
      ) : null}
      {onRetry === undefined ? null : (
        <button type="button" className={buttonClass.secondary} onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

/**
 * A secondary part of a page that did not load — a filter's choices, a
 * history, a picker — said in one line under the part that did, with a retry.
 */
export function InlineError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <p
      role="alert"
      className="flex flex-wrap items-center gap-2 rounded-md border border-danger bg-danger-subtle px-3 py-1.5 text-start text-sm text-content"
    >
      <span>{t('common.loadFailed')}</span>
      <button
        type="button"
        className="text-sm font-medium text-accent underline-offset-4 hover:underline"
        onClick={onRetry}
      >
        {t('common.retry')}
      </button>
    </p>
  );
}

/** An arrow pointing back: left in English, right in Arabic. */
export function BackArrow() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4 shrink-0 rtl:rotate-180"
    >
      <path d="M16 10H4m5-5-5 5 5 5" />
    </svg>
  );
}

/**
 * The way back from a screen. A real link, so it can be opened in a new tab,
 * that otherwise goes through the app's own `navigate`.
 */
export function BackLink({ to, label }: { to: string; label: string }) {
  const { navigate } = useOperations();
  return (
    <a
      href={to}
      className="inline-flex items-center gap-1.5 self-start text-sm text-accent underline-offset-4 hover:underline"
      onClick={(event) => {
        event.preventDefault();
        navigate(to);
      }}
    >
      <BackArrow />
      <span>{label}</span>
    </a>
  );
}

/** Back to the dashboard from a list screen, when the app says where that is; otherwise nothing. */
export function DashboardBackLink() {
  const { t } = useTranslation();
  const { paths } = useOperations();
  if (paths.dashboard === undefined) {
    return null;
  }
  return (
    <BackLink to={paths.dashboard} label={t('nav.backTo', { title: t('nav.section.dashboard') })} />
  );
}

/**
 * The signed-in seat's permissions: the app's, when it supplied them, or read
 * from `/v1/me`. Empty until known, so an action that needs one stays hidden
 * rather than flashing up and being refused.
 */
export function usePermissions(): readonly string[] {
  const { client, permissions } = useOperations();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
    enabled: permissions === undefined,
  });
  return permissions ?? me.data?.permissions ?? [];
}

/** Puts text on the clipboard, where the platform offers one. */
export function copyText(text: string): void {
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    void navigator.clipboard.writeText(text).catch(() => undefined);
  }
}

/**
 * A row's context menu, when the app has one (`rowActions`). Returns the
 * `onContextMenu` handler for a row, or `undefined` so the browser keeps its
 * own menu. The actions are built only when the menu opens.
 */
export function useRowMenu(): (
  target: RowTarget,
  actions: () => readonly RowAction[],
) => ((event: MouseEvent) => void) | undefined {
  const { rowActions } = useOperations();
  return (target, actions) =>
    rowActions === undefined
      ? undefined
      : (event) => {
          event.preventDefault();
          rowActions(target, actions(), event);
        };
}

export function Loading() {
  const { t } = useTranslation();
  return (
    <p role="status" className="py-8 text-center text-sm text-content-muted">
      {t('common.loading')}
    </p>
  );
}

/** A modal on the platform's `<dialog>`: focus trap, Escape and an inert background come with it. */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open && typeof dialog.showModal === 'function') {
      dialog.showModal();
    }
  }, []);
  return (
    <dialog
      ref={ref}
      open={
        typeof HTMLDialogElement === 'undefined' ||
        typeof HTMLDialogElement.prototype.showModal !== 'function'
          ? true
          : undefined
      }
      aria-labelledby={titleId}
      onClose={onClose}
      className={`m-auto w-[calc(100%-2rem)] ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-lg border border-border-subtle bg-surface p-0 text-content shadow-xl backdrop:bg-black/40`}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
        <h2 id={titleId} className="text-lg font-semibold text-content">
          {title}
        </h2>
        <button
          type="button"
          className={buttonClass.ghost}
          aria-label={t('common.close')}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="flex max-h-[70dvh] flex-col gap-4 overflow-y-auto px-5 py-4 text-start text-sm">
        {children}
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border-subtle px-5 py-3">
        {footer}
      </div>
    </dialog>
  );
}

/** A labelled control. The label is always visible: placeholders are not labels. */
export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={`flex flex-col gap-1 text-start ${className}`}>
      <label htmlFor={id} className="text-sm font-medium text-content">
        {label}
      </label>
      {children(id, hint === undefined ? undefined : hintId)}
      {hint === undefined ? null : (
        <span id={hintId} className="text-xs text-content-muted">
          {hint}
        </span>
      )}
    </div>
  );
}

const STATE_TONE: Record<WorkOrderState, string> = {
  scheduled: 'border-border-subtle bg-surface-muted text-content',
  dispatched: 'border-accent bg-surface text-content',
  travelling: 'border-accent bg-surface text-content',
  on_site: 'border-accent bg-accent text-on-accent',
  in_progress: 'border-accent bg-accent text-on-accent',
  awaiting_parts: 'border-warning bg-warning-subtle text-content',
  complete: 'border-success bg-success-subtle text-content',
  reviewed: 'border-success bg-success text-on-accent',
  cancelled: 'border-border-subtle bg-surface-muted text-content-muted line-through',
};

/** A state, in words, never colour alone. */
export function StateBadge({ state }: { state: WorkOrderState }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATE_TONE[state]}`}
    >
      {t(`operations.state.${state}`)}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  const { t } = useTranslation();
  if (priority === 'normal' || priority === 'low') {
    return (
      <span className="text-xs text-content-muted">{t(`operations.priority.${priority}`)}</span>
    );
  }
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${
        priority === 'urgent'
          ? 'border-danger bg-danger-subtle text-danger'
          : 'border-warning bg-warning-subtle text-content'
      }`}
    >
      {t(`operations.priority.${priority}`)}
    </span>
  );
}

/**
 * A length of time, to the minute: `2 h 5 min`, `40 min`. Every duration on
 * these screens goes through here, so a job's time and a shift's read alike.
 */
export function useDuration(): (ms: number) => string {
  const { t, i18n } = useTranslation();
  return (ms) => {
    const total = Math.round(Math.max(0, ms) / 60_000);
    const hours = Math.floor(total / 60);
    const minutes = formatNumber(total % 60, { locale: i18n.language });
    return hours === 0
      ? t('operations.duration.minutes', { minutes })
      : t('operations.duration.hoursMinutes', {
          hours: formatNumber(hours, { locale: i18n.language }),
          minutes,
        });
  };
}

export function when(value: string | null | undefined, locale: string): string {
  return value === null || value === undefined ? '' : formatDateTime(value, { locale });
}

/** An ISO instant as a `datetime-local` value, in the person's own time zone. */
export function toLocalInput(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** A `datetime-local` value, read in the person's own time zone, as an ISO instant with offset. */
export function fromLocalInput(value: string): string | null {
  if (value === '') {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A short line for an address. */
export function addressText(address: {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region?: string | null;
  postcode: string | null;
  countryCode?: string | null;
}): string {
  return [address.line1, address.line2, address.city, address.postcode]
    .filter((part): part is string => part !== null && part !== '')
    .join(', ');
}
