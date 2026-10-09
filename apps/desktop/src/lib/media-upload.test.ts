import { describe, expect, it } from 'vitest';
import {
  APP_ICON_MIN_SIZE,
  checkIconDimensions,
  checkImageFile,
  IMAGE_MAX_BYTES,
} from './media-upload';

/**
 * The checks that run before a byte is uploaded. The API refuses the same
 * things, but a refusal after a two-megabyte upload is a worse experience than
 * a sentence before it; these decide which sentence.
 */

describe('what may be a logo', () => {
  it('accepts the three formats every browser draws', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(checkImageFile({ type, size: 1_000 })).toBeNull();
    }
  });

  it('refuses a type first, then a size', () => {
    expect(checkImageFile({ type: 'image/svg+xml', size: 10 })).toBe('wrong_type');
    expect(checkImageFile({ type: 'image/gif', size: 10 })).toBe('wrong_type');
    expect(checkImageFile({ type: 'image/svg+xml', size: IMAGE_MAX_BYTES + 1 })).toBe('wrong_type');
    expect(checkImageFile({ type: 'image/png', size: IMAGE_MAX_BYTES + 1 })).toBe('too_large');
    expect(checkImageFile({ type: 'image/png', size: IMAGE_MAX_BYTES })).toBeNull();
  });
});

describe('what may be an app icon', () => {
  it('must be square', () => {
    expect(checkIconDimensions({ width: 1024, height: 1000 })).toBe('not_square');
  });

  it('must be at least the store minimum on a side', () => {
    expect(
      checkIconDimensions({ width: APP_ICON_MIN_SIZE - 1, height: APP_ICON_MIN_SIZE - 1 }),
    ).toBe('too_small');
    expect(checkIconDimensions({ width: APP_ICON_MIN_SIZE, height: APP_ICON_MIN_SIZE })).toBeNull();
    expect(checkIconDimensions({ width: 1024, height: 1024 })).toBeNull();
  });
});
