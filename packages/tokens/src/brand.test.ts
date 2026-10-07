import { describe, expect, it } from 'vitest';
import { brandAccent, brandAccentVariables, parseHexColour, relativeLuminance } from './brand.js';

describe('a company brand colour', () => {
  it('is read only as six hex digits', () => {
    expect(parseHexColour('#1D4ED8')).toEqual({ r: 29, g: 78, b: 216 });
    expect(parseHexColour(' #1d4ed8 ')).toEqual({ r: 29, g: 78, b: 216 });
    for (const bad of ['1D4ED8', '#1D4', '#1D4ED8FF', 'blue', '']) {
      expect(parseHexColour(bad), bad).toBeNull();
      expect(brandAccent(bad, 'light'), bad).toBeNull();
    }
  });

  it('keeps the colour as given in light, and lifts it in dark', () => {
    const light = brandAccent('#1d4ed8', 'light')!;
    const dark = brandAccent('#1d4ed8', 'dark')!;
    expect(light.accent).toBe('#1d4ed8');
    expect(relativeLuminance(parseHexColour(dark.accent)!)).toBeGreaterThan(
      relativeLuminance(parseHexColour(light.accent)!),
    );
  });

  it('puts white on a dark brand and near-black on a pale one', () => {
    expect(brandAccent('#1d4ed8', 'light')!.onAccent).toBe('#ffffff');
    expect(brandAccent('#fde047', 'light')!.onAccent).not.toBe('#ffffff');
  });

  it('derives a hover that differs from the accent, in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const accent = brandAccent('#16a34a', theme)!;
      expect(accent.accentHover).not.toBe(accent.accent);
      expect(accent.accentSubtle).not.toBe(accent.accent);
    }
  });

  it('names the same custom properties theme.css declares', () => {
    expect(Object.keys(brandAccentVariables('#1d4ed8', 'light')).sort()).toEqual([
      '--colour-accent',
      '--colour-accent-hover',
      '--colour-accent-subtle',
      '--colour-on-accent',
    ]);
    expect(brandAccentVariables('nope', 'light')).toEqual({});
  });
});
