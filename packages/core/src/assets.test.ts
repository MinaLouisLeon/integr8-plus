import { describe, expect, it } from 'vitest';
import {
  assetTagLink,
  formatAssetReference,
  newTagCode,
  normalizeTagCode,
  parseAssetReference,
  tagCodeOf,
  TAG_CODE_LENGTH,
  warrantyState,
} from './assets.js';

describe('asset references', () => {
  it('formats and reads them however they are typed', () => {
    expect(formatAssetReference(7)).toBe('AS-000007');
    expect(parseAssetReference('AS-000007')).toBe(7);
    expect(parseAssetReference('as7')).toBe(7);
    expect(parseAssetReference(' 123 ')).toBe(123);
    expect(parseAssetReference('AS-0')).toBeUndefined();
    expect(parseAssetReference('INV-7')).toBeUndefined();
  });
});

describe('tag codes', () => {
  it('are twelve Crockford characters from the random source', () => {
    const code = newTagCode((bytes) => bytes.map((_, index) => index * 37));
    expect(code).toHaveLength(TAG_CODE_LENGTH);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/u);
    expect(newTagCode()).not.toBe(newTagCode());
  });

  it('survive retyping: case, dashes and look-alike letters', () => {
    expect(normalizeTagCode('7k2m-9p4q-x8zt')).toBe('7K2M9P4QX8ZT');
    expect(normalizeTagCode('OIL0ABCDEFGH')).toBe('0110ABCDEFGH');
    expect(normalizeTagCode('7K2M9P4QX8Z')).toBeUndefined();
    expect(normalizeTagCode('7K2M9P4QX8ZU')).toBeUndefined();
  });

  it('come out of a scanned link from any host, or stand alone', () => {
    const link = assetTagLink('https://app.example.com/', '7K2M9P4QX8ZT');
    expect(link).toBe('https://app.example.com/a/7K2M9P4QX8ZT');
    expect(tagCodeOf(link)).toBe('7K2M9P4QX8ZT');
    expect(tagCodeOf('https://acme.example/portal/a/7k2m9p4qx8zt/?ref=x')).toBe('7K2M9P4QX8ZT');
    expect(tagCodeOf('7K2M9P4QX8ZT')).toBe('7K2M9P4QX8ZT');
    expect(tagCodeOf('https://app.example.com/q/7K2M9P4QX8ZT')).toBeUndefined();
    expect(tagCodeOf('SN-4471-B')).toBeUndefined();
  });
});

describe('warranty', () => {
  it('is covered, then expiring within the window, then expired the day after', () => {
    expect(warrantyState(null, '2026-10-11', 60)).toBe('none');
    expect(warrantyState('2027-01-01', '2026-10-11', 60)).toBe('covered');
    expect(warrantyState('2026-12-10', '2026-10-11', 60)).toBe('expiring');
    expect(warrantyState('2026-12-11', '2026-10-11', 60)).toBe('covered');
    expect(warrantyState('2026-10-11', '2026-10-11', 0)).toBe('expiring');
    expect(warrantyState('2026-10-10', '2026-10-11', 60)).toBe('expired');
  });
});
