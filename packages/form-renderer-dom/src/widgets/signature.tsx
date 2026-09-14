import type { MediaReference } from '@integr8/form-engine';
import { mediaReferenceSchema } from '@integr8/form-engine';
import { useTranslation } from '@integr8/i18n';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { MediaImage } from './media-image.js';
import { buttonClass, inputClass, type WidgetProps } from './types.js';

/**
 * Signature capture with a mouse, a trackpad, a pen or a finger.
 *
 * Pointer Events, so one code path serves all four; `touch-action: none` on the
 * pad, so a finger signs instead of scrolling the page. Strokes are kept as
 * points and redrawn at the device's pixel ratio, so the saved image is sharp on
 * a high-density screen.
 *
 * A canvas cannot be operated from a keyboard or read by a screen reader, so
 * the pad always offers a second way: type a name, which is drawn into the same
 * image. Whichever is used, what is stored is a PNG uploaded through the app's
 * media adapter, and the answer is its reference.
 */

type Point = [number, number];

const WIDTH = 480;
const HEIGHT = 160;

export function SignatureWidget(props: WidgetProps<'signature'>) {
  const { value, id, label, describedBy, disabled, media, onAnswer, onClear, onBlur } = props;
  const { t } = useTranslation();
  const parsed = mediaReferenceSchema.safeParse(value);
  const [replacing, setReplacing] = useState(false);

  if (parsed.success && !replacing) {
    return (
      <div className="flex flex-col items-start gap-2">
        {media === undefined ? null : (
          <MediaImage
            media={media}
            reference={parsed.data}
            alt={t('fill.signature.image', { question: label })}
            className="h-24 rounded-md border border-border-subtle bg-white"
          />
        )}
        {disabled ? null : (
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => {
              setReplacing(true);
              onClear();
            }}
          >
            {t('fill.signature.replace')}
          </button>
        )}
      </div>
    );
  }

  return (
    <SignaturePad
      id={id}
      describedBy={describedBy}
      disabled={disabled || media === undefined}
      onSaved={async (blob) => {
        if (media === undefined) {
          return;
        }
        const reference: MediaReference = await media.upload(blob, { contentType: 'image/png' });
        setReplacing(false);
        onAnswer(reference);
        onBlur();
      }}
    />
  );
}

function SignaturePad({
  id,
  describedBy,
  disabled,
  onSaved,
}: {
  id: string;
  describedBy: string | undefined;
  disabled: boolean;
  onSaved: (blob: Blob) => Promise<void>;
}) {
  const { t } = useTranslation();
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const drawing = useRef(false);
  const [mode, setMode] = useState<'draw' | 'type'>('draw');
  const [typed, setTyped] = useState('');
  const [hasInk, setHasInk] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const redraw = () => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (element === null || element === undefined || context === null || context === undefined) {
      return;
    }
    const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    element.width = WIDTH * ratio;
    element.height = HEIGHT * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, WIDTH, HEIGHT);
    context.strokeStyle = '#111827';
    context.fillStyle = '#111827';
    context.lineWidth = 2.5;
    context.lineCap = 'round';
    context.lineJoin = 'round';

    if (mode === 'type') {
      context.font = 'italic 36px "Segoe Script", "Brush Script MT", cursive';
      context.textBaseline = 'middle';
      context.fillText(typed, 16, HEIGHT / 2, WIDTH - 32);
      return;
    }
    for (const stroke of strokes.current) {
      context.beginPath();
      stroke.forEach(([x, y], index) => {
        if (index === 0) {
          context.moveTo(x, y);
          context.lineTo(x + 0.01, y);
        } else {
          context.lineTo(x, y);
        }
      });
      context.stroke();
    }
  };

  // The canvas is an external surface: it is drawn after every render.
  useEffect(redraw);

  const point = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleX = rect.width === 0 ? 1 : WIDTH / rect.width;
    const scaleY = rect.height === 0 ? 1 : HEIGHT / rect.height;
    return [(event.clientX - rect.left) * scaleX, (event.clientY - rect.top) * scaleY];
  };

  const save = async () => {
    const element = canvas.current;
    if (
      element === null ||
      (mode === 'draw' && !hasInk) ||
      (mode === 'type' && typed.trim() === '')
    ) {
      setProblem(t('fill.signature.empty'));
      return;
    }
    setProblem(undefined);
    setSaving(true);
    try {
      const blob = await new Promise<Blob | null>((resolve) => {
        element.toBlob(resolve, 'image/png');
      });
      if (blob === null) {
        throw new Error('no image');
      }
      await onSaved(blob);
    } catch {
      setProblem(t('fill.files.failed', { name: t('fill.signature.pad') }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {mode === 'draw' ? (
        <canvas
          ref={canvas}
          id={id}
          tabIndex={-1}
          role="img"
          aria-label={t('fill.signature.pad')}
          aria-describedby={describedBy}
          className="aspect-[3/1] w-full max-w-[30rem] cursor-crosshair touch-none rounded-md border border-border-subtle bg-white"
          onPointerDown={(event) => {
            if (disabled) {
              return;
            }
            event.currentTarget.setPointerCapture(event.pointerId);
            drawing.current = true;
            strokes.current.push([point(event)]);
            setHasInk(true);
            redraw();
          }}
          onPointerMove={(event) => {
            if (!drawing.current) {
              return;
            }
            strokes.current.at(-1)?.push(point(event));
            redraw();
          }}
          onPointerUp={() => {
            drawing.current = false;
          }}
          onPointerCancel={() => {
            drawing.current = false;
          }}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-typed`} className="text-sm text-content">
            {t('fill.signature.typedName')}
          </label>
          <input
            id={`${id}-typed`}
            type="text"
            autoComplete="name"
            value={typed}
            disabled={disabled}
            onChange={(event) => setTyped(event.target.value)}
            className={inputClass}
          />
          <canvas
            ref={canvas}
            aria-hidden="true"
            className="aspect-[3/1] w-full max-w-[30rem] rounded-md border border-border-subtle bg-white"
          />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {mode === 'draw' ? (
          <>
            <button
              type="button"
              className={buttonClass.ghost}
              disabled={disabled || !hasInk}
              onClick={() => {
                strokes.current.pop();
                setHasInk(strokes.current.length > 0);
                redraw();
              }}
            >
              {t('fill.signature.undo')}
            </button>
            <button
              type="button"
              className={buttonClass.ghost}
              disabled={disabled || !hasInk}
              onClick={() => {
                strokes.current = [];
                setHasInk(false);
                redraw();
              }}
            >
              {t('fill.signature.clear')}
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={buttonClass.ghost}
          disabled={disabled}
          onClick={() => setMode(mode === 'draw' ? 'type' : 'draw')}
        >
          {mode === 'draw' ? t('fill.signature.typeInstead') : t('fill.signature.drawInstead')}
        </button>
        <button
          type="button"
          className={buttonClass.secondary}
          disabled={disabled || saving}
          aria-busy={saving}
          onClick={() => void save()}
        >
          {saving ? t('fill.signature.saving') : t('fill.signature.use')}
        </button>
      </div>
      {problem === undefined ? null : (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}
