import { describe, expect, it } from 'vitest';
import { buildAppInfo } from './app-info.js';

describe('@integr8/web app info', () => {
  it('identifies itself as web', () => {
    expect(buildAppInfo({ APP_ENV: 'test' }).id).toBe('web');
  });

  it('defaults to the development environment', () => {
    expect(buildAppInfo({}).environment).toBe('development');
  });

  it('rejects an unrecognised APP_ENV', () => {
    expect(() => buildAppInfo({ APP_ENV: 'prod' })).toThrow();
  });
});
