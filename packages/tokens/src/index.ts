/**
 * `@integr8/tokens` — the design system as data.
 *
 * Data, not CSS, because React Native cannot use CSS. One set of values feeds
 * three renderers: the Next.js app and the desktop SPA turn them into CSS
 * custom properties that Tailwind reads, and the mobile app imports this module
 * directly.
 *
 * The rule this package exists to enforce is that a colour or a spacing step
 * has exactly one definition. Three apps each with their own `#0f172a` is three
 * apps that drift apart by the third design change.
 *
 * This is deliberately not a component library. P01's note stands: React DOM
 * and React Native do not share widgets usefully, so tokens and logic are
 * shared and the widgets are written twice.
 */

// ---------------------------------------------------------------------------
// Palette — raw values, referenced by the semantic layer and by nothing else
// ---------------------------------------------------------------------------

/**
 * The raw ramps.
 *
 * A screen never names one of these. It names a semantic token, so that "the
 * warning colour changed" is one edit here rather than a search for every
 * amber in the product.
 */
export const palette = {
  slate: {
    50: '#f8fafc',
    100: '#f1f5f9',
    200: '#e2e8f0',
    300: '#cbd5e1',
    400: '#94a3b8',
    500: '#64748b',
    600: '#475569',
    700: '#334155',
    800: '#1e293b',
    900: '#0f172a',
    950: '#020617',
  },
  blue: {
    50: '#eff6ff',
    100: '#dbeafe',
    300: '#93c5fd',
    500: '#3b82f6',
    600: '#2563eb',
    700: '#1d4ed8',
    900: '#1e3a8a',
  },
  green: {
    50: '#f0fdf4',
    300: '#86efac',
    500: '#22c55e',
    600: '#16a34a',
    900: '#14532d',
  },
  amber: {
    50: '#fffbeb',
    300: '#fcd34d',
    500: '#f59e0b',
    600: '#d97706',
    900: '#78350f',
  },
  red: {
    50: '#fef2f2',
    300: '#fca5a5',
    500: '#ef4444',
    600: '#dc2626',
    900: '#7f1d1d',
  },
  white: '#ffffff',
  black: '#000000',
} as const;

// ---------------------------------------------------------------------------
// Semantic colour — what a screen actually names
// ---------------------------------------------------------------------------

export interface SemanticColours {
  /** The page behind everything. */
  background: string;
  /** A card, a panel, a raised row. */
  surface: string;
  /** A surface that needs to recede — a table header, a disabled field. */
  surfaceMuted: string;
  border: string;
  borderStrong: string;

  text: string;
  textMuted: string;
  /** Text on an accent or status fill. */
  textInverted: string;

  accent: string;
  accentHover: string;
  accentSubtle: string;
  onAccent: string;

  success: string;
  successSubtle: string;
  warning: string;
  warningSubtle: string;
  danger: string;
  dangerHover: string;
  dangerSubtle: string;

  /** The keyboard focus ring. Never removed, only restyled. */
  focus: string;

  /**
   * The dashboard shell: the side menu and the top bar. Its own tokens rather
   * than the surface's, because a company may colour the shell (0022) while
   * the pages inside keep reading on their own surfaces.
   */
  shell: string;
  shellHover: string;
  shellActive: string;
  shellText: string;
  shellTextMuted: string;
  shellBorder: string;
}

export const lightColours: SemanticColours = {
  background: palette.slate[50],
  surface: palette.white,
  surfaceMuted: palette.slate[100],
  border: palette.slate[200],
  borderStrong: palette.slate[300],

  text: palette.slate[900],
  textMuted: palette.slate[500],
  textInverted: palette.white,

  accent: palette.blue[600],
  accentHover: palette.blue[700],
  accentSubtle: palette.blue[50],
  onAccent: palette.white,

  success: palette.green[600],
  successSubtle: palette.green[50],
  warning: palette.amber[600],
  warningSubtle: palette.amber[50],
  danger: palette.red[600],
  dangerHover: palette.red[500],
  dangerSubtle: palette.red[50],

  focus: palette.blue[500],

  shell: palette.white,
  shellHover: palette.slate[100],
  shellActive: palette.blue[50],
  shellText: palette.slate[900],
  shellTextMuted: palette.slate[500],
  shellBorder: palette.slate[200],
};

export const darkColours: SemanticColours = {
  background: palette.slate[950],
  surface: palette.slate[900],
  surfaceMuted: palette.slate[800],
  border: palette.slate[800],
  borderStrong: palette.slate[700],

  text: palette.slate[100],
  textMuted: palette.slate[400],
  textInverted: palette.slate[900],

  accent: palette.blue[500],
  accentHover: palette.blue[300],
  accentSubtle: palette.blue[900],
  onAccent: palette.slate[950],

  success: palette.green[500],
  successSubtle: palette.green[900],
  warning: palette.amber[500],
  warningSubtle: palette.amber[900],
  danger: palette.red[500],
  dangerHover: palette.red[300],
  dangerSubtle: palette.red[900],

  focus: palette.blue[300],

  shell: palette.slate[900],
  shellHover: palette.slate[800],
  shellActive: palette.blue[900],
  shellText: palette.slate[100],
  shellTextMuted: palette.slate[400],
  shellBorder: palette.slate[800],
};

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export const colours: Readonly<Record<Theme, SemanticColours>> = Object.freeze({
  light: lightColours,
  dark: darkColours,
});

// ---------------------------------------------------------------------------
// Spacing, type, radii
// ---------------------------------------------------------------------------

/**
 * A four-pixel scale, in numbers rather than strings.
 *
 * Numbers because React Native's `StyleSheet` takes numbers and CSS needs a
 * unit appended; converting one way is easy and the other is guesswork.
 */
export const spacing = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
  20: 80,
} as const;

export type SpacingStep = keyof typeof spacing;

export const fontSize = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
} as const;

export const lineHeight = {
  tight: 1.25,
  snug: 1.375,
  normal: 1.5,
  relaxed: 1.625,
} as const;

export const fontWeight = {
  normal: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

/**
 * Font stacks.
 *
 * `system-ui` first everywhere: it is the face the operating system already
 * renders well at small sizes, it needs no download, and on a phone in a plant
 * room a web font that has not arrived is a screen of nothing.
 */
export const fontFamily = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
} as const;

export const radii = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  full: 9999,
} as const;

/**
 * Motion.
 *
 * Short, because these are interface transitions rather than decoration, and
 * because everything here has to be dropped entirely when the operating system
 * asks for reduced motion.
 */
export const duration = {
  fast: 120,
  normal: 200,
  slow: 320,
} as const;

/** Breakpoints, in pixels. Used by the two DOM apps; mobile has one width. */
export const breakpoint = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const;

// ---------------------------------------------------------------------------
// CSS custom properties
// ---------------------------------------------------------------------------

/** `accentHover` → `--colour-accent-hover`. */
export function toCssVariableName(token: string): string {
  return `--colour-${token.replaceAll(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase()}`;
}

/**
 * One theme as CSS custom properties.
 *
 * Custom properties rather than two compiled stylesheets, because switching
 * theme then changes one attribute on `<html>` instead of loading a second
 * sheet — and because the same variables are readable from a devtools panel,
 * which is where a designer checks whether the value they asked for arrived.
 */
export function colourVariables(theme: Theme): Record<string, string> {
  return Object.fromEntries(
    Object.entries(colours[theme]).map(([token, value]) => [toCssVariableName(token), value]),
  );
}

/** Spacing, type, radii and motion as custom properties. Theme-independent. */
export function scaleVariables(): Record<string, string> {
  return {
    ...prefixed('--space', spacing, (value) => `${String(value)}px`),
    ...prefixed('--text', fontSize, (value) => `${String(value)}px`),
    ...prefixed('--leading', lineHeight, String),
    ...prefixed('--weight', fontWeight, String),
    ...prefixed('--radius', radii, (value) => `${String(value)}px`),
    ...prefixed('--duration', duration, (value) => `${String(value)}ms`),
    '--font-sans': fontFamily.sans,
    '--font-mono': fontFamily.mono,
  };
}

function prefixed<T extends Record<string, string | number>>(
  prefix: string,
  values: T,
  format: (value: T[keyof T]) => string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [`${prefix}-${key}`, format(value as T[keyof T])]),
  );
}

/**
 * The stylesheet the two DOM apps import.
 *
 * Generated at build time rather than written by hand, so a token added to this
 * file cannot be forgotten in the CSS. `@theme inline` is how Tailwind v4 is
 * told about them, which makes `bg-surface` and `text-muted` real utilities
 * rather than arbitrary values.
 */
export function buildThemeCss(): string {
  const light = declarations(colourVariables('light'));
  const dark = declarations(colourVariables('dark'));
  const scales = declarations(scaleVariables());

  return `/*
 * Generated by @integr8/tokens. Do not edit.
 *   pnpm --filter @integr8/tokens css
 *
 * Dark theme applies when the document carries data-theme="dark", and also
 * when the operating system asks for it and the document has not chosen
 * otherwise — so an explicit choice always wins over the system preference.
 */

:root {
${light}
${scales}
}

[data-theme='dark'] {
${dark}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
${indent(dark)}
  }
}

/* Tailwind v4 reads these, so bg-surface and text-muted are real utilities. */
@theme inline {
  --color-background: var(--colour-background);
  --color-surface: var(--colour-surface);
  --color-surface-muted: var(--colour-surface-muted);
  --color-border-subtle: var(--colour-border);
  --color-border-strong: var(--colour-border-strong);
  --color-content: var(--colour-text);
  --color-content-muted: var(--colour-text-muted);
  --color-content-inverted: var(--colour-text-inverted);
  --color-accent: var(--colour-accent);
  --color-accent-hover: var(--colour-accent-hover);
  --color-accent-subtle: var(--colour-accent-subtle);
  --color-on-accent: var(--colour-on-accent);
  --color-success: var(--colour-success);
  --color-success-subtle: var(--colour-success-subtle);
  --color-warning: var(--colour-warning);
  --color-warning-subtle: var(--colour-warning-subtle);
  --color-danger: var(--colour-danger);
  --color-danger-hover: var(--colour-danger-hover);
  --color-danger-subtle: var(--colour-danger-subtle);
  --color-focus: var(--colour-focus);
  --color-shell: var(--colour-shell);
  --color-shell-hover: var(--colour-shell-hover);
  --color-shell-active: var(--colour-shell-active);
  --color-shell-text: var(--colour-shell-text);
  --color-shell-text-muted: var(--colour-shell-text-muted);
  --color-shell-border: var(--colour-shell-border);

  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);

  --radius-sm: var(--radius-sm);
  --radius-md: var(--radius-md);
  --radius-lg: var(--radius-lg);
  --radius-full: var(--radius-full);
}
`;
}

function declarations(variables: Record<string, string>): string {
  return Object.entries(variables)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
}

function indent(block: string): string {
  return block
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// A company's own accent
// ---------------------------------------------------------------------------

export {
  brandAccent,
  brandAccentVariables,
  brandShell,
  brandShellVariables,
  type BrandShell,
  parseHexColour,
  relativeLuminance,
  type BrandAccent,
} from './brand.js';
