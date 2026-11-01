import { useTranslation } from '@integr8/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '~/components/ui';
import { Dialog } from '../forms/components/dialog';

/**
 * A warning before unsaved work is left behind (1.3.0 decision 8).
 *
 * Closing the window asks through the browser's own prompt. Inside the app the
 * routes are links, so a link clicked anywhere while there is unsaved work is
 * held back and the person asked first; switching to another template in the
 * designer asks the same way, through `confirm`. The local copy is the safety
 * net either way: whatever is left can be restored when the template is
 * opened again.
 */
export function useLeaveGuard(dirty: boolean): {
  /** Runs `action` now, or once the person agrees to leave unsaved work. */
  confirm: (action: () => void) => void;
  dialog: React.ReactNode;
} {
  const { t } = useTranslation();
  const [pending, setPending] = useState<(() => void) | null>(null);
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    if (!dirty) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const intercept = (event: MouseEvent) => {
      if (!dirtyRef.current || event.defaultPrevented || event.button !== 0) {
        return;
      }
      const link = (event.target as Element | null)?.closest?.('a[href]');
      const href = link?.getAttribute('href');
      if (
        href === null ||
        href === undefined ||
        href === '' ||
        link?.getAttribute('target') === '_blank'
      ) {
        return;
      }
      const target = new URL(href, window.location.href);
      if (target.href === window.location.href) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setPending(() => () => {
        window.location.assign(target.href);
      });
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', intercept, true);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('click', intercept, true);
    };
  }, [dirty]);

  const confirm = useCallback((action: () => void) => {
    if (dirtyRef.current) {
      setPending(() => action);
    } else {
      action();
    }
  }, []);

  const dialog = (
    <Dialog
      open={pending !== null}
      title={t('documents.pdfBuilder.leave.title')}
      onClose={() => setPending(null)}
      footer={
        <>
          <Button variant="secondary" onClick={() => setPending(null)}>
            {t('documents.pdfBuilder.leave.stay')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              const action = pending;
              setPending(null);
              dirtyRef.current = false;
              action?.();
            }}
          >
            {t('documents.pdfBuilder.leave.leave')}
          </Button>
        </>
      }
    >
      <p>{t('documents.pdfBuilder.leave.body')}</p>
    </Dialog>
  );
  return { confirm, dialog };
}
