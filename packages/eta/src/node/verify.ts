import { createHash, X509Certificate, verify as verifySignature } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { toHex } from '../canonical.js';
import { type CertificateInfo, describeCertificate, ETA_CONTENT_TYPE_OID, OID } from '../cms.js';

/**
 * The server's check of a CMS an agent sent back (PLAN §4), before the
 * document is called signed. It proves the CMS signs *this* document's
 * canonical digest with a certificate the company pinned; it does not prove
 * the ETA will accept the CMS's shape (SPEC-UNVERIFIED cms-detached), nor that
 * the certificate chains to an ETA-recognised authority — the ETA checks that.
 */

export type VerificationFailure =
  | 'unreadable'
  | 'not_signed_data'
  | 'not_detached'
  | 'content_type'
  | 'signer_count'
  | 'certificate_missing'
  | 'certificate_not_pinned'
  | 'certificate_expired'
  | 'attributes_missing'
  | 'digest_mismatch'
  | 'signing_time'
  | 'signing_certificate'
  | 'algorithm'
  | 'signature';

export class CmsVerificationError extends Error {
  constructor(readonly reason: VerificationFailure) {
    super(`The signature was refused: ${reason}`);
    this.name = 'CmsVerificationError';
  }
}

export interface VerifyInput {
  cms: Uint8Array;
  /** SHA-256 of the canonical document. */
  digest: Uint8Array;
  /** SHA-256 hex of each certificate the company allows. */
  pinnedCertificates: readonly string[];
  /** The signing time must fall inside this window. */
  notBefore: Date;
  notAfter: Date;
  contentTypeOid?: string;
}

export interface Verified {
  certificate: CertificateInfo;
  signingTime: Date;
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function attributeValue(attrs: pkijs.Attribute[], type: string): asn1js.AsnType | undefined {
  const matches = attrs.filter((attribute) => attribute.type === type);
  return matches.length === 1 && matches[0]?.values.length === 1
    ? (matches[0].values[0] as asn1js.AsnType)
    : undefined;
}

export async function verifyCadesBes(input: VerifyInput): Promise<Verified> {
  let signedData: pkijs.SignedData;
  try {
    const info = pkijs.ContentInfo.fromBER(buffer(input.cms));
    if (info.contentType !== OID.signedData) {
      throw new CmsVerificationError('not_signed_data');
    }
    signedData = new pkijs.SignedData({ schema: info.content });
  } catch (error) {
    if (error instanceof CmsVerificationError) {
      throw error;
    }
    throw new CmsVerificationError('unreadable');
  }

  if (signedData.encapContentInfo.eContent !== undefined) {
    throw new CmsVerificationError('not_detached');
  }
  if (signedData.encapContentInfo.eContentType !== (input.contentTypeOid ?? ETA_CONTENT_TYPE_OID)) {
    throw new CmsVerificationError('content_type');
  }
  if (signedData.signerInfos.length !== 1) {
    throw new CmsVerificationError('signer_count');
  }
  const signer = signedData.signerInfos[0]!;

  const certificates = (signedData.certificates ?? []).filter(
    (entry): entry is pkijs.Certificate => entry instanceof pkijs.Certificate,
  );
  const sid = signer.sid instanceof pkijs.IssuerAndSerialNumber ? signer.sid : null;
  const certificate = certificates.find(
    (entry) =>
      sid !== null &&
      entry.issuer.isEqual(sid.issuer) &&
      entry.serialNumber.isEqual(sid.serialNumber),
  );
  if (certificate === undefined) {
    throw new CmsVerificationError('certificate_missing');
  }
  const certificateDer = new Uint8Array(certificate.toSchema().toBER(false));
  const fingerprint = createHash('sha256').update(certificateDer).digest();
  if (!input.pinnedCertificates.includes(toHex(fingerprint))) {
    throw new CmsVerificationError('certificate_not_pinned');
  }

  const attrs = signer.signedAttrs?.attributes ?? [];
  const contentType = attributeValue(attrs, OID.contentType);
  const messageDigest = attributeValue(attrs, OID.messageDigest);
  const signingTime = attributeValue(attrs, OID.signingTime);
  const signingCertificate = attributeValue(attrs, OID.signingCertificateV2);
  if (
    signer.signedAttrs === undefined ||
    !(contentType instanceof asn1js.ObjectIdentifier) ||
    !(messageDigest instanceof asn1js.OctetString) ||
    !(signingTime instanceof asn1js.UTCTime) ||
    !(signingCertificate instanceof asn1js.Sequence)
  ) {
    throw new CmsVerificationError('attributes_missing');
  }
  if (contentType.valueBlock.toString() !== (input.contentTypeOid ?? ETA_CONTENT_TYPE_OID)) {
    throw new CmsVerificationError('content_type');
  }
  if (!equalBytes(new Uint8Array(messageDigest.valueBlock.valueHexView), input.digest)) {
    throw new CmsVerificationError('digest_mismatch');
  }
  const signedAt = signingTime.toDate();
  if (signedAt < input.notBefore || signedAt > input.notAfter) {
    throw new CmsVerificationError('signing_time');
  }
  if (signedAt < certificate.notBefore.value || signedAt > certificate.notAfter.value) {
    throw new CmsVerificationError('certificate_expired');
  }

  // signing-certificate-v2: the first ESSCertIDv2's hash is the signer's certificate's SHA-256.
  const certs = signingCertificate.valueBlock.value[0];
  const essCertId = certs instanceof asn1js.Sequence ? certs.valueBlock.value[0] : undefined;
  const first = essCertId instanceof asn1js.Sequence ? essCertId.valueBlock.value : [];
  const hashAt = first[0] instanceof asn1js.Sequence ? 1 : 0; // an explicit hashAlgorithm comes first
  if (first[0] instanceof asn1js.Sequence) {
    const algorithm = first[0].valueBlock.value[0];
    if (
      !(algorithm instanceof asn1js.ObjectIdentifier) ||
      algorithm.valueBlock.toString() !== OID.sha256
    ) {
      throw new CmsVerificationError('signing_certificate');
    }
  }
  const certHash = first[hashAt];
  if (
    !(certHash instanceof asn1js.OctetString) ||
    !equalBytes(new Uint8Array(certHash.valueBlock.valueHexView), fingerprint)
  ) {
    throw new CmsVerificationError('signing_certificate');
  }

  if (signer.digestAlgorithm.algorithmId !== OID.sha256) {
    throw new CmsVerificationError('algorithm');
  }
  const algorithm = signer.signatureAlgorithm.algorithmId;
  const x509 = new X509Certificate(certificateDer);
  const keyType = x509.publicKey.asymmetricKeyType;
  const rsa = algorithm === OID.rsaEncryption || algorithm === '1.2.840.113549.1.1.11';
  const ecdsa = algorithm === OID.ecdsaWithSha256;
  if (!((rsa && keyType === 'rsa') || (ecdsa && keyType === 'ec'))) {
    throw new CmsVerificationError('algorithm');
  }
  const ok = verifySignature(
    'sha256',
    new Uint8Array(signer.signedAttrs.encodedValue),
    x509.publicKey,
    new Uint8Array(signer.signature.valueBlock.valueHexView),
  );
  if (!ok) {
    throw new CmsVerificationError('signature');
  }
  return { certificate: await describeCertificate(certificateDer), signingTime: signedAt };
}

/** A PEM or Base64 certificate as DER. */
export function certificateDer(text: string): Uint8Array {
  const body = text.replace(/-----(BEGIN|END) CERTIFICATE-----/gu, '').replace(/\s+/gu, '');
  return new Uint8Array(Buffer.from(body, 'base64'));
}
