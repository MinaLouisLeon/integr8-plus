import { describe, expect, it } from 'vitest';
import { appInfoSchema, describeApp } from './app-info.js';

const info = appInfoSchema.parse({
  id: 'api',
  displayName: 'Integr8 API',
  environment: 'development',
  version: '0.1.0',
});

describe('app info', () => {
  it('renders a boot banner', () => {
    expect(describeApp(info)).toBe('Integr8 API (api) v0.1.0 [development]');
  });

  it('rejects an unknown app id', () => {
    expect(appInfoSchema.safeParse({ ...info, id: 'admin' }).success).toBe(false);
  });

  it('rejects a non-semver version', () => {
    expect(appInfoSchema.safeParse({ ...info, version: 'v1' }).success).toBe(false);
  });
});
