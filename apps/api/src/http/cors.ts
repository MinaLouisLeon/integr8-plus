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
].join(', ');

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE';

export function registerCors(
  app: FastifyInstance,
  origins: readonly string[],
  /**
   * Called the first time each unknown origin is seen. The browser shows the
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
      if (origin !== undefined && !refused.has(origin)) {
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
