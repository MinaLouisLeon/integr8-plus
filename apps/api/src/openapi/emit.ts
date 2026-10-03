import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadApiConfig } from '../config.js';
import { buildOpenApiDocument } from '../http/openapi.js';
import { documentedRoutes } from '../routes/index.js';

/**
 * Writes `apps/api/openapi.json`.
 *
 * A build artefact, committed. Committing it means a spec change shows up as a
 * diff in review — which is the moment to notice that a field was removed and
 * that removing it is a `/v2` — and it means the three client apps can be built
 * without standing the API up first.
 *
 *   pnpm --filter @integr8/api openapi
 *   pnpm --filter @integr8/api-client generate
 */
function main(): void {
  const config = loadApiConfig();

  const document = buildOpenApiDocument(documentedRoutes(config), {
    title: 'Integr8 Plus API',
    version: '1.0.0',
    description: 'Multi-tenant field operations platform.',
    servers: [
      { url: 'https://api.integr8.example', description: 'Production' },
      { url: 'http://localhost:3000', description: 'Local development' },
    ],
    minSupportedClient: config.API_MIN_SUPPORTED_CLIENT,
  });

  const target = fileURLToPath(new URL('../../openapi.json', import.meta.url));
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  console.log(`Wrote ${target}`);
}

main();
