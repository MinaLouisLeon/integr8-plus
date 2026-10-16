import { describe, expect, it } from 'vitest';
import { assertProductionReady, loadApiConfig } from '../config.js';
import { aiConfiguration, modelFor, servableLevel } from './configuration.js';

/**
 * The assistant's settings never stop the server (ADR-0002 D2): they decide
 * whether the assistant answers, and which model each level runs on (D3).
 */

const OPENAI = {
  APP_ENV: 'staging',
  AI_ENABLED: 'true',
  AI_PROVIDER: 'openai',
  AI_OPENAI_API_KEY: 'sk-test',
  AI_MODEL_HELP: 'gpt-6-luna',
  AI_MODEL_INSIGHTS: 'gpt-6-luna-insights',
  AI_MODEL_AGENT: 'gpt-6-luna-agent',
} as const;

describe('loading the settings', () => {
  it('starts with the selected provider’s key or models missing, and says what is wrong', () => {
    const config = loadApiConfig({ ...OPENAI, AI_OPENAI_API_KEY: '', AI_MODEL_HELP: undefined });
    const configuration = aiConfiguration(config);
    expect(configuration.ready).toBe(false);
    expect(configuration.servedLevels).toEqual([]);
    expect(configuration.problems.join('\n')).toMatch(/AI_OPENAI_API_KEY is not set/u);
    expect(configuration.problems.join('\n')).toMatch(/AI_MODEL_HELP is not set/u);
  });

  it('needs nothing from a provider that is not selected', () => {
    const config = loadApiConfig({
      APP_ENV: 'staging',
      AI_ENABLED: 'true',
      AI_PROVIDER: 'groq',
      AI_GROQ_API_KEY: 'gsk-test',
      AI_MODEL_HELP: 'llama',
    });
    expect(aiConfiguration(config).ready).toBe(true);
  });

  it('takes AI_PROVIDER=none as no provider by choice: library answers, nothing to fix (D12)', () => {
    for (const env of ['staging', 'production'] as const) {
      const config = loadApiConfig({
        APP_ENV: env,
        AI_ENABLED: 'true',
        AI_PROVIDER: 'none',
        // Model names left over from a provider are not used.
        AI_MODEL_HELP: 'gpt-6-luna',
      });
      expect(aiConfiguration(config)).toMatchObject({
        ready: false,
        libraryOnly: true,
        problems: [],
        servedLevels: [],
      });
      expect(modelFor('help', config)).toBeNull();
      expect(servableLevel('agent', config)).toBe('off');
    }
  });

  it('still flags the fake provider in production: it is not a way to run without AI', () => {
    const config = loadApiConfig({
      APP_ENV: 'production',
      AI_ENABLED: 'true',
      AI_PROVIDER: 'recording',
    });
    expect(aiConfiguration(config)).toMatchObject({ ready: false, libraryOnly: false });
    expect(aiConfiguration(config).problems.join('\n')).toMatch(/recording in production/u);
  });

  it('asks nothing of a deployment with the assistant off', () => {
    const config = loadApiConfig({ APP_ENV: 'staging', AI_PROVIDER: 'openai' });
    expect(aiConfiguration(config)).toMatchObject({ ready: false, problems: [] });
  });

  it('starts in production with the fake provider, and keeps the assistant off', () => {
    const production = {
      APP_ENV: 'production',
      SENTRY_DSN: 'https://x@sentry.example/1',
      API_RELEASE: '1.0.0',
      MEDIA_STORAGE: 'r2',
      CLOUDFLARE_ACCOUNT_ID: 'acc',
      R2_ACCESS_KEY_ID: 'key',
      R2_SECRET_ACCESS_KEY: 'secret',
      GEOCODER: 'mapbox',
      MAPBOX_ACCESS_TOKEN: 'pk.token',
      PUSH_SENDER: 'expo',
      BILLING_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      EMAIL_SENDER: 'resend',
      RESEND_API_KEY: 're_x',
      EMAIL_FROM: 'Integr8 <hello@example.com>',
      WEB_APP_URL: 'https://app.example.com',
      API_CORS_ORIGINS: 'https://app.example.com',
      AI_ENABLED: 'true',
      AI_PROVIDER: 'recording',
    } as const;
    const config = loadApiConfig(production);
    expect(() => assertProductionReady(config)).not.toThrow();
    expect(aiConfiguration(config).ready).toBe(false);
    expect(aiConfiguration(config).problems.join()).toMatch(/recording in production/u);
  });

  it('refuses a plain-HTTP OpenAI address in production, without refusing to start', () => {
    const config = loadApiConfig({
      ...OPENAI,
      APP_ENV: 'production',
      AI_OPENAI_BASE_URL: 'http://proxy.internal/v1',
    });
    expect(aiConfiguration(config).ready).toBe(false);
    expect(aiConfiguration(config).problems.join()).toMatch(/https/u);
  });
});

describe('the model each level runs on', () => {
  it('is that level’s own setting, never another level’s', () => {
    const config = loadApiConfig(OPENAI);
    expect(modelFor('help', config)).toBe('gpt-6-luna');
    expect(modelFor('insights', config)).toBe('gpt-6-luna-insights');
    expect(modelFor('agent', config)).toBe('gpt-6-luna-agent');
  });

  it('lowers a level whose model is missing to the highest one that has a model', () => {
    const config = loadApiConfig({ ...OPENAI, AI_MODEL_AGENT: undefined });
    expect(modelFor('agent', config)).toBeNull();
    expect(servableLevel('agent', config)).toBe('insights');
    expect(servableLevel('insights', config)).toBe('insights');
    expect(aiConfiguration(config).problems.join()).toMatch(/AI_MODEL_AGENT is not set/u);

    const helpOnly = loadApiConfig({
      ...OPENAI,
      AI_MODEL_AGENT: undefined,
      AI_MODEL_INSIGHTS: undefined,
    });
    expect(servableLevel('agent', helpOnly)).toBe('help');
    expect(servableLevel('off', helpOnly)).toBe('off');
  });

  it('serves nothing when the provider cannot answer at all', () => {
    const config = loadApiConfig({ ...OPENAI, AI_OPENAI_API_KEY: '' });
    expect(servableLevel('agent', config)).toBe('off');
  });

  it('gives the fake provider a recognisable model per level', () => {
    const config = loadApiConfig({ APP_ENV: 'test', AI_ENABLED: 'true' });
    expect(modelFor('insights', config)).toBe('recording-insights');
    expect(servableLevel('agent', config)).toBe('agent');
  });
});
