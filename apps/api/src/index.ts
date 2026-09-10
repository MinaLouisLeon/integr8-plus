import { createServer } from 'node:http';
import { describeApp, optionalEnv } from '@integr8/core';
import { buildAppInfo } from './app-info.js';

/**
 * Placeholder API process.
 *
 * P01 establishes only that this workspace member builds, lints, type-checks,
 * tests and runs. The real framework, routing, OpenAPI contract and tenant
 * middleware arrive in P04.
 */
const info = buildAppInfo();
const port = Number.parseInt(optionalEnv('PORT', '3000'), 10);

const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', app: info }));
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }));
});

server.listen(port, () => {
  console.log(`${describeApp(info)} listening on http://localhost:${String(port)}`);
});
