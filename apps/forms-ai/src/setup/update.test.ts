import { createHash } from 'node:crypto';
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

  it('takes the newest release with this computer’s file and its checksum', () => {
    const releases = [
      release('v1.4.0', ['integr8-forms-ai-1.4.0-windows-x64.exe']), // no checksum
      release('v1.3.2', [
        'integr8-forms-ai-1.3.2-windows-x64.exe',
        'integr8-forms-ai-1.3.2-windows-x64.exe.sha256',
      ]),
      release('v1.3.1', [
        'integr8-forms-ai-1.3.1-windows-x64.exe',
        'integr8-forms-ai-1.3.1-windows-x64.exe.sha256',
      ]),
      release(
        'v1.5.0',
        ['integr8-forms-ai-1.5.0-windows-x64.exe', 'integr8-forms-ai-1.5.0-windows-x64.exe.sha256'],
        { prerelease: true },
      ),
      release('company-acme-v9.0.0', [
        'integr8-forms-ai-9.0.0-windows-x64.exe',
        'integr8-forms-ai-9.0.0-windows-x64.exe.sha256',
      ]),
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
            release('v1.3.1', [
              'integr8-forms-ai-1.3.1-windows-x64.exe',
              'integr8-forms-ai-1.3.1-windows-x64.exe.sha256',
            ]),
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

  const update = {
    version: '1.3.1',
    tag: 'v1.3.1',
    asset: asset('integr8-forms-ai-1.3.1-linux-x64'),
    checksum: asset('integr8-forms-ai-1.3.1-linux-x64.sha256'),
  };

  function serve(body: Uint8Array, hash: string): typeof fetch {
    return ((url: string) =>
      Promise.resolve(
        url.endsWith('.sha256') ? new Response(`${hash}  file\n`) : new Response(body),
      )) as typeof fetch;
  }

  it('replaces the installed program in place after checking its hash', async () => {
    const target = join(folder, 'integr8-forms-ai');
    writeFileSync(target, 'old');
    const body = new TextEncoder().encode('new program');
    await applyUpdate(update, target, {
      fetch: serve(body, createHash('sha256').update(body).digest('hex')),
    });
    expect(readFileSync(target, 'utf8')).toBe('new program');
  });

  it('changes nothing when the hash does not match', async () => {
    const target = join(folder, 'integr8-forms-ai');
    writeFileSync(target, 'old');
    await expect(
      applyUpdate(update, target, {
        fetch: serve(new TextEncoder().encode('tampered'), 'b'.repeat(64)),
      }),
    ).rejects.toThrow(/does not match/u);
    expect(readFileSync(target, 'utf8')).toBe('old');
  });
});
