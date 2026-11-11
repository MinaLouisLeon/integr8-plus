#!/usr/bin/env node
/* global console, process */
// Serves docs/deployment (the setup checklist's HTML, CSS and JS) on localhost and
// opens it in the default browser: `pnpm guide:serve`. Read-only, loopback only,
// no dependency. `--port <n>` picks a port (default 4173); `--no-open` skips the browser.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'deployment');
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 4173;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('--port needs a number between 1 and 65535.');
  process.exit(1);
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const server = createServer(async (request, response) => {
  const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
  const name = path === '/' ? 'setup-checklist.html' : normalize(path).replace(/^[/\\]+/, '');
  const file = join(root, name);
  const type = types[file.slice(file.lastIndexOf('.'))];
  // Only the guide's own files, never anything outside the folder.
  if (!file.startsWith(root + sep) || type === undefined) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

server.on('error', (error) => {
  console.error(
    error.code === 'EADDRINUSE'
      ? `Port ${port} is busy: try --port ${port + 1}.`
      : `Could not start: ${error.message}`,
  );
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Setup checklist at ${url} (Ctrl-C to stop; reload the page after editing).`);
  if (args.includes('--no-open')) return;
  const [command, ...rest] =
    process.platform === 'win32'
      ? ['cmd', '/c', 'start', '""', url]
      : process.platform === 'darwin'
        ? ['open', url]
        : ['xdg-open', url];
  spawn(command, rest, { stdio: 'ignore', detached: true })
    .on('error', () => console.log('Could not open a browser: open the address above.'))
    .unref();
});
