import { describe, expect, it } from 'vitest';
import {
  buildThemeCss,
  colourVariables,
  colours,
  darkColours,
  lightColours,
  scaleVariables,
  spacing,
  THEMES,
  toCssVariableName,
} from './index.js';

describe('the semantic layer', () => {
  it('defines the same tokens in both themes', () => {
    // A token that exists in light and not in dark is a screen that renders
    // `undefined` for somebody with dark mode on, and nobody notices until
    // they do.
    expect(Object.keys(darkColours).sort()).toEqual(Object.keys(lightColours).sort());
  });

  it('has a value for every token in every theme', () => {
    for (const theme of THEMES) {
      for (const [token, value] of Object.entries(colours[theme])) {
        expect(value, `${theme}.${token}`).toMatch(/^#[0-9a-f]{6}$/u);
      }
    }
  });

  it('actually differs between themes', () => {
    expect(lightColours.background).not.toBe(darkColours.background);
    expect(lightColours.text).not.toBe(darkColours.text);
  });

  it('inverts foreground and background between themes', () => {
    // The cheapest possible check that dark mode is dark: text is light on a
    // dark ground and the reverse.
    expect(lightColours.background).toBe('#f8fafc');
    expect(darkColours.background).toBe('#020617');
  });
});

describe('scales', () => {
  it('uses numbers, not strings', () => {
    // React Native's StyleSheet takes numbers; CSS needs a unit appended.
    // Converting one way is mechanical and the other is guesswork.
    for (const value of Object.values(spacing)) {
      expect(typeof value).toBe('number');
    }
  });

  it('increases monotonically', () => {
    const values = Object.values(spacing);
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]).toBeGreaterThan(values[index - 1] ?? -1);
    }
  });
});

describe('CSS custom property names', () => {
  it('converts camelCase to kebab-case', () => {
    expect(toCssVariableName('accentHover')).toBe('--colour-accent-hover');
    expect(toCssVariableName('surfaceMuted')).toBe('--colour-surface-muted');
  });

  it('leaves a single word alone', () => {
    expect(toCssVariableName('accent')).toBe('--colour-accent');
  });

  it('produces one variable per token, with no collisions', () => {
    const names = Object.keys(colourVariables('light'));

    expect(names).toHaveLength(Object.keys(lightColours).length);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('the generated stylesheet', () => {
  const css = buildThemeCss();

  it('defines the light theme on :root', () => {
    expect(css).toContain(':root {');
    expect(css).toContain(`--colour-background: ${lightColours.background};`);
  });

  it('lets an explicit choice beat the system preference', () => {
    // `:root:not([data-theme='light'])` inside the media query is what makes
    // "I chose light" survive a machine set to dark.
    expect(css).toContain("[data-theme='dark']");
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(":root:not([data-theme='light'])");
  });

  it('maps tokens into Tailwind, so bg-surface is a real utility', () => {
    expect(css).toContain('@theme inline');
    expect(css).toContain('--color-surface: var(--colour-surface);');
  });

  it('carries units on the values that need them', () => {
    const scales = scaleVariables();

    expect(scales['--space-4']).toBe('16px');
    expect(scales['--radius-md']).toBe('8px');
    expect(scales['--duration-fast']).toBe('120ms');
    // Line height is a ratio; a unit here would break inheritance.
    expect(scales['--leading-normal']).toBe('1.5');
  });

  it('says it is generated, where somebody about to edit it will look', () => {
    expect(css.startsWith('/*')).toBe(true);
    expect(css).toContain('Do not edit');
  });
});
