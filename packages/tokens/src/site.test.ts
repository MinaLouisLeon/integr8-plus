import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildThemeCss,
  integr8Colours,
  integr8Fonts,
  integr8Media,
  lightColours,
  lookVariables,
  parseHexColour,
  relativeLuminance,
  toCssVariableName,
} from './index.js';

/** WCAG contrast between two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const first = parseHexColour(a);
  const second = parseHexColour(b);
  if (first === null || second === null) {
    throw new Error(`not a colour: ${a} / ${b}`);
  }
  const [light, dark] = [relativeLuminance(first), relativeLuminance(second)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe('the Integr8 Media look', () => {
  it('uses the company site’s palette, value for value', () => {
    // Copied from www.integr8-media.com's globals.css. A drift here is the two
    // sites no longer looking like one company.
    expect(integr8Media).toEqual({
      bg: '#07060b',
      bgSoft: '#100e18',
      fg: '#f4f2ff',
      muted: '#9a96b0',
      line: 'rgba(255, 255, 255, 0.08)',
      violet: '#7c5cff',
      cyan: '#22d3ee',
      lime: '#c6ff3d',
      pink: '#ff4fd8',
    });
  });

  it('defines every semantic token inside the look', () => {
    expect(Object.keys(integr8Colours).sort()).toEqual(Object.keys(lightColours).sort());
  });

  it('keeps text readable on its grounds', () => {
    expect(contrast(integr8Colours.text, integr8Colours.background)).toBeGreaterThan(7);
    expect(contrast(integr8Colours.textMuted, integr8Colours.background)).toBeGreaterThan(4.5);
    expect(contrast(integr8Colours.textMuted, integr8Colours.surface)).toBeGreaterThan(4.5);
    expect(contrast(integr8Colours.onAccent, integr8Colours.accent)).toBeGreaterThan(7);
    expect(contrast(integr8Colours.danger, integr8Colours.background)).toBeGreaterThan(4.5);
  });

  it('puts the Arabic faces first only in the Arabic stacks', () => {
    expect(integr8Fonts.display.startsWith("'Unbounded Variable'")).toBe(true);
    expect(integr8Fonts.body.startsWith("'Inter Variable'")).toBe(true);
    expect(integr8Fonts.displayArabic.startsWith("'Alexandria Variable'")).toBe(true);
    expect(integr8Fonts.bodyArabic.startsWith("'IBM Plex Sans Arabic'")).toBe(true);
  });

  it('scopes the look to an attribute and keeps the default themes as they were', () => {
    const css = buildThemeCss();
    expect(css).toContain("[data-look='integr8'] {");
    expect(css).toContain(`${toCssVariableName('accent')}: ${integr8Media.lime};`);
    expect(css).toContain("[data-look='integr8']:lang(ar)");
    // The company workspace's light theme is untouched by the look.
    expect(css).toContain(`--colour-accent: ${lightColours.accent};`);
    expect(css).toContain('--color-lime: var(--site-lime);');
    expect(css).toContain('--font-display: var(--font-site-display);');
    expect(Object.keys(lookVariables())).toContain('--font-sans');
  });

  it('names faces the fonts stylesheet actually declares', () => {
    const fonts = readFileSync(new URL('../fonts.css', import.meta.url), 'utf8');
    for (const pkg of [
      '@fontsource-variable/unbounded',
      '@fontsource-variable/inter',
      '@fontsource-variable/jetbrains-mono',
      '@fontsource-variable/alexandria',
      '@fontsource/ibm-plex-sans-arabic',
    ]) {
      expect(fonts).toContain(`@import '${pkg}/`);
    }
    // Nothing from a font service: the product is self-hosted.
    expect(fonts).not.toMatch(/https?:\/\//u);
  });

  it('is generated into the committed stylesheet', () => {
    const committed = readFileSync(new URL('../theme.css', import.meta.url), 'utf8');
    expect(committed).toBe(buildThemeCss());
  });
});
