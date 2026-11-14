/**
 * Forms for AI's tools for another MCP server to carry: the developer MCP
 * server (`apps/dev-mcp`) registers all of them beside its own, so a
 * developer in this repository needs one server. Imported from source; the
 * preview window's page still comes from this app's build
 * (`pnpm --filter @integr8/forms-ai build`).
 */
export {
  FORMS_INSTRUCTIONS,
  type FormsToolOptions,
  type FormsTools,
  registerFormsTools,
} from './mcp/server.js';
export type { Host } from './host.js';
export type { RequestToolNames } from './requests/tools.js';
/** Every tool name Forms for AI's own server lists (its self-test checks the same list). */
export { EXPECTED_TOOLS as FORMS_TOOLS } from './setup/self-test.js';
export { VERSION as FORMS_VERSION } from './version.js';
