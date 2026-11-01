import { describe, expect, it } from 'vitest';
import { assetName, buildManifest, installerKind, planCollection } from './updater-feed.mjs';

/**
 * The release side of the desktop updater (P20): installers renamed so GitHub
 * keeps their names, and a manifest whose platform keys are the ones Tauri's
 * updater asks for.
 */

describe('asset names', () => {
  it('replaces the product name, which may hold spaces or Arabic, with a plain prefix', () => {
    expect(
      assetName({
        fileName: 'Integr8 Plus Staff_1.2.3_x64-setup.exe',
        productName: 'Integr8 Plus Staff',
        prefix: 'integr8-plus-staff',
        version: '1.2.3',
        arch: 'x86_64',
      }),
    ).toBe('integr8-plus-staff_1.2.3_x64-setup.exe');
    expect(
      assetName({
        fileName: 'شركة النيل_1.2.3_amd64.AppImage',
        productName: 'شركة النيل',
        prefix: 'integr8-plus-nile',
        version: '1.2.3',
        arch: 'x86_64',
      }),
    ).toBe('integr8-plus-nile_1.2.3_amd64.AppImage');
  });

  it('gives the macOS update archive a version and an architecture', () => {
    expect(
      assetName({
        fileName: 'Acme Services.app.tar.gz.sig',
        productName: 'Acme Services',
        prefix: 'integr8-plus-acme',
        version: '1.2.3',
        arch: 'aarch64',
      }),
    ).toBe('integr8-plus-acme_1.2.3_aarch64.app.tar.gz.sig');
  });

  it('recognises every installer the updater can apply', () => {
    expect(installerKind('a.app.tar.gz')).toBe('app');
    expect(installerKind('a_x64-setup.exe')).toBe('nsis');
    expect(installerKind('a_x64_en-US.msi')).toBe('msi');
    expect(installerKind('a.AppImage')).toBe('appimage');
    expect(installerKind('a.deb')).toBe('deb');
    expect(installerKind('a.dmg')).toBeUndefined();
    expect(installerKind('a.exe.sig')).toBeUndefined();
  });
});

describe('one machine’s part of the manifest', () => {
  const signatures = {
    'out/A_1.2.3_x64-setup.exe.sig': 'sig-nsis\n',
    'out/A_1.2.3_x64_en-US.msi.sig': 'sig-msi',
  };
  const plan = (files) =>
    planCollection({
      files,
      productName: 'A',
      prefix: 'integr8-plus-staff',
      version: '1.2.3',
      os: 'windows',
      arch: 'x86_64',
      readSignature: (file) => signatures[file],
    });

  it('lists each signed installer and falls back to NSIS on Windows', () => {
    const { copies, fragment } = plan([
      'out/A_1.2.3_x64_en-US.msi',
      'out/A_1.2.3_x64_en-US.msi.sig',
      'out/A_1.2.3_x64-setup.exe',
      'out/A_1.2.3_x64-setup.exe.sig',
    ]);
    expect(copies.map((copy) => copy.to)).toContain('integr8-plus-staff_1.2.3_x64-setup.exe.sig');
    expect(fragment?.name).toBe('updater-windows-x86_64.json');
    expect(fragment?.content.platforms).toEqual({
      'windows-x86_64-msi': {
        asset: 'integr8-plus-staff_1.2.3_x64_en-US.msi',
        signature: 'sig-msi',
      },
      'windows-x86_64-nsis': {
        asset: 'integr8-plus-staff_1.2.3_x64-setup.exe',
        signature: 'sig-nsis',
      },
      'windows-x86_64': { asset: 'integr8-plus-staff_1.2.3_x64-setup.exe', signature: 'sig-nsis' },
    });
  });

  it('offers nothing from a build without the updater key', () => {
    expect(plan(['out/A_1.2.3_x64-setup.exe']).fragment).toBeUndefined();
  });
});

describe('the manifest', () => {
  it('merges every platform and points each at the release’s download folder', () => {
    const manifest = buildManifest({
      fragments: [
        {
          platforms: {
            'darwin-aarch64-app': { asset: 'x_1.2.3_aarch64.app.tar.gz', signature: 's1' },
          },
        },
        { platforms: { 'linux-x86_64': { asset: 'x_1.2.3_amd64.AppImage', signature: 's2' } } },
      ],
      version: '1.2.3',
      notes: 'Version 1.2.3',
      pubDate: '2026-10-31T00:00:00.000Z',
      downloadBase: 'https://github.com/o/r/releases/download/v1.2.3/',
    });
    expect(manifest).toEqual({
      version: '1.2.3',
      notes: 'Version 1.2.3',
      pub_date: '2026-10-31T00:00:00.000Z',
      platforms: {
        'darwin-aarch64-app': {
          url: 'https://github.com/o/r/releases/download/v1.2.3/x_1.2.3_aarch64.app.tar.gz',
          signature: 's1',
        },
        'linux-x86_64': {
          url: 'https://github.com/o/r/releases/download/v1.2.3/x_1.2.3_amd64.AppImage',
          signature: 's2',
        },
      },
    });
  });
});
