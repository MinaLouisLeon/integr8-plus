import { describe, expect, it } from 'vitest';

import { MissingBuildSettingError, resolvePublicEnv } from './env';

const blank = { apiBaseUrl: undefined, appEnv: undefined, sentryDsn: undefined };

describe('resolvePublicEnv', () => {
  it('uses what the build inlined', () => {
    expect(
      resolvePublicEnv(
        {
          apiBaseUrl: 'https://api.integr8-media.com',
          appEnv: 'production',
          sentryDsn: 'https://key@sentry.example/1',
        },
        false,
      ),
    ).toEqual({
      apiBaseUrl: 'https://api.integr8-media.com',
      appEnv: 'production',
      sentryDsn: 'https://key@sentry.example/1',
    });
  });

  it('falls back to a local server only in a development build', () => {
    expect(resolvePublicEnv(blank, true)).toEqual({
      apiBaseUrl: 'http://localhost:3000',
      appEnv: 'development',
      sentryDsn: undefined,
    });
  });

  it('refuses a release build with no server address', () => {
    expect(() => resolvePublicEnv(blank, false)).toThrow(MissingBuildSettingError);
    expect(() => resolvePublicEnv({ ...blank, apiBaseUrl: '' }, false)).toThrow(
      /EXPO_PUBLIC_API_BASE_URL/,
    );
  });

  it('treats a release build with no environment name as production', () => {
    expect(resolvePublicEnv({ ...blank, apiBaseUrl: 'https://api.example' }, false).appEnv).toBe(
      'production',
    );
  });
});
