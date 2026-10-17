import { describe, expect, it } from 'vitest';
import { canonicalDigest, toHex } from './canonical.js';
import { fromBase64 } from './cms.js';
import { parseJsonText } from './json-text.js';
import { verifyCadesBes } from './node/verify.js';
import {
  inspectForSigning,
  type SigningRequest,
  SigningRefusedError,
  signRequest,
} from './signer.js';
import { createSoftSigner } from './testing/soft-signer.js';

const text =
  '{"issuer":{"type":"B","id":"100000001","name":"Nile Fire Safety"},"receiver":{"type":"B","id":"200000002","name":"Cairo Towers"},"documentType":"I","dateTimeIssued":"2026-10-17T09:30:15Z","internalID":"INV-000001","totalAmount":1111.5}';

async function request(overrides: Partial<SigningRequest> = {}): Promise<SigningRequest> {
  return {
    id: 'req-1',
    documentId: 'doc-1',
    internalId: 'INV-000001',
    environment: 'preprod',
    digest: toHex(await canonicalDigest(parseJsonText(text))),
    nonce: 'n'.repeat(64),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  };
}

describe('the signing agent protocol', () => {
  it('shows what will be signed, read from the document itself', async () => {
    const summary = await inspectForSigning(await request(), text);
    expect(summary).toEqual({
      internalId: 'INV-000001',
      documentType: 'I',
      issuedAt: '2026-10-17T09:30:15Z',
      issuerName: 'Nile Fire Safety',
      issuerId: '100000001',
      receiverName: 'Cairo Towers',
      receiverId: '200000002',
      totalAmount: '1111.5',
      environment: 'preprod',
    });
  });

  it('refuses a document whose digest differs from the request', async () => {
    await expect(
      inspectForSigning(await request(), text.replace('1111.5', '1111.50')),
    ).rejects.toMatchObject({
      reason: 'digest_mismatch',
    });
  });

  it('refuses an expired request and one naming another document', async () => {
    await expect(
      inspectForSigning(await request({ expiresAt: new Date(Date.now() - 1).toISOString() }), text),
    ).rejects.toBeInstanceOf(SigningRefusedError);
    await expect(
      inspectForSigning(await request({ internalId: 'INV-000002' }), text),
    ).rejects.toMatchObject({
      reason: 'document_mismatch',
    });
  });

  it('signs end to end with a test signer, and the server accepts it', async () => {
    const signer = await createSoftSigner();
    const req = await request();
    const response = await signRequest({
      request: req,
      unsignedDocumentText: text,
      signer,
      certificateSha256: signer.certificateSha256,
    });
    expect(response.requestId).toBe('req-1');
    expect(response.nonce).toBe(req.nonce);
    const verified = await verifyCadesBes({
      cms: fromBase64(response.cms),
      digest: await canonicalDigest(parseJsonText(text)),
      pinnedCertificates: [signer.certificateSha256],
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 60_000),
    });
    expect(verified.certificate.sha256).toBe(signer.certificateSha256);
  });

  it('refuses a certificate that is not on the token', async () => {
    const signer = await createSoftSigner();
    await expect(
      signRequest({
        request: await request(),
        unsignedDocumentText: text,
        signer,
        certificateSha256: 'ab'.repeat(32),
      }),
    ).rejects.toMatchObject({ reason: 'certificate_unknown' });
  });
});
