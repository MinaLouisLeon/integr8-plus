import { describe, expect, it } from 'vitest';
import { exampleValueVerdict } from './example-values.js';

/** What the bootstrap service is given, straight from deploy/.env.example. */
const TEMPLATE = {
  DATABASE_URL_ADMIN: 'postgres://postgres:change-me-owner-password@postgres:5432/integr8',
  DATABASE_URL: 'postgres://integr8_app:change-me-app-password@postgres:5432/integr8',
  INTEGR8_APP_PASSWORD: 'change-me-app-password',
  INTEGR8_AUTH_PASSWORD: 'change-me-auth-password',
  INTEGR8_PLATFORM_PASSWORD: 'change-me-platform-password',
};

const GENERATED = 'q7Vb0nX2kLm9Pz4Rt6Yw1Hs8';

describe('database commands and the example values', () => {
  it('refuses bootstrap and migrations in production, naming each setting but no value', () => {
    for (const command of ['bootstrap', 'deploy', 'up', 'down']) {
      const verdict = exampleValueVerdict({ ...TEMPLATE, APP_ENV: 'production' }, command);
      expect(verdict.refuse[0]).toBe(`Refusing to run "${command}" in production:`);
      const said = verdict.refuse.join('\n');
      for (const name of Object.keys(TEMPLATE)) {
        expect(said).toContain(`${name} still holds`);
      }
      expect(said).not.toContain('owner-password');
    }
  });

  it('refuses a database password shorter than sixteen characters in production', () => {
    const verdict = exampleValueVerdict(
      {
        APP_ENV: 'production',
        DATABASE_URL_ADMIN: `postgres://postgres:${GENERATED}@postgres:5432/integr8`,
        INTEGR8_APP_PASSWORD: 'fifteen-chars!!',
      },
      'bootstrap',
    );
    expect(verdict.refuse.join('\n')).toMatch(/INTEGR8_APP_PASSWORD is shorter than 16/u);
    expect(verdict.refuse.join('\n')).not.toContain('fifteen');
  });

  it('lets reading commands run, and warns in staging without stopping', () => {
    expect(exampleValueVerdict({ ...TEMPLATE, APP_ENV: 'production' }, 'status').refuse).toEqual(
      [],
    );
    const staging = exampleValueVerdict({ ...TEMPLATE, APP_ENV: 'staging' }, 'deploy');
    expect(staging.refuse).toEqual([]);
    expect(staging.warn).toHaveLength(Object.keys(TEMPLATE).length);
    expect(exampleValueVerdict({ ...TEMPLATE, APP_ENV: 'development' }, 'up')).toEqual({
      refuse: [],
      warn: [],
    });
  });

  it('has nothing to say about generated passwords', () => {
    expect(
      exampleValueVerdict(
        {
          APP_ENV: 'production',
          DATABASE_URL_ADMIN: `postgres://postgres:${GENERATED}@postgres:5432/integr8`,
          INTEGR8_APP_PASSWORD: GENERATED,
        },
        'deploy',
      ),
    ).toEqual({ refuse: [], warn: [] });
  });
});
