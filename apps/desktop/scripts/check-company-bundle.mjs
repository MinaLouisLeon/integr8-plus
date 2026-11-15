#!/usr/bin/env node
/**
 * Proves a company's build carries none of the staff app (P42).
 *
 * The staff dashboard and the staff sign-in are loaded lazily behind the
 * build's flavour (`import.meta.env.VITE_APP_FLAVOR`), which Vite inlines, so
 * a company's build should not contain them at all. This builds the bundle
 * twice into a scratch folder — as a company and as the staff app — and looks
 * for addresses only the staff code calls: absent from the first, present in
 * the second (so the check cannot pass by looking for the wrong thing).
 *
 * Usage: `pnpm --filter @integr8/desktop check:company-bundle`. Needs the
 * workspace packages built first, as `vite build` does.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('..', import.meta.url));

/** Called only by the staff dashboard and the staff sign-in. */
const STAFF_ONLY = [
  '/v1/platform/auth/sign-in',
  '/v1/platform/companies/{tenantId}/impersonate',
  '/v1/platform/plans',
  '/v1/platform/downloads',
];

function build(flavour) {
  const out = mkdtempSync(join(tmpdir(), `integr8-desktop-${flavour}-`));
  execFileSync('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: app,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_APP_FLAVOR: flavour,
      ...(flavour === 'company' ? { VITE_COMPANY_SLUG: 'bundle-check' } : {}),
    },
  });
  return out;
}

function javascript(folder) {
  let text = '';
  for (const entry of readdirSync(folder)) {
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) {
      text += javascript(path);
    } else if (entry.endsWith('.js')) {
      text += readFileSync(path, 'utf8');
    }
  }
  return text;
}

const company = build('company');
const staff = build('staff');
try {
  const companyCode = javascript(company);
  const staffCode = javascript(staff);
  const leaked = STAFF_ONLY.filter((marker) => companyCode.includes(marker));
  const missing = STAFF_ONLY.filter((marker) => !staffCode.includes(marker));
  if (missing.length > 0) {
    console.error(
      `The staff build lacks ${missing.join(', ')}: this check looks for the wrong thing.`,
    );
    process.exit(1);
  }
  if (leaked.length > 0) {
    console.error(`A company build carries staff code: ${leaked.join(', ')}.`);
    process.exit(1);
  }
  console.log('A company build carries none of the staff app.');
} finally {
  rmSync(company, { recursive: true, force: true });
  rmSync(staff, { recursive: true, force: true });
}
