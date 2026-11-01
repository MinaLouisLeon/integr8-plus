import type { FastifyInstance } from 'fastify';

/**
 * Cross-origin access for the browser clients.
 *
 * The web app, the desktop app in development and the Tauri webview each load
 * from an origin that is not the API's, so without these headers a browser
 * refuses every response. An allow-list, not a wildcard: a wildcard would let
 * any page a signed-in person visits read this API with a token it obtained,
 * and `Authorization` headers are exactly what CORS exists to gate.
 *
 * Registered before the client-version check, because a preflight carries no
 * custom headers and would otherwise be refused as an outdated client.
 */

const ALLOWED_HEADERS = [
  'authorization',
  'content-type',
  'idempotency-key',
  'x-client-app',
  'x-client-version',
].join(', ');

const EXPOSED_HEADERS = [
  'x-request-id',
  'x-api-release',
  'min-supported-client',
  'retry-after',
  'content-disposition',
  // Exports cut at their row limit say so (ADR-0012).
  'x-export-truncated',
].join(', ');

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE';

/**
 * How many refused origins are remembered, so each is reported once.
 *
 * The `Origin` header is whatever the caller sends, so an unbounded memory of
 * them is a slow leak anybody can feed with a loop. A thousand is far more
 * than a deployment's real mistakes; past it the oldest is forgotten, and at
 * worst reported a second time.
 */
export const REFUSED_ORIGIN_MEMORY = 1000;

/** No real origin comes near this; DNS caps a host name at 253 characters. */
export const MAX_ORIGIN_LENGTH = 255;

/**
 * `scheme://host[:port]`, which is all a browser ever sends. Written as a
 * pattern rather than with `URL`, whose `origin` is "null" for the Tauri
 * webview's own `tauri://localhost`.
 */
const ORIGIN_SHAPE = /^[a-z][a-z0-9+.-]*:\/\/(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/iu;

/**
 * Whether an `Origin` header is worth remembering and reporting. Anything else
 * did not come from a browser that could have been misconfigured against us:
 * it is refused like any unknown origin, but neither kept nor logged, so a
 * stranger cannot fill the memory or the log with text of their choosing.
 */
export function isReportableOrigin(origin: string): boolean {
  return origin.length <= MAX_ORIGIN_LENGTH && ORIGIN_SHAPE.test(origin);
}

export function registerCors(
  app: FastifyInstance,
  origins: readonly string[],
  /**
   * Called the first time each unknown origin is seen (of the last
   * {@link REFUSED_ORIGIN_MEMORY}; malformed and over-long ones never). The browser shows the
   * person a CORS error and the API log would otherwise show nothing at all,
   * which is how a mistyped API_CORS_ORIGINS costs an afternoon.
   */
  onRefused?: (origin: string) => void,
): void {
  const allowed = new Set(origins);
  const refused = new Set<string>();

  app.addHook('onRequest', (request, reply, done) => {
    const origin = request.headers.origin;
    if (origin === undefined || !allowed.has(origin)) {
      if (origin !== undefined && !refused.has(origin) && isReportableOrigin(origin)) {
        if (refused.size >= REFUSED_ORIGIN_MEMORY) {
          // A Set keeps insertion order, so the first value is the oldest.
          const oldest = refused.values().next();
          if (oldest.done !== true) {
            refused.delete(oldest.value);
          }
        }
        refused.add(origin);
        onRefused?.(origin);
      }
      // No header at all: the browser blocks the response, and a non-browser
      // caller never cared.
      if (request.method === 'OPTIONS' && origin !== undefined) {
        void reply.status(403).send();
        return;
      }
      done();
      return;
    }

    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    reply.header('access-control-expose-headers', EXPOSED_HEADERS);

    if (request.method === 'OPTIONS') {
      void reply
        .header('access-control-allow-methods', ALLOWED_METHODS)
        .header('access-control-allow-headers', ALLOWED_HEADERS)
        .header('access-control-max-age', '600')
        .status(204)
        .send();
      return;
    }
    done();
  });
}
