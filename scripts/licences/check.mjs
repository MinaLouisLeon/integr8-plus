#!/usr/bin/env node
/* global console, process */
// Dependency licence policy (ADR-0012; PLAN.md §10.3).
//
// Every installed package must carry a permissive licence. Anything else —
// copyleft, source-available, unknown or missing — fails, unless it is named
// in `exceptions.json` with the reason it was reviewed and accepted. An
// expression such as `(MIT OR GPL-2.0)` passes when one choice is allowed;
// `MIT AND Apache-2.0` needs every part allowed.
//
// It reads `pnpm licenses list --json`, so it sees what pnpm installed for
// this platform: platform-specific packages (`…-linux-x64`) are matched by the
// exceptions' `*` patterns. No dependency of its own.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Python-2.0',
  'Zlib',
  'WTFPL',
]);

const here = dirname(fileURLToPath(import.meta.url));
const exceptions = JSON.parse(readFileSync(join(here, 'exceptions.json'), 'utf8')).exceptions;

/** Whether an SPDX expression is allowed: any OR branch whose AND parts are all allowed. */
export function allowed(expression) {
  const text = expression.replace(/[()]/gu, ' ').trim();
  if (text === '') {
    return false;
  }
  return text
    .split(/\s+OR\s+/u)
    .some((branch) => branch.split(/\s+AND\s+/u).every((part) => ALLOWED.has(part.trim())));
}

const matches = (pattern, name) =>
  pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name;

function main() {
  const output = execFileSync('pnpm', ['licenses', 'list', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const byLicence = JSON.parse(output);
  const failures = [];
  const used = new Set();
  let count = 0;
  for (const [licence, packages] of Object.entries(byLicence)) {
    for (const pkg of packages) {
      count += 1;
      if (allowed(licence)) {
        continue;
      }
      const exception = exceptions.find(
        (entry) => matches(entry.package, pkg.name) && entry.license === licence,
      );
      if (exception === undefined) {
        failures.push(`${pkg.name}@${pkg.versions.join(', ')} — ${licence}`);
      } else {
        used.add(exception.package);
      }
    }
  }
  const unused = exceptions.filter((entry) => !used.has(entry.package));
  for (const entry of unused) {
    console.warn(`licences: exception for ${entry.package} (${entry.license}) is no longer needed`);
  }
  if (failures.length > 0) {
    console.error('licences: these packages are not under a permissive licence:');
    for (const failure of failures) {
      console.error(`  ${failure}`);
    }
    console.error(
      'Replace them, or add a reviewed entry to scripts/licences/exceptions.json saying why it is acceptable.',
    );
    process.exit(1);
  }
  console.log(`licences: ${count} packages checked; ${used.size} reviewed exceptions in use.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
