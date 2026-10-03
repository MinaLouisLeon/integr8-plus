import { useTranslation } from '@integr8/i18n';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from '~/components/ui';

/**
 * A modal, on the platform's own `<dialog>`.
 *
 * `showModal` gives focus trapping, Escape to close and an inert background for
 * free, in the Tauri webview and in every browser the app supports — which is
 * more than a hand-rolled overlay gets right.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className={[
        'm-auto w-[calc(100%-2rem)] rounded-lg border border-border-subtle bg-surface p-0 text-content shadow-xl backdrop:bg-black/40',
        wide ? 'max-w-2xl' : 'max-w-md',
      ].join(' ')}
    >
      {open ? (
        <div className="flex max-h-[85dvh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
            <h2 id={titleId} className="text-lg font-semibold text-content">
              {title}
            </h2>
            <Button variant="ghost" aria-label={t('common.close')} onClick={onClose}>
              ✕
            </Button>
          </div>
          <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4 text-start text-sm">
            {children}
          </div>
          {footer === undefined ? null : (
            <div className="flex flex-wrap justify-end gap-2 border-t border-border-subtle px-5 py-3">
              {footer}
            </div>
          )}
        </div>
      ) : null}
    </dialog>
  );
}
