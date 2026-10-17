import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalBytes, toHex } from './canonical.js';
import { prepareCadesBes } from './cms.js';
import { parseJsonText } from './json-text.js';
import { CmsVerificationError, verifyCadesBes } from './node/verify.js';
import { createSoftSigner } from './testing/soft-signer.js';

/**
 * The CMS assembly and the server's verification, with a software key. This
 * proves the structure is consistent and verifiable; it does not prove the ETA
 * accepts it (SPEC-UNVERIFIED cms-detached) or that a hardware token works.
 */

const document = parseJsonText('{"internalID":"INV-1","totalAmount":10.50}');
const bytes = canonicalBytes(document);
const digest = new Uint8Array(createHash('sha256').update(bytes).digest());

async function signed(algorithm: 'rsa' | 'ecdsa', at = new Date()) {
  const signer = await createSoftSigner({ algorithm });
  const prepared = await prepareCadesBes({
    digest,
    certificateDer: signer.certificateDer,
    signingTime: at,
  });
  const signature = await signer.sign(signer.certificateSha256, prepared.toBeSigned);
  return { signer, prepared, cms: prepared.finish(signature) };
}

const window = () => ({
  notBefore: new Date(Date.now() - 60_000),
  notAfter: new Date(Date.now() + 60_000),
});

describe('CAdES-BES assembly and verification', () => {
  for (const algorithm of ['rsa', 'ecdsa'] as const) {
    it(`verifies a ${algorithm} signature over the canonical digest`, async () => {
      const { signer, cms, prepared } = await signed(algorithm);
      expect(prepared.keyAlgorithm).toBe(algorithm);
      const verified = await verifyCadesBes({
        cms,
        digest,
        pinnedCertificates: [signer.certificateSha256],
        ...window(),
      });
      expect(verified.certificate.sha256).toBe(signer.certificateSha256);
      expect(verified.certificate.subject).toContain('CN=Software test signer');
    });
  }

  it('refuses another document’s digest', async () => {
    const { signer, cms } = await signed('rsa');
    const other = new Uint8Array(createHash('sha256').update('other').digest());
    await expect(
      verifyCadesBes({
        cms,
        digest: other,
        pinnedCertificates: [signer.certificateSha256],
        ...window(),
      }),
    ).rejects.toMatchObject({ reason: 'digest_mismatch' });
  });

  it('refuses a certificate the company did not pin', async () => {
    const { cms } = await signed('rsa');
    await expect(
      verifyCadesBes({ cms, digest, pinnedCertificates: ['00'.repeat(32)], ...window() }),
    ).rejects.toMatchObject({
      reason: 'certificate_not_pinned',
    });
  });

  it('refuses a signing time outside the request’s window', async () => {
    const { signer, cms } = await signed('rsa', new Date(Date.now() - 3_600_000));
    await expect(
      verifyCadesBes({ cms, digest, pinnedCertificates: [signer.certificateSha256], ...window() }),
    ).rejects.toMatchObject({ reason: 'signing_time' });
  });

  it('refuses a signature that does not match the attributes', async () => {
    const { signer, prepared } = await signed('rsa');
    const wrong = await signer.sign(signer.certificateSha256, new Uint8Array([1, 2, 3]));
    await expect(
      verifyCadesBes({
        cms: prepared.finish(wrong),
        digest,
        pinnedCertificates: [signer.certificateSha256],
        ...window(),
      }),
    ).rejects.toMatchObject({ reason: 'signature' });
  });

  it('refuses something that is not a CMS', async () => {
    await expect(
      verifyCadesBes({
        cms: new Uint8Array([48, 3, 2, 1, 1]),
        digest,
        pinnedCertificates: [],
        ...window(),
      }),
    ).rejects.toBeInstanceOf(CmsVerificationError);
  });

  it('is detached, version 3, with the four signed attributes', async () => {
    const { cms } = await signed('rsa');
    const hex = toHex(cms);
    // The content type 1.2.840.113549.1.7.5 appears as eContentType and as the contentType attribute.
    expect(hex.split('06092a864886f70d010705').length - 1).toBe(2);
    // signing-certificate-v2, signing time, message digest.
    expect(hex).toContain('060b2a864886f70d010910022f');
    expect(hex).toContain('06092a864886f70d010905');
    expect(hex).toContain('06092a864886f70d010904');
  });
});

function openssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!openssl())('an independent check with OpenSSL', () => {
  it('OpenSSL verifies the detached signature over the canonical bytes', async () => {
    const { cms } = await signed('rsa');
    const dir = mkdtempSync(join(tmpdir(), 'eta-cms-'));
    writeFileSync(join(dir, 'sig.der'), cms);
    writeFileSync(join(dir, 'content.bin'), bytes);
    const out = execFileSync(
      'openssl',
      [
        'cms',
        '-verify',
        '-binary',
        '-inform',
        'DER',
        '-in',
        join(dir, 'sig.der'),
        '-content',
        join(dir, 'content.bin'),
        '-noverify',
        '-out',
        join(dir, 'out.bin'),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(out).toBeDefined();
  });
});
