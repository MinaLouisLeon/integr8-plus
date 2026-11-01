#!/usr/bin/env node
/* global console, process */
// Exact versions, everywhere (CONTRIBUTING.md, "Dependencies").
//
// 1. Every workspace package.json names exact versions in `dependencies`,
//    `devDependencies` and `optionalDependencies`: `1.2.3`, never `^1.2.3`,
//    `~1.2.3`, `>=1`, `latest` or a URL. Workspace packages (`workspace:*`)
//    are the one exception. A range lets a fresh install pick a release nobody
//    tested, and the lockfile only protects installs that use it.
//    `peerDependencies` may hold ranges: a peer range states what a package
//    works with, it installs nothing (the app that installs React pins it).
// 2. Node is one release: `.nvmrc` names it (CI reads it through
//    `node-version-file`), every `FROM node:` in the Dockerfiles is that same
//    release, and it satisfies the root package.json `engines.node`, which
//    `engine-strict` in .npmrc makes pnpm enforce on developers' machines.
//
// It prints every problem and exits 1 when there is one. No dependency of its own.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PINNED_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** Whether a dependency's version is one we accept in a pinned section. */
export function isPinned(version) {
  return EXACT.test(version) || version.startsWith('workspace:');
}

/** Problems with one package.json's dependency versions. */
export function rangeProblems(file, manifest) {
  const problems = [];
  for (const section of PINNED_SECTIONS) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (!isPinned(version)) {
        problems.push(`${file}: ${section} "${name}" is "${version}"; use an exact version`);
      }
    }
  }
  return problems;
}

/** The Node versions a Dockerfile builds `FROM` (the tag before any variant). */
export function dockerNodeVersions(dockerfile) {
  return [...dockerfile.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?node:([^\s@]+)/gimu)].map(
    (match) => match[1].split('-')[0],
  );
}

const parse = (version) => {
  const parts = version.replace(/^v/u, '').split('.');
  return [0, 1, 2].map((i) => Number.parseInt(parts[i] ?? '0', 10));
};

const compare = (a, b) => {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
};

/**
 * Whether `version` satisfies an `engines` range made of space-separated
 * comparators (`>=22.22.1 <23`), which is all this repository uses. A form it
 * does not understand (`^`, `||`, `x`) counts as not satisfied, so the check
 * fails loudly rather than passing by accident.
 */
export function satisfies(version, range) {
  const comparators = range.trim().split(/\s+/u);
  if (comparators.length === 0 || comparators[0] === '') {
    return false;
  }
  const have = parse(version);
  return comparators.every((comparator) => {
    const match = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/u.exec(comparator);
    if (!match) {
      return false;
    }
    const order = compare(have, parse(match[2]));
    switch (match[1] ?? '=') {
      case '>=':
        return order >= 0;
      case '<=':
        return order <= 0;
      case '>':
        return order > 0;
      case '<':
        return order < 0;
      default:
        return order === 0;
    }
  });
}

/** Problems with the Node version: .nvmrc, the Dockerfiles and `engines` must agree. */
export function nodeProblems({ nvmrc, engines, dockerfiles }) {
  const problems = [];
  const node = nvmrc.trim().replace(/^v/u, '');
  if (!EXACT.test(node)) {
    problems.push(`.nvmrc is "${nvmrc.trim()}"; name one exact Node release (22.23.4)`);
  }
  if (engines === undefined) {
    problems.push('package.json: engines.node is missing');
  } else if (!satisfies(node, engines)) {
    problems.push(`.nvmrc ${node} does not satisfy package.json engines.node "${engines}"`);
  }
  if (Object.keys(dockerfiles).length === 0) {
    problems.push('no Dockerfile found to compare with .nvmrc');
  }
  for (const [file, text] of Object.entries(dockerfiles)) {
    const versions = dockerNodeVersions(text);
    if (versions.length === 0) {
      problems.push(`${file}: no FROM node:<version> line`);
    }
    for (const version of versions) {
      if (version !== node) {
        problems.push(`${file}: FROM node:${version}… differs from .nvmrc ${node}`);
      }
    }
  }
  return problems;
}

/** Every workspace package.json, the root's included. */
function manifests(root) {
  const files = ['package.json'];
  for (const group of ['apps', 'packages']) {
    for (const name of readdirSync(join(root, group)).sort()) {
      const file = join(group, name, 'package.json');
      if (existsSync(join(root, file))) {
        files.push(file);
      }
    }
  }
  return files;
}

/** Every Dockerfile in a workspace package or under deploy/ (the images the deployment runs). */
function dockerfiles(root) {
  const files = [];
  const look = (dir) => {
    if (!existsSync(join(root, dir))) {
      return;
    }
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.isFile() && /^Dockerfile(?:\..+)?$|\.Dockerfile$/u.test(entry.name)) {
        files.push(join(dir, entry.name));
      }
    }
  };
  look('deploy');
  for (const group of ['apps', 'packages']) {
    for (const name of readdirSync(join(root, group)).sort()) {
      look(join(group, name));
    }
  }
  return files;
}

/** Every problem in the repository at `root`. */
export function check(root) {
  const read = (file) => readFileSync(join(root, file), 'utf8');
  const problems = [];
  for (const file of manifests(root)) {
    problems.push(...rangeProblems(file, JSON.parse(read(file))));
  }
  problems.push(
    ...nodeProblems({
      nvmrc: read('.nvmrc'),
      engines: JSON.parse(read('package.json')).engines?.node,
      dockerfiles: Object.fromEntries(dockerfiles(root).map((file) => [file, read(file)])),
    }),
  );
  return problems;
}

export const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === '') {
  const problems = check(repositoryRoot);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`✗ ${problem}`);
    }
    process.exit(1);
  }
  console.log('Exact dependency versions; .nvmrc, the Dockerfiles and engines agree on Node.');
}
