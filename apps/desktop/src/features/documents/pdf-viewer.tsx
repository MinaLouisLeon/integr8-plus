import { useTranslation } from '@integr8/i18n';
import { useEffect, useRef, useState } from 'react';

/**
 * A PDF shown inside the app (1.3.0 decision 12), drawn page by page with
 * pdf.js rather than in a frame: the desktop app's webview on Windows has a
 * PDF viewer, but the macOS and Linux ones do not all show one in a frame,
 * and the app's content security policy keeps frames and plugins shut. pdf.js
 * reads the bytes in a worker bundled with the app and draws each page on a
 * canvas; nothing is fetched and no script in the PDF runs.
 *
 * Loaded only when a preview is first shown, so the app starts no slower.
 */

const MAX_PAGES = 30;

export function PdfViewer({ bytes, title }: { bytes: Uint8Array; title: string }) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [pages, setPages] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const target = container.current;
    if (target === null) {
      return;
    }
    target.replaceChildren();
    setState('loading');
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const document = await pdfjs.getDocument({
          // pdf.js takes the buffer over; a copy keeps the caller's bytes usable.
          data: bytes.slice(),
          isEvalSupported: false,
          enableXfa: false,
        }).promise;
        if (cancelled) {
          await document.destroy();
          return;
        }
        setPages(document.numPages);
        const width = Math.max(320, target.clientWidth - 16);
        const ratio = window.devicePixelRatio || 1;
        for (let number = 1; number <= Math.min(document.numPages, MAX_PAGES); number += 1) {
          const page = await document.getPage(number);
          const unscaled = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / unscaled.width) * ratio });
          const canvas = window.document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${String(Math.floor(viewport.width / ratio))}px`;
          canvas.className = 'mx-auto block bg-white shadow';
          canvas.setAttribute('role', 'img');
          canvas.setAttribute(
            'aria-label',
            t('documents.pdfBuilder.preview.pageLabel', { page: number, pages: document.numPages }),
          );
          const context = canvas.getContext('2d');
          if (context === null || cancelled) {
            break;
          }
          target.append(canvas);
          await page.render({ canvasContext: context, viewport }).promise;
        }
        await document.destroy();
        if (!cancelled) {
          setState('ready');
        }
      } catch {
        if (!cancelled) {
          setState('failed');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes, t]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <p role="status" className="text-xs text-content-muted">
        {state === 'loading'
          ? t('documents.pdfBuilder.preview.drawing')
          : state === 'failed'
            ? t('documents.pdfBuilder.preview.cannotShow')
            : t('documents.pdfBuilder.preview.pages', { count: pages })}
      </p>
      <div
        ref={container}
        aria-label={title}
        className="flex min-h-[60vh] flex-1 flex-col gap-4 overflow-auto rounded-md border border-border-subtle bg-surface-muted p-2"
      />
    </div>
  );
}
