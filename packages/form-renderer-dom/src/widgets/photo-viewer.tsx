import type { MediaReference } from '@integr8/form-engine';
import { useTranslation } from '@integr8/i18n';
import { type KeyboardEvent, type PointerEvent, useEffect, useId, useRef, useState } from 'react';
import type { MediaAdapter } from '../media.js';
import { useMediaUrl } from './media-image.js';
import { buttonClass } from './types.js';

/**
 * A submitted photo seen properly: large, over the page, with the question's
 * other photos a press of an arrow away, zoom to read a meter or a serial
 * plate, and the original to open or save. Esc or Close shuts it.
 */

const ZOOMS = [1, 1.5, 2, 3, 4] as const;

export function PhotoViewer({
  media,
  photos,
  start,
  label,
  onClose,
}: {
  media: MediaAdapter;
  photos: readonly MediaReference[];
  start: number;
  /** The question, for the title and each photo's description. */
  label: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [index, setIndex] = useState(start);
  const [zoom, setZoom] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(null);
  const reference = photos[index];
  const url = useMediaUrl(media, reference ?? photos[0]!);
  const scale = ZOOMS[zoom] ?? 1;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open && typeof dialog.showModal === 'function') {
      dialog.showModal();
    }
  }, []);

  const show = (next: number) => {
    if (photos.length === 0) {
      return;
    }
    setIndex((next + photos.length) % photos.length);
    setZoom(0);
    setOffset({ x: 0, y: 0 });
  };
  const zoomTo = (next: number) => {
    const level = Math.min(Math.max(next, 0), ZOOMS.length - 1);
    setZoom(level);
    if (level === 0) {
      setOffset({ x: 0, y: 0 });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const forward = event.key === 'ArrowRight' ? !rtl : rtl;
      show(index + (forward ? 1 : -1));
    } else if (event.key === '+' || event.key === '=') {
      zoomTo(zoom + 1);
    } else if (event.key === '-') {
      zoomTo(zoom - 1);
    }
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (scale === 1) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, from: offset };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start === null) {
      return;
    }
    setOffset({
      x: start.from.x + (event.clientX - start.x) / scale,
      y: start.from.y + (event.clientY - start.y) / scale,
    });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const description = t('fill.files.photo', { number: index + 1 });
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
      onKeyDown={onKeyDown}
      className="m-auto flex h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-6xl flex-col rounded-lg border border-border-subtle bg-surface p-0 text-content shadow-xl backdrop:bg-black/70"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-4 py-3">
        <h2 id={titleId} className="min-w-0 truncate text-base font-semibold" dir="auto">
          {label} · {t('fill.photoViewer.count', { number: index + 1, total: photos.length })}
        </h2>
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            className={buttonClass.ghost}
            disabled={zoom === 0}
            onClick={() => zoomTo(zoom - 1)}
          >
            {t('fill.photoViewer.zoomOut')}
          </button>
          <span className="min-w-12 text-center text-sm tabular-nums" aria-live="polite">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className={buttonClass.ghost}
            disabled={zoom === ZOOMS.length - 1}
            onClick={() => zoomTo(zoom + 1)}
          >
            {t('fill.photoViewer.zoomIn')}
          </button>
          {url === undefined ? null : (
            <>
              <a href={url} target="_blank" rel="noreferrer noopener" className={buttonClass.ghost}>
                {t('fill.photoViewer.open')}
              </a>
              <a href={url} download className={buttonClass.ghost}>
                {t('fill.photoViewer.download')}
              </a>
            </>
          )}
          <button type="button" className={buttonClass.ghost} onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
      <div
        className={[
          'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black',
          scale === 1 ? '' : 'cursor-grab touch-none active:cursor-grabbing',
        ].join(' ')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => zoomTo(zoom === 0 ? 2 : 0)}
      >
        {url === undefined ? (
          <span role="status" className="text-sm text-white">
            {t('fill.loadingMedia')}
          </span>
        ) : (
          <img
            src={url}
            alt={`${label}: ${description}`}
            draggable={false}
            className="max-h-full max-w-full select-none object-contain"
            style={{
              transform: `scale(${String(scale)}) translate(${String(offset.x)}px, ${String(offset.y)}px)`,
            }}
          />
        )}
      </div>
      {photos.length > 1 ? (
        <div className="flex items-center justify-between gap-2 border-t border-border-subtle px-4 py-3">
          <button type="button" className={buttonClass.secondary} onClick={() => show(index - 1)}>
            <span aria-hidden="true" className="rtl:-scale-x-100">
              ‹
            </span>{' '}
            {t('fill.photoViewer.previous')}
          </button>
          <button type="button" className={buttonClass.secondary} onClick={() => show(index + 1)}>
            {t('fill.photoViewer.next')}{' '}
            <span aria-hidden="true" className="rtl:-scale-x-100">
              ›
            </span>
          </button>
        </div>
      ) : null}
    </dialog>
  );
}
