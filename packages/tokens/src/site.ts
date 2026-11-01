import type { SemanticColours } from './index.js';

/**
 * The Integr8 Media look: Integr8's own face, as www.integr8-media.com wears it.
 *
 * Integr8 Plus is one of Integr8 Media's products, so everything that is
 * Integr8's rather than a customer's wears the company site's look: the public
 * pages (home, features, pricing, help, sign-in, download, legal), the staff
 * dashboard at `/platform`, and the staff desktop app's frame. A company's own
 * workspace does not: it wears the company's brand, in light or dark.
 *
 * The values are the company site's (`src/app/globals.css` there), copied
 * rather than approximated, so the two sites read as one. One dark scheme only:
 * the company site has no light version, and a half-invented one would be the
 * first thing to drift.
 *
 * Applied by an attribute, `data-look="integr8"`, on the element that wraps
 * the pages concerned: the generated stylesheet redefines the semantic tokens
 * inside it, so every shared component (buttons, fields, tables, the dashboard
 * shell) follows without knowing anything about it.
 */
export const LOOK_ATTRIBUTE = 'data-look';
export const LOOK_VALUE = 'integr8';

/** The company site's palette, by its own names. */
export const integr8Media = {
  bg: '#07060b',
  bgSoft: '#100e18',
  fg: '#f4f2ff',
  muted: '#9a96b0',
  line: 'rgba(255, 255, 255, 0.08)',
  violet: '#7c5cff',
  cyan: '#22d3ee',
  lime: '#c6ff3d',
  pink: '#ff4fd8',
} as const;

/** Violet through cyan to lime: the gradient behind headline words and the scroll line. */
export const integr8Gradient = {
  stops: [integr8Media.violet, integr8Media.cyan, integr8Media.lime] as const,
  /** Left to right in English; the stylesheet mirrors it for right-to-left pages. */
  css: `linear-gradient(90deg, ${integr8Media.violet}, ${integr8Media.cyan} 50%, ${integr8Media.lime})`,
  cssRtl: `linear-gradient(270deg, ${integr8Media.violet}, ${integr8Media.cyan} 50%, ${integr8Media.lime})`,
} as const;

/**
 * Font stacks. The faces are bundled, never fetched from a font service: the
 * whole product is self-hosted, so `@integr8/tokens/fonts.css` declares them
 * from the `@fontsource` packages and the apps serve the files themselves.
 *
 * Each stack names the other script's face second, so a Latin word inside an
 * Arabic sentence (or the reverse) still lands on a face of the family rather
 * than the system's. Arabic pages put the Arabic faces first: Alexandria for
 * headings, IBM Plex Sans Arabic for text.
 */
export const integr8Fonts = {
  display: "'Unbounded Variable', 'Alexandria Variable', system-ui, sans-serif",
  body: "'Inter Variable', 'IBM Plex Sans Arabic', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono Variable', 'IBM Plex Sans Arabic', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  displayArabic: "'Alexandria Variable', 'Unbounded Variable', system-ui, sans-serif",
  bodyArabic:
    "'IBM Plex Sans Arabic', 'Inter Variable', system-ui, -apple-system, 'Segoe UI', sans-serif",
} as const;

/**
 * The semantic tokens inside the look, so the shared components need no
 * second set of classes. Lime is the accent, as on the company site's buttons,
 * with near-black on it; the status colours are the dark theme's, lifted a
 * little so they read on the deeper ground.
 */
export const integr8Colours: SemanticColours = {
  background: integr8Media.bg,
  surface: integr8Media.bgSoft,
  surfaceMuted: '#17141f',
  border: integr8Media.line,
  borderStrong: 'rgba(255, 255, 255, 0.16)',

  text: integr8Media.fg,
  textMuted: integr8Media.muted,
  textInverted: integr8Media.bg,

  accent: integr8Media.lime,
  accentHover: '#d6ff73',
  accentSubtle: 'rgba(198, 255, 61, 0.12)',
  onAccent: integr8Media.bg,

  success: '#4ade80',
  successSubtle: 'rgba(74, 222, 128, 0.12)',
  warning: '#fbbf24',
  warningSubtle: 'rgba(251, 191, 36, 0.12)',
  danger: '#f87171',
  dangerHover: '#fca5a5',
  dangerSubtle: 'rgba(248, 113, 113, 0.14)',

  focus: integr8Media.lime,

  shell: '#0b0a11',
  shellHover: 'rgba(255, 255, 255, 0.05)',
  shellActive: 'rgba(198, 255, 61, 0.12)',
  shellText: integr8Media.fg,
  shellTextMuted: integr8Media.muted,
  shellBorder: integr8Media.line,
};

/** `bgSoft` → `--site-bg-soft`: the raw palette, for the few rules that name it. */
export function siteVariableName(token: string): string {
  return `--site-${token.replaceAll(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase()}`;
}

/** The raw palette and the gradient as custom properties. */
export function sitePaletteVariables(): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(integr8Media).map(([token, value]) => [siteVariableName(token), value]),
    ),
    '--site-gradient': integr8Gradient.css,
  };
}
