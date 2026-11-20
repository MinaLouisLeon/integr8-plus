import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Host } from '../host.js';
import {
  applyUpdate,
  assetName,
  checkForUpdate,
  compareVersions,
  findUpdate,
  parseChecksum,
  type Release,
} from './update.js';
import { UPDATE_MANIFEST, UPDATE_SIGNATURE } from './signature.js';

/** A throwaway update key, standing in for Integr8's. */
const testKey = generateKeyPairSync('ed25519');
const TEST_KEYS = [
  testKey.publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64'),
];
const SIGNED = [UPDATE_MANIFEST, UPDATE_SIGNATURE];

/** A manifest and its signature, as the release job makes them. */
function signedList(version: string, files: Record<string, string>, key = testKey.privateKey) {
  const manifest = Buffer.from(JSON.stringify({ format: 1, version, files }));
  return { manifest, signature: sign(null, manifest, key).toString('base64') };
}

const asset = (name: string) => ({
  name,
  browser_download_url: `https://github.com/o/r/releases/download/x/${name}`,
});

function release(tag: string, names: string[], extra: Partial<Release> = {}): Release {
  return { tag_name: tag, draft: false, prerelease: false, assets: names.map(asset), ...extra };
}

const host: Host = { platform: 'win32', arch: 'x64', home: 'C:\\Users\\m', env: {} };

describe('finding an update', () => {
  it('names each build', () => {
    expect(assetName('1.3.0', 'win32', 'x64')).toBe('integr8-forms-ai-1.3.0-windows-x64.exe');
    expect(assetName('1.3.0', 'darwin', 'arm64')).toBe('integr8-forms-ai-1.3.0-macos-arm64');
    expect(assetName('1.3.0', 'linux', 'x64')).toBe('integr8-forms-ai-1.3.0-linux-x64');
    expect(assetName('1.3.0', 'linux', 'ia32')).toBeUndefined();
  });

  it('compares versions by number', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.3.0', '1.3.0')).toBe(0);
    expect(compareVersions('1.3.0-nightly.1', '1.3.0')).toBeLessThan(0);
  });

  it('takes the newest release with this computer’s file and a signed update list', () => {
    const releases = [
      // No signed list: never offered (SEC-004), even with a checksum.
      release('v1.4.0', [
        'integr8-forms-ai-1.4.0-windows-x64.exe',
        'integr8-forms-ai-1.4.0-windows-x64.exe.sha256',
      ]),
      release('v1.3.2', ['integr8-forms-ai-1.3.2-windows-x64.exe', ...SIGNED]),
      release('v1.3.1', ['integr8-forms-ai-1.3.1-windows-x64.exe', ...SIGNED]),
      release('v1.5.0', ['integr8-forms-ai-1.5.0-windows-x64.exe', ...SIGNED], {
        prerelease: true,
      }),
      release('company-acme-v9.0.0', ['integr8-forms-ai-9.0.0-windows-x64.exe', ...SIGNED]),
      release('v1.6.0', ['integr8-plus-staff-1.6.0-windows-x64-setup.exe']), // no tool built
    ];
    expect(findUpdate(releases, '1.3.0', 'win32', 'x64')?.version).toBe('1.3.2');
    expect(findUpdate(releases, '1.3.2', 'win32', 'x64')).toBeUndefined();
    expect(findUpdate(releases, '1.3.0', 'darwin', 'arm64')).toBeUndefined();
  });

  it('reads a checksum file', () => {
    const hash = 'a'.repeat(64);
    expect(parseChecksum(`${hash}  integr8-forms-ai-1.3.0-linux-x64\n`)).toBe(hash);
    expect(parseChecksum('nothing')).toBeUndefined();
  });

  it('asks GitHub once, quietly giving up when it cannot', async () => {
    let asked = '';
    const fake = ((url: string) => {
      asked = url;
      return Promise.resolve(
        new Response(
          JSON.stringify([
            release('v1.3.1', ['integr8-forms-ai-1.3.1-windows-x64.exe', ...SIGNED]),
          ]),
        ),
      );
    }) as typeof fetch;
    expect((await checkForUpdate(host, '1.3.0', { fetch: fake }))?.version).toBe('1.3.1');
    expect(asked).toBe(
      'https://api.github.com/repos/MinaLouisLeon/integr8-plus/releases?per_page=30',
    );
    await checkForUpdate({ ...host, env: { INTEGR8_FORMS_REPOSITORY: 'someone/fork' } }, '1.3.0', {
      fetch: fake,
    });
    expect(asked).toContain('repos/someone/fork/');

    const offline = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    expect(await checkForUpdate(host, '1.3.0', { fetch: offline })).toBeUndefined();
    const limited = (() => Promise.resolve(new Response('{}', { status: 403 }))) as typeof fetch;
    expect(await checkForUpdate(host, '1.3.0', { fetch: limited })).toBeUndefined();
    expect(
      await checkForUpdate({ ...host, env: { INTEGR8_FORMS_NO_UPDATE_CHECK: '1' } }, '1.3.0', {
        fetch: fake,
      }),
    ).toBeUndefined();
    expect(await checkForUpdate(host, '1.3.0-nightly.20261101', { fetch: fake })).toBeUndefined();
  });
});

describe('applying an update', () => {
  let folder: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'forms-ai-update-'));
  });
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  const NAME = 'integr8-forms-ai-1.3.1-linux-x64';
  const update = {
    version: '1.3.1',
    tag: 'v1.3.1',
    asset: asset(NAME),
    manifest: asset(UPDATE_MANIFEST),
    signature: asset(UPDATE_SIGNATURE),
  };
  const hashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

  function serve(body: Uint8Array, list: { manifest: Buffer; signature: string }): typeof fetch {
    return ((url: string) =>
      Promise.resolve(
        url.endsWith(UPDATE_SIGNATURE)
          ? new Response(list.signature)
          : url.endsWith(UPDATE_MANIFEST)
            ? new Response(list.manifest)
            : new Response(body),
      )) as typeof fetch;
  }

  const install = (body: Uint8Array, list: { manifest: Buffer; signature: string }) => {
    const target = join(folder, 'integr8-forms-ai');
    writeFileSync(target, 'old');
    const outcome = applyUpdate(update, target, { fetch: serve(body, list), keys: TEST_KEYS });
    return { target, outcome };
  };

  it('replaces the installed program when Integr8’s signed list names its hash', async () => {
    const body = new TextEncoder().encode('new program');
    const { target, outcome } = install(body, signedList('1.3.1', { [NAME]: hashOf(body) }));
    await outcome;
    expect(readFileSync(target, 'utf8')).toBe('new program');
  });

  it('changes nothing when the file does not match the signed list', async () => {
    const real = new TextEncoder().encode('new program');
    const { target, outcome } = install(
      new TextEncoder().encode('tampered'),
      signedList('1.3.1', { [NAME]: hashOf(real) }),
    );
    await expect(outcome).rejects.toThrow(/does not match/u);
    expect(readFileSync(target, 'utf8')).toBe('old');
  });

  it('changes nothing when the list is signed by another key, or not at all', async () => {
    const body = new TextEncoder().encode('fake program');
    const stranger = generateKeyPairSync('ed25519').privateKey;
    const forged = install(body, signedList('1.3.1', { [NAME]: hashOf(body) }, stranger));
    await expect(forged.outcome).rejects.toThrow(/not signed by Integr8/u);
    expect(readFileSync(forged.target, 'utf8')).toBe('old');

    const unsigned = install(body, {
      manifest: Buffer.from(JSON.stringify({ format: 1, version: '1.3.1', files: {} })),
      signature: '',
    });
    await expect(unsigned.outcome).rejects.toThrow(/no valid signature/u);
  });

  it('changes nothing for an older signed list replayed, or one that does not name the file', async () => {
    const body = new TextEncoder().encode('new program');
    const old = install(body, signedList('1.3.0', { [NAME]: hashOf(body) }));
    await expect(old.outcome).rejects.toThrow(/is for 1\.3\.0, not 1\.3\.1/u);
    const other = install(body, signedList('1.3.1', { 'something-else': hashOf(body) }));
    await expect(other.outcome).rejects.toThrow(/not in the signed update list/u);
    expect(readFileSync(other.target, 'utf8')).toBe('old');
  });

  it('trusts the update key built into the program by default', async () => {
    const body = new TextEncoder().encode('new program');
    const target = join(folder, 'integr8-forms-ai');
    writeFileSync(target, 'old');
    // Signed with the test key, which is not built in: refused.
    await expect(
      applyUpdate(update, target, {
        fetch: serve(body, signedList('1.3.1', { [NAME]: hashOf(body) })),
      }),
    ).rejects.toThrow(/not signed by Integr8/u);
  });
});
