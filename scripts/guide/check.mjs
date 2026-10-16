#!/usr/bin/env node
/* global console, process */
// The setup guide is one document in several copies (AGENTS.md, "The setup
// guide"): docs/deployment/setup-checklist.md, the same guide as
// setup-checklist.html with its .css and .js, and the hosted page. This checks
// the three files in the repository agree: the same stages and parts in the same
// order, the same tick boxes with the same words, and the page really loads its
// stylesheet and script. The hosted page is compared by whoever republishes it.
//
// Words are compared with everything but letters and digits removed, so the
// Markdown's `code` and **bold** against the page's tags do not count as
// differences, nor does where a link points; a changed sentence does. No
// dependency of its own.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'deployment');
const read = (name) => readFileSync(join(dir, name), 'utf8');

const entities = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};
const decode = (s) => s.replace(/&(?:lt|gt|amp|quot|nbsp|#39);/g, (m) => entities[m]);
const strip = (s) => decode(s.replace(/<[^>]*>/g, ''));
const unlink = (s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
const norm = (s) =>
  unlink(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

// ------------------------------------------------------------------ the page
const html = read('setup-checklist.html');
const stages = [...html.matchAll(/<span class="num">(\d+)<\/span><h2>(.*?)<\/h2>/g)].map(
  (m) => `Stage ${Number(m[1])} — ${strip(m[2])}`,
);
const htmlParts = [...html.matchAll(/<h([34])[^>]*>(.*?)<\/h\1>/g)].map((m) => strip(m[2]));
const htmlBoxes = [...html.matchAll(/<label for="[^"]+">(.*?)<\/label>/gs)].map((m) => strip(m[1]));

// -------------------------------------------------------------- the Markdown
const md = read('setup-checklist.md');
let fenced = false;
const mdStages = [];
const mdParts = [];
const mdBoxes = [];
for (const line of md.split('\n')) {
  if (line.startsWith('```')) fenced = !fenced;
  if (fenced) continue;
  if (line.startsWith('## Stage ')) mdStages.push(line.slice(3).trim());
  else if (/^#{3,4} /.test(line)) mdParts.push(line.replace(/^#+ /, '').trim());
  else if (line.startsWith('- [ ] ')) mdBoxes.push(line.slice(6));
}

const problems = [];

function same(what, a, b, label) {
  const limit = Math.max(a.length, b.length);
  for (let i = 0; i < limit; i += 1) {
    if (a[i] === undefined || b[i] === undefined || label(a[i]) !== label(b[i])) {
      problems.push(
        `${what} #${i + 1} differs:\n    html: ${String(a[i] ?? '(none)').slice(0, 110)}\n    md:   ${String(b[i] ?? '(none)').slice(0, 110)}`,
      );
      return;
    }
  }
}

same('stage heading', stages, mdStages, norm);
same('part heading', htmlParts, mdParts, norm);
same('tick box', htmlBoxes, mdBoxes, norm);
if (htmlBoxes.length !== mdBoxes.length) {
  problems.push(`tick boxes: html has ${htmlBoxes.length}, md has ${mdBoxes.length}`);
}

for (const [what, pattern] of [
  ['stylesheet', /href="setup-checklist\.css"/],
  ['script', /src="setup-checklist\.js"/],
]) {
  if (!pattern.test(html)) problems.push(`the page does not load setup-checklist ${what}`);
}
for (const file of ['setup-checklist.css', 'setup-checklist.js']) {
  if (!existsSync(join(dir, file))) problems.push(`${file} is missing`);
}

if (problems.length > 0) {
  console.error('The setup guide copies are not in step:\n  ' + problems.join('\n  '));
  console.error('\nChange all of them together (AGENTS.md, "The setup guide").');
  process.exit(1);
}
console.log(
  `Setup guide: ${stages.length} stages, ${htmlParts.length} parts, ${htmlBoxes.length} tick boxes, in step.`,
);
