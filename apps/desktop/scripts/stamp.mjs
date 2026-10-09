#!/usr/bin/env node
/**
 * Stamps a build's identity into `src-tauri/tauri.conf.json`.
 *
 * One desktop codebase, built in two flavours (see `src/lib/env.ts`):
 *
 *   staff    the one build Integr8's own people install: product name
 *            "Integr8 Plus Staff", its own identifier, the product icon, and a
 *            sign-in screen that shows only the staff door.
 *   company  one build per company, carrying that company's name, identifier
 *            and icon, and a sign-in screen that shows only its own people's
 *            door. Which company is decided here, by the brand the pipeline
 *            fetched from `GET /v1/public/companies/{slug}/brand`.
 *
 * It also does what the release workflow always did: writes the version and
 * points the window's content-security policy at the real API. Run by CI right
 * before `tauri build`; never committed, since the file it writes is the
 * development configuration everybody shares.
 *
 *   node apps/desktop/scripts/stamp.mjs \
 *     --version 0.2.0 --api-url https://api.example.com \
 *     --flavor company --brand brand.json [--updater-base https://releases.example.com/desktop]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER_API = 'https://api.integr8.example';
const PLACEHOLDER_UPDATER = 'https://releases.integr8.example/desktop';
const BASE_IDENTIFIER = 'com.integr8.plus';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing --${name}`);
  }
  return process.argv[index + 1];
}

const version = arg('version');
const apiUrl = arg('api-url');
const flavor = arg('flavor');
const updaterBase = arg('updater-base', PLACEHOLDER_UPDATER).replace(/\/+$/u, '');

if (!/^\d+\.\d+\.\d+$/u.test(version)) {
  throw new Error(`--version must be plain X.Y.Z (MSI refuses anything else), got ${version}`);
}
if (!apiUrl.startsWith('https://')) {
  throw new Error(`--api-url must start with https://, got ${apiUrl}`);
}
if (flavor !== 'staff' && flavor !== 'company') {
  throw new Error(`--flavor must be staff or company, got ${flavor}`);
}

/** @type {{ slug: string; name: string } | undefined} */
let brand;
if (flavor === 'company') {
  brand = JSON.parse(readFileSync(arg('brand'), 'utf8'));
  if (typeof brand.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/u.test(brand.slug)) {
    throw new Error(`brand.slug is not a company short name: ${String(brand.slug)}`);
  }
  if (typeof brand.name !== 'string' || brand.name.trim() === '') {
    throw new Error('brand.name is empty');
  }
}

const path = fileURLToPath(new URL('../src-tauri/tauri.conf.json', import.meta.url));
const config = JSON.parse(readFileSync(path, 'utf8'));

config.version = version;

// The content-security policy names a placeholder host; an installer built
// without replacing it would be forbidden from calling the real API and every
// sign-in would fail inside the window before a request left it.
const origin = new URL(apiUrl).origin;
const csp = config.app.security.csp;
if (!csp.includes(PLACEHOLDER_API)) {
  throw new Error('tauri.conf.json csp no longer carries the placeholder API host');
}
config.app.security.csp = csp.replaceAll(PLACEHOLDER_API, origin);

// Identity: what the installer, the Start menu and the window are called, and
// the identifier the operating system files the app under. Each flavour and
// each company gets its own, so a company's app installs beside the staff one.
const suffix = flavor === 'staff' ? 'staff' : brand.slug;
const productName = flavor === 'staff' ? 'Integr8 Plus Staff' : brand.name.trim();
config.productName = productName;
config.identifier = `${BASE_IDENTIFIER}.${suffix}`;
for (const window of config.app.windows ?? []) {
  window.title = productName;
}

// The updater asks its own feed, so a company's installs are never offered the
// staff build or another company's.
const updater = config.plugins?.updater;
if (updater?.endpoints) {
  updater.endpoints = updater.endpoints.map((endpoint) =>
    endpoint.replace(PLACEHOLDER_UPDATER, `${updaterBase}/${suffix}`),
  );
}

writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

console.log(`stamped ${path}`);
console.log(`  flavor:      ${flavor}${brand ? ` (${brand.slug})` : ''}`);
console.log(`  productName: ${config.productName}`);
console.log(`  identifier:  ${config.identifier}`);
console.log(`  version:     ${config.version}`);
console.log(`  csp:         ${config.app.security.csp}`);
if (updater?.endpoints) console.log(`  updater:     ${updater.endpoints.join(', ')}`);
