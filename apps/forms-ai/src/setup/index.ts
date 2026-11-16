/**
 * The installer, for the developer MCP server's own program (P43): the same
 * screens, AI-tool adapters, self-install, self-test and update helpers as
 * Forms for AI, driven by a `SetupProfile`. The one app-to-app import besides
 * `@integr8/forms-ai/tools` (apps/dev-mcp is never shipped to companies).
 */
export { currentHost, type Host, joinFor, localAppData } from '../host.js';
export { installedVersion, installSelf } from './install-self.js';
export type { Prompter } from './prompt.js';
export { EXPECTED_TOOLS, selfTest } from './self-test.js';
export {
  runSetup,
  type SetupIo,
  type SetupOptions,
  type SetupProfile,
  type UpdateOffer,
} from './setup.js';
export { TOOLS, type ToolAdapter, type ToolContext } from './tools.js';
export {
  cleanUpAfterUpdate,
  compareVersions,
  osName,
  parseChecksum,
  replaceProgram,
} from './update.js';
