import { describe, expect, it } from 'vitest';
import { isProductionLike, optionalEnv, requireEnv } from './environment.js';

describe('environments', () => {
  it('classifies staging and production as production-like', () => {
    expect(isProductionLike('production')).toBe(true);
    expect(isProductionLike('staging')).toBe(true);
    expect(isProductionLike('development')).toBe(false);
    expect(isProductionLike('test')).toBe(false);
  });
});

describe('requireEnv', () => {
  it('returns the value when set', () => {
    expect(requireEnv('DATABASE_URL', { DATABASE_URL: 'postgres://local' })).toBe(
      'postgres://local',
    );
  });

  it('throws naming the missing variable', () => {
    expect(() => requireEnv('DATABASE_URL', {})).toThrow(/DATABASE_URL/u);
  });

  it('treats a blank value as missing', () => {
    expect(() => requireEnv('DATABASE_URL', { DATABASE_URL: '   ' })).toThrow(/DATABASE_URL/u);
  });
});

describe('optionalEnv', () => {
  it('falls back when unset or blank', () => {
    expect(optionalEnv('PORT', '3000', {})).toBe('3000');
    expect(optionalEnv('PORT', '3000', { PORT: '' })).toBe('3000');
    expect(optionalEnv('PORT', '3000', { PORT: '8080' })).toBe('8080');
  });
});
