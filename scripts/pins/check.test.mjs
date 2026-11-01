import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  check,
  dockerNodeVersions,
  isPinned,
  nodeProblems,
  rangeProblems,
  repositoryRoot,
  satisfies,
} from './check.mjs';

test('exact versions and workspace links pass; ranges, tags and URLs fail', () => {
  for (const version of ['1.2.3', '0.0.1', '19.3.0-rc.1', '1.0.0+build.5', 'workspace:*']) {
    assert.equal(isPinned(version), true, version);
  }
  for (const version of [
    '^1.2.3',
    '~58.0.6',
    '>=19',
    '1.2',
    '1.x',
    '*',
    'latest',
    '',
    'github:a/b',
  ]) {
    assert.equal(isPinned(version), false, version);
  }
});

test('a range in dependencies, devDependencies or optionalDependencies is named; peers may range', () => {
  const problems = rangeProblems('apps/x/package.json', {
    dependencies: { a: '1.0.0', b: '^2.0.0' },
    devDependencies: { c: '~3.0.0' },
    optionalDependencies: { d: '>=4' },
    peerDependencies: { react: '>=19' },
  });
  assert.equal(problems.length, 3);
  assert.match(problems[0], /dependencies "b" is "\^2\.0\.0"/u);
  assert.match(problems[1], /devDependencies "c"/u);
  assert.match(problems[2], /optionalDependencies "d"/u);
});

test('Dockerfile FROM lines give their Node release', () => {
  const dockerfile = [
    '# syntax=docker/dockerfile:1.7',
    'FROM node:22.22.2-bookworm-slim AS base',
    'FROM base AS build',
    'from --platform=linux/arm64 node:22.22.1 AS runtime',
  ].join('\n');
  assert.deepEqual(dockerNodeVersions(dockerfile), ['22.22.2', '22.22.1']);
});

test('engines ranges', () => {
  assert.equal(satisfies('22.22.2', '>=22.22.1 <23'), true);
  assert.equal(satisfies('22.22.1', '>=22.22.1 <23'), true);
  assert.equal(satisfies('22.22.0', '>=22.22.1 <23'), false);
  assert.equal(satisfies('23.0.0', '>=22.22.1 <23'), false);
  assert.equal(satisfies('22.22.2', '^22.22.1'), false, 'unsupported forms fail loudly');
  assert.equal(satisfies('22.22.2', ''), false);
});

test('.nvmrc, the Dockerfiles and engines must agree', () => {
  const good = 'FROM node:22.22.2-bookworm-slim AS base\nFROM node:22.22.2-bookworm-slim\n';
  assert.deepEqual(
    nodeProblems({ nvmrc: '22.22.2\n', engines: '>=22.22.1 <23', dockerfiles: { D: good } }),
    [],
  );

  const floating = nodeProblems({
    nvmrc: '22.22.2',
    engines: '>=22.22.1 <23',
    dockerfiles: { D: 'FROM node:22-bookworm-slim' },
  });
  assert.equal(floating.length, 1);
  assert.match(floating[0], /node:22… differs from \.nvmrc 22\.22\.2/u);

  assert.equal(
    nodeProblems({ nvmrc: '22.22.0', engines: '>=22.22.1 <23', dockerfiles: { D: good } }).length,
    3,
    'an .nvmrc below engines, and Dockerfiles that no longer match it',
  );
  assert.equal(
    nodeProblems({ nvmrc: '22', engines: '>=22.22.1 <23', dockerfiles: { D: good } }).length,
    4,
  );
  assert.equal(
    nodeProblems({ nvmrc: '22.22.2', engines: undefined, dockerfiles: { D: good } }).length,
    1,
  );
  assert.equal(
    nodeProblems({ nvmrc: '22.22.2', engines: '>=22.22.1 <23', dockerfiles: {} }).length,
    1,
  );
  assert.equal(
    nodeProblems({ nvmrc: '22.22.2', engines: '>=22.22.1 <23', dockerfiles: { D: 'FROM x' } })
      .length,
    1,
  );
});

test('this repository passes', () => {
  assert.deepEqual(check(repositoryRoot), []);
});
