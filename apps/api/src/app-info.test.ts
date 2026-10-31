import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAppInfo, VERSION } from './app-info.js';

describe('@integr8/api app info', () => {
  it('identifies itself as api', () => {
    expect(buildAppInfo({ APP_ENV: 'test' }).id).toBe('api');
  });

  it('defaults to the development environment', () => {
    expect(buildAppInfo({}).environment).toBe('development');
  });

  it('rejects an unrecognised APP_ENV', () => {
    expect(() => buildAppInfo({ APP_ENV: 'prod' })).toThrow();
  });

  // The API reported 1.1.0 for two releases because nothing compared the two.
  it('reports the version in the root package.json', () => {
    const root = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(root.version);
  });
});
