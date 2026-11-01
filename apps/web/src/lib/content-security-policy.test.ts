import { describe, expect, it } from 'vitest';
import {
  contentSecurityPolicy,
  R2_HOSTS,
  securityHeaders,
  sentryCspReportUrl,
} from './content-security-policy';

const PRODUCTION = {
  apiBaseUrl: 'https://api.integr8-media.com/',
  sentryDsn: 'https://abc123@o456.ingest.us.sentry.io/789',
  environment: 'production',
  release: '1.2.2',
  development: false,
};

function directive(policy: string, name: string): string[] {
  const found = policy
    .split('; ')
    .map((part) => part.split(' '))
    .find(([key]) => key === name);
  return found?.slice(1) ?? [];
}

describe('the content-security policy', () => {
  it('lets the browser reach this site, the API, R2 and Sentry, and nothing else', () => {
    const policy = contentSecurityPolicy(PRODUCTION);

    expect(directive(policy, 'default-src')).toEqual(["'self'"]);
    expect(directive(policy, 'connect-src')).toEqual([
      "'self'",
      'https://api.integr8-media.com',
      R2_HOSTS,
      'https://o456.ingest.us.sentry.io',
    ]);
    expect(directive(policy, 'img-src')).toEqual([
      "'self'",
      'data:',
      'blob:',
      'https://api.integr8-media.com',
      R2_HOSTS,
    ]);
    expect(directive(policy, 'object-src')).toEqual(["'none'"]);
    expect(directive(policy, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(policy, 'base-uri')).toEqual(["'self'"]);
    expect(directive(policy, 'form-action')).toEqual(["'self'"]);
  });

  it('allows eval only in development, where React needs it', () => {
    expect(directive(contentSecurityPolicy(PRODUCTION), 'script-src')).not.toContain(
      "'unsafe-eval'",
    );
    expect(
      directive(contentSecurityPolicy({ ...PRODUCTION, development: true }), 'script-src'),
    ).toContain("'unsafe-eval'");
  });

  it('sends reports to Sentry when there is a DSN, and has no report target without one', () => {
    const report = directive(contentSecurityPolicy(PRODUCTION), 'report-uri')[0];
    expect(report).toBe(
      'https://o456.ingest.us.sentry.io/api/789/security/?sentry_key=abc123&sentry_environment=production&sentry_release=1.2.2',
    );

    const without = contentSecurityPolicy({ ...PRODUCTION, sentryDsn: undefined });
    expect(without).not.toMatch(/report-uri|report-to|sentry/u);
  });

  it('ignores a DSN that is not one', () => {
    expect(sentryCspReportUrl('')).toBeUndefined();
    expect(sentryCspReportUrl('not a url')).toBeUndefined();
    expect(sentryCspReportUrl('https://o1.ingest.sentry.io/')).toBeUndefined();
  });
});

describe('the headers', () => {
  it('reports the full policy, and enforces only frame-ancestors for now', () => {
    const headers = Object.fromEntries(
      securityHeaders(PRODUCTION).map((header) => [header.key, header.value]),
    );

    expect(headers['Content-Security-Policy']).toBe("frame-ancestors 'none'");
    expect(headers['Content-Security-Policy-Report-Only']).toContain('connect-src');
    expect(headers['Reporting-Endpoints']).toMatch(/^csp="https:\/\/o456\.ingest/u);
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });
});
