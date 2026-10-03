import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { buttonClass } from '../widgets/types.js';

/** A request that failed, with the reference that makes it reportable. */
export function Failure({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  const requestId = error instanceof ApiRequestError ? error.requestId : undefined;
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-lg border border-danger bg-danger-subtle p-4 text-start"
    >
      <p className="text-sm text-content">
        {error instanceof ApiRequestError && error.status === 404
          ? t('submissions.detail.notFound')
          : t('errors.body', { requestId: requestId ?? '—' })}
      </p>
      {onRetry === undefined ? null : (
        <button type="button" className={buttonClass.secondary} onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function Loading() {
  const { t } = useTranslation();
  return (
    <p role="status" className="py-8 text-center text-sm text-content-muted">
      {t('common.loading')}
    </p>
  );
}

/** A modal on the platform's `<dialog>`: focus trap, Escape and inert background come with it. */
export function Dialog({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
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
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-border-subtle bg-surface p-0 text-content shadow-xl backdrop:bg-black/40"
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
      <div className="flex flex-col gap-4 px-5 py-4 text-start text-sm">{children}</div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border-subtle px-5 py-3">
        {footer}
      </div>
    </dialog>
  );
}
