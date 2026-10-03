import { describe, expect, it } from 'vitest';
import { checkLogo, LOGO_MAX_BYTES } from './logo';

describe('deciding what may become a company logo', () => {
  it('accepts the formats every browser draws', () => {
    expect(checkLogo({ type: 'image/png', size: 10_000 })).toBeNull();
    expect(checkLogo({ type: 'image/jpeg', size: 10_000 })).toBeNull();
    expect(checkLogo({ type: 'image/webp', size: 10_000 })).toBeNull();
  });

  it('refuses what is not an image, and what is an image that can carry script', () => {
    expect(checkLogo({ type: 'application/pdf', size: 10 })).toBe('wrong_type');
    // The API refuses SVG too; saying so here saves an upload.
    expect(checkLogo({ type: 'image/svg+xml', size: 10 })).toBe('wrong_type');
    // A browser reports an empty type for a file it cannot identify.
    expect(checkLogo({ type: '', size: 10 })).toBe('wrong_type');
  });

  it('refuses a file over the limit, and allows one exactly on it', () => {
    expect(checkLogo({ type: 'image/png', size: LOGO_MAX_BYTES })).toBeNull();
    expect(checkLogo({ type: 'image/png', size: LOGO_MAX_BYTES + 1 })).toBe('too_large');
  });

  it('names the type before the size, because the type cannot be fixed by resizing', () => {
    expect(checkLogo({ type: 'image/tiff', size: LOGO_MAX_BYTES * 10 })).toBe('wrong_type');
  });
});
