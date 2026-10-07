import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, startApi } from '../testing/api-harness.js';

/**
 * Public sign-up is off by default.
 *
 * Companies are set up by Integr8 from the platform dashboard (see
 * `PUBLIC_SIGNUP` in config.ts). A deployment that has not said otherwise must
 * refuse the self-serve flow at every step, in a way the page can explain.
 */

let api: ApiHarness;

beforeAll(async () => {
  api = await startApi({ env: { WEB_APP_URL: 'https://app.test.integr8' } });
});

afterAll(async () => {
  await api.close();
});

const publicCall = (url: string, payload: Record<string, unknown>) =>
  api.app.inject({
    method: 'POST',
    url,
    remoteAddress: api.remoteAddress,
    headers: { 'x-client-version': '1.0.0', 'x-client-app': 'web' },
    payload,
  });

describe('with PUBLIC_SIGNUP unset', () => {
  it('refuses to start a sign-up, and says who sets companies up', async () => {
    const response = await publicCall('/v1/signup', {
      email: 'stranger@example.com',
      companyName: 'Walk-in Ltd',
    });
    expect(response.statusCode, response.body).toBe(403);
    const body = JSON.parse(response.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('signup_closed');
    expect(body.error.message).toContain('Integr8');
  });

  it('refuses to verify or resend a link, so an old link cannot create a company', async () => {
    const verify = await publicCall('/v1/signup/verify', {
      token: 'anything',
      displayName: 'Somebody',
      password: 'correct horse battery staple',
    });
    expect(verify.statusCode).toBe(403);
    const resend = await publicCall('/v1/signup/resend', { email: 'stranger@example.com' });
    expect(resend.statusCode).toBe(403);
  });

  it('still records the public pages being viewed', async () => {
    // The pages exist either way, and the step carries nothing about a person.
    const response = await publicCall('/v1/signup/step', { step: 'landing.viewed' });
    expect(response.statusCode).toBe(202);
  });
});
