/**
 * A signature, drawn. Both renderers draw on a 480 × 160 surface and save a PNG
 * at that aspect, so a signature captured on a phone and one captured with a
 * mouse look the same side by side on a certificate.
 */

export const SIGNATURE_WIDTH = 480;
export const SIGNATURE_HEIGHT = 160;
export const SIGNATURE_STROKE = 2.5;
export const SIGNATURE_INK = '#111827';
export const SIGNATURE_PAPER = '#ffffff';

export type SignaturePoint = readonly [number, number];

/**
 * A point on the pad, from where a finger or pen touched a surface drawn at
 * some other size.
 */
export function toPadPoint(
  x: number,
  y: number,
  surface: { width: number; height: number },
): SignaturePoint {
  const scaleX = surface.width === 0 ? 1 : SIGNATURE_WIDTH / surface.width;
  const scaleY = surface.height === 0 ? 1 : SIGNATURE_HEIGHT / surface.height;
  const clamp = (value: number, maximum: number) => Math.min(maximum, Math.max(0, value));
  return [clamp(x * scaleX, SIGNATURE_WIDTH), clamp(y * scaleY, SIGNATURE_HEIGHT)];
}

/**
 * Whether a point is far enough from the last one to keep. A finger reports
 * dozens of points a second, many a fraction of a pixel apart; keeping them all
 * makes a long signature slow to redraw on a cheap phone without making it any
 * smoother.
 */
export function worthKeeping(
  previous: SignaturePoint | undefined,
  next: SignaturePoint,
  minimum = 1.5,
): boolean {
  if (previous === undefined) {
    return true;
  }
  return Math.hypot(next[0] - previous[0], next[1] - previous[1]) >= minimum;
}

/**
 * An SVG path for a set of strokes. A stroke of one point — a tap, the dot on an
 * "i" — is drawn as a dot rather than disappearing.
 */
export function strokesToPath(strokes: readonly (readonly SignaturePoint[])[]): string {
  const round = (value: number) => Math.round(value * 10) / 10;
  return strokes
    .filter((stroke) => stroke.length > 0)
    .map((stroke) => {
      const [first, ...rest] = stroke;
      const start = `M${String(round(first![0]))} ${String(round(first![1]))}`;
      if (rest.length === 0) {
        return `${start} l0.1 0`;
      }
      return `${start} ${rest.map(([x, y]) => `L${String(round(x))} ${String(round(y))}`).join(' ')}`;
    })
    .join(' ');
}
