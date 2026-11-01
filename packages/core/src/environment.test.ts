import { describe, expect, it } from 'vitest';
import {
  connectionPassword,
  exampleValueProblems,
  hasExampleAddress,
  isExampleHost,
  isProductionLike,
  optionalEnv,
  requireEnv,
} from './environment.js';

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

describe('example values a deployment must not run on', () => {
  const STRONG = 'Zq8v1Lx0pYt5Rm2Kc7Hn3Wb9';

  it('names every setting still holding change-me, without printing the value', () => {
    const problems = exampleValueProblems({
      POSTGRES_PASSWORD: 'change-me-owner-password',
      DATABASE_URL: 'postgres://integr8_app:change-me-app-password@postgres:5432/integr8',
      PLATFORM_SECRET_KEY: 'CHANGE-ME',
      // Not a password, key or address: somebody's sentence, left alone.
      CONTACT_EMAIL: 'change-me@example.com',
    });
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toMatch(/^POSTGRES_PASSWORD still holds/mu);
    expect(problems.join('\n')).toMatch(/^DATABASE_URL still holds/mu);
    expect(problems.join('\n')).toMatch(/^PLATFORM_SECRET_KEY still holds/mu);
    expect(problems.join('\n')).not.toContain('owner-password');
    expect(problems.join('\n')).not.toContain('CONTACT_EMAIL');
  });

  it('names an address on a placeholder host, in a list too', () => {
    const problems = exampleValueProblems({
      WEB_APP_URL: 'https://app.your-domain.example',
      AUTH_ISSUER: 'https://api.integr8.local',
      API_CORS_ORIGINS: 'https://app.integr8-media.com,https://app.your-domain.example',
      API_PUBLIC_URL: 'https://api.integr8-media.com',
      SENTRY_DSN: 'https://key@o1.ingest.sentry.io/2',
      // An internal service may have a .local name; never a .example one.
      AI_OPENAI_BASE_URL: 'http://models.local/v1',
      R2_ENDPOINT: 'https://r2.your-domain.example',
    });
    expect(problems.map((problem) => problem.split(' ')[0])).toEqual([
      'API_CORS_ORIGINS',
      'AUTH_ISSUER',
      'R2_ENDPOINT',
      'WEB_APP_URL',
    ]);
  });

  it('refuses a short database password, alone or inside its address', () => {
    const problems = exampleValueProblems({
      INTEGR8_APP_PASSWORD: 'short-password',
      INTEGR8_AUTH_PASSWORD: STRONG,
      DATABASE_URL_PLATFORM: 'postgres://integr8_platform:tiny@postgres:5432/integr8',
      DATABASE_URL_AUTH: `postgres://integr8_auth:${STRONG}@postgres:5432/integr8`,
    });
    expect(problems).toEqual([
      expect.stringMatching(/^INTEGR8_APP_PASSWORD is shorter than 16 characters/u),
      expect.stringMatching(/^The password in DATABASE_URL_PLATFORM is shorter than 16/u),
    ]);
    expect(problems.join()).not.toContain('tiny');
  });

  it('has nothing to say about a filled-in file', () => {
    expect(
      exampleValueProblems({
        POSTGRES_PASSWORD: STRONG,
        DATABASE_URL_ADMIN: `postgres://postgres:${encodeURIComponent(`${STRONG}/+=`)}@postgres:5432/integr8`,
        WEB_APP_URL: 'https://app.integr8-media.com',
        AUTH_ISSUER: 'https://api.integr8-media.com',
        API_CORS_ORIGINS: 'https://app.integr8-media.com,tauri://localhost,http://tauri.localhost',
        HR_DATA_KEY: '',
      }),
    ).toEqual([]);
  });

  it('reads hosts and passwords out of addresses', () => {
    expect(isExampleHost('api.your-domain.example')).toBe(true);
    expect(isExampleHost('api.integr8.local')).toBe(true);
    expect(isExampleHost('app.example.com')).toBe(false);
    expect(isExampleHost('localhost')).toBe(false);
    expect(isExampleHost('models.local', { local: false })).toBe(false);
    expect(isExampleHost('api.your-domain.example', { local: false })).toBe(true);
    expect(hasExampleAddress('postgres://u:p.local@db.internal/x')).toBe(false);
    expect(connectionPassword('postgres://u:p%40ss@db/x')).toBe('p@ss');
    expect(connectionPassword('postgres://u@db/x')).toBeUndefined();
  });
});
