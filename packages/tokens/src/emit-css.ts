import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildThemeCss } from './index.js';

/**
 * Writes `theme.css`, which the two DOM apps import.
 *
 * Generated at build time and committed, so a token added to `index.ts` cannot
 * be forgotten in the stylesheet, and so the apps build without running a
 * codegen step first.
 */
const target = fileURLToPath(new URL('../theme.css', import.meta.url));
writeFileSync(target, buildThemeCss(), 'utf8');
console.log(`Wrote ${target}`);
