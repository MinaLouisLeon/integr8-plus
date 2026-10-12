import { describe, expect, it } from 'vitest';
import { safeReturnPath, signInReturningTo } from './return-path';

describe('the return path after signing in', () => {
  it('keeps a path on this site, with its query', () => {
    expect(safeReturnPath('/a/7K2M9P4QX8ZT')).toBe('/a/7K2M9P4QX8ZT');
    expect(safeReturnPath('/work-orders?state=open')).toBe('/work-orders?state=open');
    expect(signInReturningTo('/a/7K2M9P4QX8ZT')).toBe('/sign-in?next=%2Fa%2F7K2M9P4QX8ZT');
  });

  it('refuses anything that could leave the site or loop', () => {
    for (const raw of [
      null,
      '',
      'https://evil.example/a/x',
      '//evil.example/a/x',
      '/\\evil.example',
      '/\t/evil.example',
      'javascript:alert(1)',
      'a/relative',
      '/sign-in?next=/a/x',
      `/${'x'.repeat(600)}`,
    ]) {
      expect(safeReturnPath(raw), String(raw)).toBeUndefined();
    }
    expect(signInReturningTo('//evil.example')).toBe('/sign-in');
  });
});
