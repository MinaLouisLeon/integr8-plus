import { palette, type Theme, toCssVariableName } from './index.js';

/**
 * A company's accent colour, turned into the four accent tokens.
 *
 * Each company's apps wear its own brand: one colour an owner enters on the
 * settings screen as `#rrggbb`. The semantic layer needs more than one — a
 * hover shade, a tint for subtle fills and a text colour that reads on top of
 * it — and deriving those here means a company gives us one value and every
 * button, badge and focus ring agrees, in both themes.
 *
 * Plain arithmetic rather than a colour library: three apps import this, one
 * of them on a phone, and a dependency for four shades is a dependency too far.
 */

export interface BrandAccent {
  accent: string;
  accentHover: string;
  accentSubtle: string;
  onAccent: string;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rrggbb` only, case-insensitive. Anything else is null, never a guess. */
export function parseHexColour(value: string): Rgb | null {
  const match = /^#([0-9a-f]{6})$/iu.exec(value.trim());
  if (match === null) {
    return null;
  }
  const hex = match[1] ?? '';
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function toHex({ r, g, b }: Rgb): string {
  const part = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** `amount` of the way from `from` to `to`, per channel. */
function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
  };
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

// Read when first used rather than at import: `index.ts` re-exports this
// module, so the palette is not yet defined while this file is evaluating.
const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const darkSurface = (): Rgb => parseHexColour(palette.slate[950])!;

/**
 * The accent tokens for a brand colour in a theme, or null when the value is
 * not a colour — the caller then leaves the product's own accent in place.
 *
 * Light: the colour as given, a darker hover, a near-white tint. Dark: the
 * colour lifted a little so it still reads on a dark surface, a lighter
 * hover, a tint mixed towards the surface. Text on the accent is white or near
 * black by the accent's luminance, which keeps a pale brand legible.
 */
export function brandAccent(colour: string, theme: Theme): BrandAccent | null {
  const rgb = parseHexColour(colour);
  if (rgb === null) {
    return null;
  }

  const accent = theme === 'dark' ? mix(rgb, WHITE, 0.12) : rgb;
  const onAccent = relativeLuminance(accent) > 0.45 ? palette.slate[950] : palette.white;

  return theme === 'dark'
    ? {
        accent: toHex(accent),
        accentHover: toHex(mix(accent, WHITE, 0.18)),
        accentSubtle: toHex(mix(accent, darkSurface(), 0.75)),
        onAccent,
      }
    : {
        accent: toHex(accent),
        accentHover: toHex(mix(accent, BLACK, 0.15)),
        accentSubtle: toHex(mix(accent, WHITE, 0.9)),
        onAccent,
      };
}

/**
 * The same four, as the CSS custom properties `theme.css` declares, so a DOM
 * app can set them on `document.documentElement` and every Tailwind utility
 * built on `--color-accent` follows without a rebuild.
 */
export function brandAccentVariables(colour: string, theme: Theme): Record<string, string> {
  const accent = brandAccent(colour, theme);
  if (accent === null) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(accent).map(([token, value]) => [toCssVariableName(token), value]),
  );
}
