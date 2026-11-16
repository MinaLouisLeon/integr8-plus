#!/usr/bin/env node
/* global Buffer, console, process */
// Builds the developer MCP server's single executable (P43) for the computer
// it runs on, the way Forms for AI's is built: the bundle, plus Forms for AI's
// assets (pdf.js, the website fonts, the preview page) and the API's OpenAPI
// document, injected into a copy of this Node binary. The keychain module
// (@napi-rs/keyring's file for this computer) cannot live inside it, so it
// ships beside it.
//
//   node scripts/build-sea.mjs [--out <folder>]
//
// Writes to <out> (default dist/release), each with a .sha256 beside it:
//   integr8-dev-mcp-<version>-<os>-<arch>.zip            the program and the keychain module
//   integr8-dev-mcp-<version>-<os>-<arch>[.exe]          the program alone (updates)
//   integr8-dev-mcp-keyring-<version>-<os>-<arch>.node   the keychain module alone (updates)
// then runs the program to prove it starts, carries every asset and loads the
// keychain module from beside itself. On macOS it is signed ad hoc after
// injection, without which Apple Silicon refuses to run it.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { bundle } from './bundle.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const formsAi = join(app, '..', 'forms-ai');
const api = join(app, '..', 'api');
const require = createRequire(join(app, 'package.json'));
const formsRequire = createRequire(join(formsAi, 'package.json'));
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const KEYRING_FILE = 'integr8-keyring.node';

const outFlag = process.argv.indexOf('--out');
const out = outFlag === -1 ? join(app, 'dist', 'release') : process.argv[outFlag + 1];

const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
if (os === undefined || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error(`No build for ${process.platform} ${process.arch}.`);
}
if (!existsSync(join(formsAi, 'dist', 'window', 'page.js'))) {
  throw new Error('Build Forms for AI first: pnpm --filter @integr8/forms-ai build');
}

const { version, file: main } = await bundle();
const stem = `${os}-${process.arch}`;
const exe = process.platform === 'win32' ? '.exe' : '';
const work = join(app, 'dist', 'sea');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });

/** Where an asset's file is: in an app of this repository, or in Forms for AI's packages. */
function assetPath({ packageName, file }) {
  if (packageName === '@integr8/forms-ai') return join(formsAi, file);
  if (packageName === '@integr8/api') return join(api, file);
  try {
    return formsRequire.resolve(`${packageName}/${file}`);
  } catch {
    return join(dirname(formsRequire.resolve(`${packageName}/package.json`)), file);
  }
}

/** @napi-rs/keyring's native file for this computer. */
function keyringFile() {
  const triple = {
    'linux-x64': 'linux-x64-gnu',
    'linux-arm64': 'linux-arm64-gnu',
    'darwin-x64': 'darwin-x64',
    'darwin-arm64': 'darwin-arm64',
    'win32-x64': 'win32-x64-msvc',
    'win32-arm64': 'win32-arm64-msvc',
  }[`${process.platform}-${process.arch}`];
  const keyringRequire = createRequire(require.resolve('@napi-rs/keyring/package.json'));
  const folder = dirname(keyringRequire.resolve(`@napi-rs/keyring-${triple}/package.json`));
  const found = readdirSync(folder).find((name) => name.endsWith('.node'));
  if (found === undefined) throw new Error(`No keychain module in ${folder}.`);
  return join(folder, found);
}

// The bundle names its own assets, so the list is never kept twice.
const assets = JSON.parse(
  execFileSync(process.execPath, [main, '--sea-assets'], { encoding: 'utf8' }),
);
const config = {
  main,
  output: join(work, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: Object.fromEntries(assets.map((asset) => [asset.key, assetPath(asset)])),
};
writeFileSync(join(work, 'sea-config.json'), JSON.stringify(config, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', join(work, 'sea-config.json')], {
  stdio: 'inherit',
});

// The program is built in a folder of its own with the keychain module beside
// it: that folder is what the zip holds, and where it is tried out below.
const staged = join(work, 'program');
mkdirSync(staged, { recursive: true });
const program = join(staged, `integr8-dev-mcp${exe}`);
copyFileSync(process.execPath, program);
chmodSync(program, 0o755);
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--remove-signature', program], { stdio: 'inherit' });
}
const { inject } = formsRequire('postject');
await inject(program, 'NODE_SEA_BLOB', readFileSync(config.output), {
  sentinelFuse: SENTINEL,
  ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
});
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--sign', '-', program], { stdio: 'inherit' });
}
const keyring = join(staged, KEYRING_FILE);
copyFileSync(keyringFile(), keyring);

const reported = execFileSync(program, ['--version'], { encoding: 'utf8' }).trim();
if (reported !== version) {
  throw new Error(`The executable says it is ${reported}, not ${version}.`);
}
console.log(execFileSync(program, ['--check-assets'], { encoding: 'utf8' }).trim());
// Lists a session store that is empty, which loads nothing native; the
// keychain module is proved by loading it as the program does.
execFileSync(program, ['--check-keyring'], { stdio: 'inherit' });

/** A plain zip (deflate), with the program marked executable for macOS and Linux. */
function zip(target, files) {
  // MS-DOS time and date, which zip entries carry: now, in local time.
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(basename(file));
    const data = readFileSync(file);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const mode = (statSync(file).mode & 0o111) !== 0 ? 0o100755 : 0o100644;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(target, Buffer.concat([...locals, directory, end]));
}

function publish(source, name) {
  const target = join(out, name);
  rmSync(target, { force: true });
  if (source !== target) copyFileSync(source, target);
  const hash = createHash('sha256').update(readFileSync(target)).digest('hex');
  writeFileSync(`${target}.sha256`, `${hash}  ${name}\n`);
  console.log(`Built ${target} (${String(statSync(target).size)} bytes, sha256 ${hash})`);
}

const zipName = `integr8-dev-mcp-${version}-${stem}.zip`;
zip(join(work, zipName), [program, keyring]);
publish(join(work, zipName), zipName);
publish(program, `integr8-dev-mcp-${version}-${stem}${exe}`);
publish(keyring, `integr8-dev-mcp-keyring-${version}-${stem}.node`);
