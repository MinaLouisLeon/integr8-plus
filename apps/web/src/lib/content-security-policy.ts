/**
 * The web app's response headers: browser defences that cost nothing, and a
 * content-security policy listing what the pages actually load.
 *
 * Read by next.config.ts at build time, which is when the API address and the
 * Sentry DSN are known (both are baked into the browser bundle anyway).
 */

/** Where every company's files live: presigned R2 links, for showing and for uploading. */
export const R2_HOSTS = 'https://*.r2.cloudflarestorage.com';

export interface HeaderInputs {
  /** NEXT_PUBLIC_API_BASE_URL: the API the browser calls, and the logos it serves. */
  apiBaseUrl: string;
  /** NEXT_PUBLIC_SENTRY_DSN, when error reporting is on. */
  sentryDsn?: string | undefined;
  environment?: string | undefined;
  release?: string | undefined;
  /** `next dev`: React needs eval there to rebuild server stacks in the browser. */
  development: boolean;
}

export interface Header {
  key: string;
  value: string;
}

/** The origin of a URL, or undefined for anything that does not parse. */
function originOf(url: string | undefined): string | undefined {
  if (url === undefined || url.trim() === '' || !URL.canParse(url)) {
    return undefined;
  }
  return new URL(url).origin;
}

/**
 * Sentry's endpoint for CSP violation reports, from the DSN
 * (`https://KEY@HOST/PROJECT` → `https://HOST/api/PROJECT/security/?sentry_key=KEY`).
 */
export function sentryCspReportUrl(
  dsn: string | undefined,
  environment?: string,
  release?: string,
): string | undefined {
  if (dsn === undefined || dsn.trim() === '' || !URL.canParse(dsn)) {
    return undefined;
  }
  const parsed = new URL(dsn);
  const project = parsed.pathname.replace(/^\/+|\/+$/gu, '');
  if (parsed.username === '' || project === '') {
    return undefined;
  }
  const report = new URL(`${parsed.origin}/api/${project}/security/`);
  report.searchParams.set('sentry_key', parsed.username);
  if (environment !== undefined && environment !== '') {
    report.searchParams.set('sentry_environment', environment);
  }
  if (release !== undefined && release !== '') {
    report.searchParams.set('sentry_release', release);
  }
  return report.toString();
}

/**
 * The policy, as one header value.
 *
 * Scripts and styles allow 'unsafe-inline' because the App Router streams
 * each page's data in inline scripts and the screens set inline styles; a
 * nonce would make every page dynamically rendered. What the policy does
 * restrict is where anything may come from or go to: this site, the API, R2
 * and Sentry, and no plugin, base or form target elsewhere.
 */
export function contentSecurityPolicy(inputs: HeaderInputs): string {
  const api = originOf(inputs.apiBaseUrl);
  const sentry = originOf(inputs.sentryDsn);
  const report = sentryCspReportUrl(inputs.sentryDsn, inputs.environment, inputs.release);
  const files = ["'self'", 'data:', 'blob:', api, R2_HOSTS];

  const directives: [string, (string | undefined)[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", "'unsafe-inline'", inputs.development ? "'unsafe-eval'" : undefined]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', files],
    ['font-src', ["'self'", 'data:']],
    [
      'connect-src',
      // The dev server's hot reload talks over a websocket to itself.
      ["'self'", api, R2_HOSTS, sentry, inputs.development ? 'ws:' : undefined],
    ],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['report-uri', [report]],
    ['report-to', [report === undefined ? undefined : 'csp']],
  ];

  return directives
    .map(([name, sources]) => [name, [...new Set(sources.filter((s) => s !== undefined))]] as const)
    .filter(([, sources]) => sources.length > 0)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

/**
 * Every header the web app sends.
 *
 * The full policy goes out as `Content-Security-Policy-Report-Only` first:
 * the browser reports what it would have blocked, to Sentry when a DSN is set,
 * and blocks nothing. Once the reports are quiet it becomes the enforced
 * header (docs/deployment/README.md, "Security headers"). `frame-ancestors`
 * is enforced from the start: nothing here is meant to be shown inside another
 * site's frame — least of all the super admin dashboard, where suspending a
 * company is one click.
 */
export function securityHeaders(inputs: HeaderInputs): Header[] {
  const report = sentryCspReportUrl(inputs.sentryDsn, inputs.environment, inputs.release);
  return [
    { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
    { key: 'Content-Security-Policy-Report-Only', value: contentSecurityPolicy(inputs) },
    ...(report === undefined ? [] : [{ key: 'Reporting-Endpoints', value: `csp="${report}"` }]),
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  ];
}
