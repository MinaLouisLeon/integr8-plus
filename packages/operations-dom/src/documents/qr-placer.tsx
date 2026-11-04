import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react';
import { type DocumentDetail, useOperations } from '../api.js';
import { buttonClass, cardClass, Dialog, Failure, Field, inputClass } from '../ui.js';

/**
 * Where an uploaded PDF's share QR code goes (0075): the page is drawn, and
 * the person drags the code's square where they want it, sets its size and
 * chooses the first, the last or every page. The place is kept as fractions
 * of the page, so it fits whatever size the page is; the server stamps the
 * code there once the document is shared.
 *
 * The page is drawn by the app's own pdf.js (`pdfPage` in the operations
 * context); without one, a blank sheet of A4 proportions stands in.
 */

export interface QrPlacement {
  page: 'first' | 'last' | 'all';
  x: number;
  y: number;
  size: number;
}

/** Bottom corner at the end of the line, a little in from the edge: where a code usually sits. */
export const DEFAULT_QR_PLACEMENT: QrPlacement = { page: 'first', x: 0.82, y: 0.86, size: 0.12 };

const A4 = 210 / 297;
const STEP = 0.01;

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), Math.max(max, 0));

/** The place kept inside the page: across by its width, down by its height on this page. */
export function fitPlacement(placement: QrPlacement, aspect: number): QrPlacement {
  const size = Math.min(Math.max(placement.size, 0.05), 0.5);
  return {
    ...placement,
    size,
    x: clamp(placement.x, 1 - size),
    y: clamp(placement.y, 1 - size * aspect),
  };
}

export function QrPlacer({
  bytes,
  value,
  onChange,
}: {
  /** The PDF to draw, or null while it loads. */
  bytes: Uint8Array | null;
  value: QrPlacement;
  onChange: (next: QrPlacement) => void;
}) {
  const { t } = useTranslation();
  const { pdfPage } = useOperations();
  const sheet = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [aspect, setAspect] = useState(A4);
  const [drawn, setDrawn] = useState<'none' | 'drawn' | 'failed'>('none');
  const shown = value.page === 'last' ? 'last' : 1;

  useEffect(() => {
    const target = canvas.current;
    const box = sheet.current;
    if (bytes === null || pdfPage === undefined || target === null || box === null) {
      return;
    }
    let cancelled = false;
    void pdfPage(bytes, shown, target, box.clientWidth || 320)
      .then((page) => {
        if (!cancelled) {
          setAspect(page.aspect);
          setDrawn('drawn');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDrawn('failed');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bytes, pdfPage, shown]);

  const place = (next: QrPlacement) => onChange(fitPlacement(next, aspect));

  const point = (event: PointerEvent<HTMLElement>) => {
    const box = sheet.current?.getBoundingClientRect();
    if (box === undefined || box.width === 0 || box.height === 0) {
      return undefined;
    }
    return {
      x: (event.clientX - box.left) / box.width,
      y: (event.clientY - box.top) / box.height,
    };
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    const at = point(event);
    if (at === undefined) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { dx: at.x - value.x, dy: at.y - value.y };
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const at = point(event);
    if (drag.current === null || at === undefined) {
      return;
    }
    place({ ...value, x: at.x - drag.current.dx, y: at.y - drag.current.dy });
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [rtl ? STEP : -STEP, 0],
      ArrowRight: [rtl ? -STEP : STEP, 0],
      ArrowUp: [0, -STEP],
      ArrowDown: [0, STEP],
    };
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      place({ ...value, x: value.x + move[0], y: value.y + move[1] });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('documents.qrPlace.page')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={value.page}
              onChange={(event) =>
                place({ ...value, page: event.target.value as QrPlacement['page'] })
              }
            >
              <option value="first">{t('documents.qrPlace.first')}</option>
              <option value="last">{t('documents.qrPlace.last')}</option>
              <option value="all">{t('documents.qrPlace.all')}</option>
            </select>
          )}
        </Field>
        <Field label={t('documents.qrPlace.size')}>
          {(id) => (
            <input
              id={id}
              type="range"
              min={5}
              max={50}
              step={1}
              value={Math.round(value.size * 100)}
              onChange={(event) => place({ ...value, size: Number(event.target.value) / 100 })}
            />
          )}
        </Field>
      </div>
      <p className="text-xs text-content-muted">{t('documents.qrPlace.hint')}</p>
      {/* The page is drawn left to right whatever the language: it is the PDF. */}
      <div
        ref={sheet}
        dir="ltr"
        className="relative w-full max-w-md select-none overflow-hidden border border-border-subtle bg-white shadow-sm"
        style={{ aspectRatio: String(aspect) }}
      >
        <canvas
          ref={canvas}
          aria-hidden="true"
          className={['absolute inset-0 h-full w-full', drawn === 'drawn' ? '' : 'hidden'].join(
            ' ',
          )}
        />
        <button
          type="button"
          aria-label={t('documents.qrPlace.square', {
            x: Math.round(value.x * 100),
            y: Math.round(value.y * 100),
          })}
          className="absolute flex cursor-move touch-none items-center justify-center border-2 border-accent bg-accent-subtle/70 text-[10px] font-semibold text-accent"
          style={{
            insetInlineStart: `${String(value.x * 100)}%`,
            top: `${String(value.y * 100)}%`,
            width: `${String(value.size * 100)}%`,
            aspectRatio: '1',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        >
          QR
        </button>
      </div>
      {drawn === 'failed' ? (
        <p className="text-xs text-content-muted">{t('documents.qrPlace.noPreview')}</p>
      ) : null}
    </div>
  );
}

/** Base64 from the API into bytes for pdf.js. */
function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * An uploaded PDF's share QR code, on its page in the register (0075): where
 * it is, whether the PDF carries it yet, and the way to place, move or remove
 * it. Moving it on a document already shared stamps the PDF again from the
 * file as uploaded; removing it serves that file again.
 */
export function UploadedQrSection({
  document,
  onSaved,
}: {
  document: DocumentDetail;
  onSaved: (next: DocumentDetail) => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<QrPlacement>(document.qr.placement ?? DEFAULT_QR_PLACEMENT);
  const original = useQuery({
    queryKey: ['documents', 'original', document.id],
    enabled: editing,
    staleTime: Infinity,
    queryFn: async () =>
      fromBase64(
        (
          await client.GET('/v1/documents/{documentId}/original', {
            params: { path: { documentId: document.id } },
          })
        ).data!.base64,
      ),
  });
  const save = useMutation({
    mutationFn: async (placement: QrPlacement | null) =>
      (
        await client.PUT('/v1/documents/{documentId}/qr-placement', {
          params: { path: { documentId: document.id } },
          body: { placement },
        })
      ).data!,
    onSuccess: (next) => {
      setEditing(false);
      onSaved(next);
    },
  });
  const state =
    document.qr.placement === null
      ? t('documents.qrPlace.stateNone')
      : document.qr.printed
        ? t('documents.qrPlace.statePrinted')
        : t('documents.qrPlace.stateWaiting');

  return (
    <section className={cardClass} aria-labelledby="document-qr">
      <h2 id="document-qr" className="mb-1 text-lg font-semibold text-content">
        {t('documents.qrPlace.title')}
      </h2>
      <p className="text-sm text-content-muted">{state}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass.secondary}
          onClick={() => {
            setDraft(document.qr.placement ?? DEFAULT_QR_PLACEMENT);
            setEditing(true);
          }}
        >
          {document.qr.placement === null
            ? t('documents.qrPlace.add')
            : t('documents.qrPlace.move')}
        </button>
        {document.qr.placement === null ? null : (
          <button
            type="button"
            className={buttonClass.ghost}
            disabled={save.isPending}
            onClick={() => save.mutate(null)}
          >
            {t('documents.qrPlace.remove')}
          </button>
        )}
      </div>
      {save.isError && !editing ? <Failure error={save.error} /> : null}
      {editing ? (
        <Dialog
          title={t('documents.qrPlace.title')}
          onClose={() => setEditing(false)}
          wide
          footer={
            <>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setEditing(false)}
              >
                {t('documents.cancel')}
              </button>
              <button
                type="button"
                className={buttonClass.primary}
                disabled={save.isPending}
                onClick={() => save.mutate(draft)}
              >
                {t('documents.qrPlace.save')}
              </button>
            </>
          }
        >
          {original.isError ? <Failure error={original.error} /> : null}
          <QrPlacer bytes={original.data ?? null} value={draft} onChange={setDraft} />
          {save.isError ? <Failure error={save.error} /> : null}
        </Dialog>
      ) : null}
    </section>
  );
}
