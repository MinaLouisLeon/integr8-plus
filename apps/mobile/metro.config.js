const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

/**
 * Metro, taught about the monorepo.
 *
 * Two things it does not work out on its own:
 *
 * - **`watchFolders`** — the workspace packages live outside this app, and
 *   without this a change to `@integr8/i18n` does not trigger a reload.
 * - **`nodeModulesPaths`** — pnpm's store means a dependency may be hoisted to
 *   the workspace root rather than sitting in this app's `node_modules`.
 *
 * `disableHierarchicalLookup` is deliberately left off: pnpm's symlinked layout
 * needs the hierarchy to resolve peer dependencies.
 */
const workspaceRoot = path.resolve(__dirname, '../..');
const projectRoot = __dirname;

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// The workspace packages publish `exports` maps — `@integr8/i18n/core`, for one
// — and Metro only honours them when this is on.
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
