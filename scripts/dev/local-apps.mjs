#!/usr/bin/env node
/* global console, process, setTimeout, clearTimeout */
// Runs the apps' `dev` servers side by side for `pnpm local:apps`, and makes
// Ctrl+C stop all of them.
//
// This used to be `turbo run dev`. On Windows Ctrl+C then often left the run
// printing "N tasks shutting down" for as long as the terminal stayed open:
// each task was `pnpm run dev` → `cmd /c` → a `.cmd` shim → `tsx watch` →
// node, and any layer that did not exit (a batch file waiting on "Terminate
// batch job (Y/N)?", or a `tsx watch` whose API process had already stopped
// and which went on waiting for file changes) kept turbo waiting for ever.
// The leftover watchers outlived the terminal too.
//
// So each app's `dev` script is read from its package.json and its program is
// started directly with this Node (no pnpm, no cmd, no shim), in this console,
// so Windows hands every one of them the Ctrl+C itself. Then:
//   - first Ctrl+C: the apps shut down on their own (the API closes its pools);
//   - whatever is still running after GRACE_MS, or at a second Ctrl+C, is
//     killed with its whole process tree (taskkill /T /F on Windows, the
//     process group elsewhere).
// If one app stops by itself (a crash at start-up), the others are stopped
// too and the run fails, as turbo did.
//
// Usage: node scripts/dev/local-apps.mjs [app ...]   (default: api desktop)
// No dependency of its own.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_APPS = ['api', 'desktop'];
// tsx watch gives its child 5 s before killing it; a little more than that.
const GRACE_MS = 8000;
const IS_WINDOWS = process.platform === 'win32';
const COLOURS = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m'];
const RESET = '\x1b[0m';

/** `tsx watch --env-file-if-exists=.env src/index.ts` → the program file and its arguments. */
function devCommand(appDir) {
  const manifestPath = join(appDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const script = manifest.scripts?.dev;
  if (typeof script !== 'string') {
    throw new Error(`${manifestPath} has no "dev" script.`);
  }
  // Plain words only: a script that needs a shell (quotes, &&, pipes,
  // variables) cannot be started without one, which is what this avoids.
  if (/["'`&|;<>$%^()]/.test(script)) {
    throw new Error(
      `${manifestPath}: the "dev" script needs a shell, which this runner does not use: ${script}`,
    );
  }
  const [program, ...args] = script.trim().split(/\s+/);
  const require = createRequire(manifestPath);
  const programManifestPath = require.resolve(`${program}/package.json`);
  const programManifest = JSON.parse(readFileSync(programManifestPath, 'utf8'));
  const bin =
    typeof programManifest.bin === 'string' ? programManifest.bin : programManifest.bin?.[program];
  if (typeof bin !== 'string') {
    throw new Error(`${program} (${programManifestPath}) has no "${program}" program.`);
  }
  return { file: join(dirname(programManifestPath), bin), args, script };
}

/** Prefixes every line a child writes with its app's name, as turbo did. */
function prefixLines(stream, label, out) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      out.write(`${label}${line}\n`);
    }
  });
  stream.on('end', () => {
    if (pending !== '') {
      out.write(`${label}${pending}\n`);
    }
  });
}

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return;
  }
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

const names = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_APPS;
const width = Math.max(...names.map((name) => name.length));
const running = new Map();
let stopping = false;
let forceTimer;
let exitCode = 0;

function stop(reason) {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log(`\n${reason} Stopping ${[...running.keys()].join(', ')}...`);
  // On Windows the console has already given every app the Ctrl+C. Elsewhere
  // they are in their own process groups (so they can be killed as a tree),
  // which the terminal does not signal, so pass it on.
  if (!IS_WINDOWS) {
    for (const child of running.values()) {
      try {
        process.kill(-child.pid, 'SIGINT');
      } catch {
        // Already gone.
      }
    }
  }
  forceTimer = setTimeout(() => {
    force(`Still running after ${GRACE_MS / 1000} s:`);
  }, GRACE_MS);
  forceTimer.unref();
}

function force(reason) {
  if (running.size === 0) {
    return;
  }
  console.log(`${reason} killing ${[...running.keys()].join(', ')} and everything they started.`);
  for (const child of running.values()) {
    killTree(child);
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(signal, () => {
    if (stopping) {
      force('Ctrl+C again:');
    } else {
      stop('Ctrl+C.');
    }
  });
}

names.forEach((name, index) => {
  const appDir = join(ROOT, 'apps', name);
  const { file, args, script } = devCommand(appDir);
  const label = `${COLOURS[index % COLOURS.length]}${name.padEnd(width)} |${RESET} `;
  console.log(`${label}${script}`);
  const child = spawn(process.execPath, [file, ...args], {
    cwd: appDir,
    // No stdin: two apps reading one keyboard fight over it, and Vite only
    // offers its key shortcuts in a terminal anyway.
    stdio: ['ignore', 'pipe', 'pipe'],
    // Pipes are not terminals, so ask for colours, unless the person asked
    // for none (Node warns when both are set).
    env:
      process.env.NO_COLOR === undefined
        ? { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' }
        : process.env,
    detached: !IS_WINDOWS,
  });
  running.set(name, child);
  prefixLines(child.stdout, label, process.stdout);
  prefixLines(child.stderr, label, process.stderr);
  child.on('error', (error) => {
    console.error(`${label}could not start: ${error.message}`);
  });
  // `exit`, not `close`: `close` waits for the output pipes, which anything the
  // app left behind can hold open for ever (the very hang this replaces).
  child.on('exit', (code, signal) => {
    running.delete(name);
    if (!stopping) {
      console.log(`${label}stopped by itself (${signal ?? `exit code ${code}`}).`);
      exitCode = 1;
      stop(`${name} stopped.`);
    }
    if (running.size === 0) {
      clearTimeout(forceTimer);
      process.exit(exitCode);
    }
  });
});
