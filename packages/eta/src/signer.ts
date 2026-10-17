import { canonicalDigest, toHex } from './canonical.js';
import { type CertificateInfo, prepareCadesBes, toBase64 } from './cms.js';
import { parseJsonText, property, stringValue } from './json-text.js';

/**
 * Signing an ETA document on the accountant's machine.
 *
 * The protocol (PLAN §4):
 *
 * 1. A person with `eta.submit` asks for a signature. The server records a
 *    **signing request**: the company, the document, the SHA-256 of its
 *    canonical form, a random nonce and an expiry.
 * 2. The agent — the company's desktop app, signed in as a member with
 *    `eta.sign` — claims the request and downloads the unsigned document text.
 * 3. The agent recomputes the canonical digest itself and refuses a request
 *    whose digest differs. What it shows the person comes from the document
 *    it will sign, not from anything else the server says.
 * 4. The person confirms, having seen the document's number, receiver, total
 *    and environment, and the certificate that will sign. The token's own
 *    middleware asks for the PIN: the PIN never reaches this code, the app's
 *    web view, or the server.
 * 5. The agent returns `{ requestId, nonce, cms }`. The server accepts it only
 *    for an open, unexpired request of this company, with this nonce, whose
 *    CMS verifies against the stored digest and a certificate the company
 *    pinned.
 *
 * `DigestSigner` is what a hardware token must provide. No implementation for
 * real tokens exists yet (PLAN §9): it needs the token's model, middleware and
 * operating system. Tests use the software signer in `@integr8/eta/testing`,
 * which production never loads.
 */

export interface DigestSigner {
  /** What this signer is, for the screen: `PKCS#11: <library>`, `Windows CNG`, `test`. */
  readonly kind: string;
  /** Certificates that can sign, with their DER. */
  listCertificates(): Promise<{ info: CertificateInfo; der: Uint8Array }[]>;
  /**
   * Signs `data` (the DER of the CMS signed attributes) with SHA-256 and the
   * certificate's private key: PKCS#1 v1.5 for RSA, DER-encoded ECDSA for EC.
   * The PIN, if any, is asked for by the token's own middleware.
   */
  sign(certificateSha256: string, data: Uint8Array): Promise<Uint8Array>;
}

export interface SigningRequest {
  id: string;
  documentId: string;
  /** `INV-000123`. */
  internalId: string;
  environment: 'preprod' | 'production';
  /** SHA-256 of the canonical document, lower-case hex. */
  digest: string;
  nonce: string;
  expiresAt: string;
}

/** What the agent shows the person before they confirm, read from the document itself. */
export interface SigningSummary {
  internalId: string;
  documentType: string;
  issuedAt: string;
  issuerName: string;
  issuerId: string;
  receiverName: string;
  receiverId: string | null;
  totalAmount: string;
  environment: SigningRequest['environment'];
}

export class SigningRefusedError extends Error {
  constructor(
    readonly reason: 'digest_mismatch' | 'document_mismatch' | 'expired' | 'certificate_unknown',
    message: string,
  ) {
    super(message);
    this.name = 'SigningRefusedError';
  }
}

/** Reads and checks the document the agent is about to sign. */
export async function inspectForSigning(
  request: SigningRequest,
  unsignedDocumentText: string,
  now: Date = new Date(),
): Promise<SigningSummary> {
  if (Date.parse(request.expiresAt) <= now.getTime()) {
    throw new SigningRefusedError('expired', 'This signing request has expired.');
  }
  const document = parseJsonText(unsignedDocumentText);
  const digest = toHex(await canonicalDigest(document));
  if (digest !== request.digest) {
    throw new SigningRefusedError(
      'digest_mismatch',
      'The document does not match the signing request.',
    );
  }
  const internalId = stringValue(property(document, 'internalID')) ?? '';
  if (internalId !== request.internalId) {
    throw new SigningRefusedError(
      'document_mismatch',
      'The document is not the one the request names.',
    );
  }
  const issuer = property(document, 'issuer');
  const receiver = property(document, 'receiver');
  const total = property(document, 'totalAmount');
  return {
    internalId,
    documentType: stringValue(property(document, 'documentType')) ?? '',
    issuedAt: stringValue(property(document, 'dateTimeIssued')) ?? '',
    issuerName: stringValue(property(issuer, 'name')) ?? '',
    issuerId: stringValue(property(issuer, 'id')) ?? '',
    receiverName: stringValue(property(receiver, 'name')) ?? '',
    receiverId: stringValue(property(receiver, 'id')) ?? null,
    totalAmount: total?.kind === 'number' ? total.raw : '',
    environment: request.environment,
  };
}

export interface SignedResponse {
  requestId: string;
  nonce: string;
  /** The CMS, Base64. */
  cms: string;
}

/**
 * Signs a request the person has confirmed. Call `inspectForSigning` first and
 * show its summary; this repeats the digest check so it cannot be skipped.
 */
export async function signRequest(input: {
  request: SigningRequest;
  unsignedDocumentText: string;
  signer: DigestSigner;
  certificateSha256: string;
  now?: Date;
}): Promise<SignedResponse> {
  const now = input.now ?? new Date();
  await inspectForSigning(input.request, input.unsignedDocumentText, now);
  const certificates = await input.signer.listCertificates();
  const chosen = certificates.find((entry) => entry.info.sha256 === input.certificateSha256);
  if (chosen === undefined) {
    throw new SigningRefusedError('certificate_unknown', 'That certificate is not on this token.');
  }
  const digest = await canonicalDigest(parseJsonText(input.unsignedDocumentText));
  const prepared = await prepareCadesBes({
    digest,
    certificateDer: chosen.der,
    signingTime: now,
  });
  const signature = await input.signer.sign(input.certificateSha256, prepared.toBeSigned);
  return {
    requestId: input.request.id,
    nonce: input.request.nonce,
    cms: toBase64(prepared.finish(signature)),
  };
}
