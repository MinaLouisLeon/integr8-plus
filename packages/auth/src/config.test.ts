import { describe, expect, it } from 'vitest';
import { DEVELOPMENT_ISSUER, loadAuthConfig } from './config.js';

/** The settings with no default, filled with anything: only the issuer is under test. */
const KEYS = {
  AUTH_SIGNING_KEY: '{"kty":"OKP"}',
  AUTH_SIGNING_KEY_ID: 'key-1',
  AUTH_VERIFICATION_KEYS: '[]',
  PLATFORM_SECRET_KEY: 'secret',
};

describe('the token issuer', () => {
  it('defaults to the development one on a laptop, in tests and in staging', () => {
    expect(loadAuthConfig(KEYS).AUTH_ISSUER).toBe(DEVELOPMENT_ISSUER);
    expect(loadAuthConfig({ ...KEYS, APP_ENV: 'staging' }).AUTH_ISSUER).toBe(DEVELOPMENT_ISSUER);
  });

  it('is refused in production when unset, a placeholder or the template value', () => {
    const production = { ...KEYS, APP_ENV: 'production' };
    expect(() => loadAuthConfig(production)).toThrow(/AUTH_ISSUER is not set/u);
    for (const issuer of [
      DEVELOPMENT_ISSUER,
      'https://api.your-domain.example',
      'https://api.integr8.example',
      'https://change-me',
    ]) {
      expect(() => loadAuthConfig({ ...production, AUTH_ISSUER: issuer }), issuer).toThrow(
        /AUTH_ISSUER is an example address/u,
      );
    }
  });

  it('is accepted in production when it is a real address', () => {
    expect(
      loadAuthConfig({
        ...KEYS,
        APP_ENV: 'production',
        AUTH_ISSUER: 'https://api.integr8-media.com',
      }).AUTH_ISSUER,
    ).toBe('https://api.integr8-media.com');
  });
});
