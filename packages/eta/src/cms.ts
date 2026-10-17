import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { toHex } from './canonical.js';

/**
 * CAdES-BES for an ETA document, assembled around a signature made elsewhere.
 *
 * The private key never comes here: it stays on the accountant's token. This
 * module builds the signed attributes, hands their DER to whatever holds the
 * key (`toBeSigned`), and wraps the raw signature it gets back into a detached
 * CMS SignedData (`finish`). The same code runs in the desktop agent and in
 * tests; the server verifies the result with `@integr8/eta/node`.
 *
 * SPEC-UNVERIFIED(cms-detached): as recalled from the ETA's reference signer —
 * a detached SignedData whose encapsulated content type is
 * `1.2.840.113549.1.7.5`; signed attributes content type (the same OID),
 * signing time, message digest (SHA-256 of the canonical bytes) and
 * signing-certificate-v2 (RFC 5035, SHA-256 of the certificate, with issuer
 * and serial). Confirm against https://sdk.invoicing.eta.gov.eg/signature-creation/
 * and one PreProd submission before relying on it.
 */

export const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  digestedData: '1.2.840.113549.1.7.5',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
} as const;

/** The encapsulated content type the signature declares. SPEC-UNVERIFIED(cms-detached). */
export const ETA_CONTENT_TYPE_OID = OID.digestedData;

export type KeyAlgorithm = 'rsa' | 'ecdsa';

export interface CertificateInfo {
  /** SHA-256 of the certificate's DER, lower-case hex: what a company pins. */
  sha256: string;
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
  keyAlgorithm: KeyAlgorithm | 'other';
}

const NAME_TYPES: Readonly<Record<string, string>> = {
  '2.5.4.3': 'CN',
  '2.5.4.5': 'serialNumber',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.97': 'organizationIdentifier',
  '1.2.840.113549.1.9.1': 'E',
};

function nameText(name: pkijs.RelativeDistinguishedNames): string {
  return name.typesAndValues
    .map((entry) => {
      const value = (entry.value.valueBlock as { value?: unknown }).value;
      return `${NAME_TYPES[entry.type] ?? entry.type}=${typeof value === 'string' ? value : ''}`;
    })
    .join(', ');
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buffer(bytes)));
}

function parseCertificate(der: Uint8Array): pkijs.Certificate {
  return pkijs.Certificate.fromBER(buffer(der));
}

/** The issuer Name exactly as the certificate encodes it, so it matches byte for byte. */
function issuerName(certificate: pkijs.Certificate): asn1js.BaseBlock {
  const raw = certificate.issuer.valueBeforeDecode;
  return raw.byteLength > 0 ? asn1js.fromBER(raw).result : certificate.issuer.toSchema();
}

function serial(certificate: pkijs.Certificate): asn1js.Integer {
  return new asn1js.Integer({ valueHex: certificate.serialNumber.valueBlock.valueHexView });
}

function keyAlgorithmOf(certificate: pkijs.Certificate): KeyAlgorithm | 'other' {
  const oid = certificate.subjectPublicKeyInfo.algorithm.algorithmId;
  return oid === OID.rsaEncryption ? 'rsa' : oid === OID.ecPublicKey ? 'ecdsa' : 'other';
}

export async function describeCertificate(der: Uint8Array): Promise<CertificateInfo> {
  const certificate = parseCertificate(der);
  return {
    sha256: toHex(await sha256(der)),
    subject: nameText(certificate.subject),
    issuer: nameText(certificate.issuer),
    serialNumber: toHex(new Uint8Array(certificate.serialNumber.valueBlock.valueHexView)),
    notBefore: certificate.notBefore.value,
    notAfter: certificate.notAfter.value,
    keyAlgorithm: keyAlgorithmOf(certificate),
  };
}

const oid = (value: string) => new asn1js.ObjectIdentifier({ value });
const sha256Algorithm = () => new asn1js.Sequence({ value: [oid(OID.sha256)] });

function attribute(type: string, value: asn1js.BaseBlock): asn1js.Sequence {
  return new asn1js.Sequence({ value: [oid(type), new asn1js.Set({ value: [value] })] });
}

function time(value: Date): asn1js.BaseBlock {
  // UTCTime until 2050, as RFC 5652 asks.
  return value.getUTCFullYear() < 2050
    ? new asn1js.UTCTime({ valueDate: value })
    : new asn1js.GeneralizedTime({ valueDate: value });
}

/** DER SET OF: the members sorted by their encodings. */
function sortedDer(members: asn1js.BaseBlock[]): asn1js.BaseBlock[] {
  const encoded = members.map((member) => new Uint8Array(member.toBER(false)));
  encoded.sort((a, b) => {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i += 1) {
      if (a[i] !== b[i]) {
        return a[i]! - b[i]!;
      }
    }
    return a.length - b.length;
  });
  return encoded.map((bytes) => asn1js.fromBER(buffer(bytes)).result);
}

export interface CadesInput {
  /** SHA-256 of the canonical document bytes. */
  digest: Uint8Array;
  certificateDer: Uint8Array;
  signingTime: Date;
  contentTypeOid?: string;
}

export interface PreparedCades {
  /** The DER of the signed attributes (a SET OF): what the key signs, with SHA-256. */
  toBeSigned: Uint8Array;
  keyAlgorithm: KeyAlgorithm;
  certificate: CertificateInfo;
  /** The ContentInfo DER around the raw signature over `toBeSigned`. */
  finish(signature: Uint8Array): Uint8Array;
}

export class UnsupportedCertificateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedCertificateError';
  }
}

export async function prepareCadesBes(input: CadesInput): Promise<PreparedCades> {
  if (input.digest.length !== 32) {
    throw new TypeError('The digest is SHA-256: 32 bytes');
  }
  const certificate = parseCertificate(input.certificateDer);
  const keyAlgorithm = keyAlgorithmOf(certificate);
  if (keyAlgorithm === 'other') {
    throw new UnsupportedCertificateError('Only RSA and EC certificates can sign');
  }
  const contentTypeOid = input.contentTypeOid ?? ETA_CONTENT_TYPE_OID;
  const certificateHash = await sha256(input.certificateDer);
  const issuerAndSerial = () =>
    new asn1js.Sequence({ value: [issuerName(certificate), serial(certificate)] });

  const signingCertificateV2 = new asn1js.Sequence({
    value: [
      // certs: SEQUENCE OF ESSCertIDv2
      new asn1js.Sequence({
        value: [
          new asn1js.Sequence({
            value: [
              // hashAlgorithm is SHA-256, the default, so it is left out (DER).
              new asn1js.OctetString({ valueHex: buffer(certificateHash) }),
              // issuerSerial: GeneralNames [directoryName] + serial
              new asn1js.Sequence({
                value: [
                  new asn1js.Sequence({
                    value: [
                      new asn1js.Constructed({
                        idBlock: { tagClass: 3, tagNumber: 4 },
                        value: [issuerName(certificate)],
                      }),
                    ],
                  }),
                  serial(certificate),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });

  const attributes = sortedDer([
    attribute(OID.contentType, oid(contentTypeOid)),
    attribute(OID.signingTime, time(input.signingTime)),
    attribute(OID.messageDigest, new asn1js.OctetString({ valueHex: buffer(input.digest) })),
    attribute(OID.signingCertificateV2, signingCertificateV2),
  ]);
  const toBeSigned = new Uint8Array(new asn1js.Set({ value: attributes }).toBER(false));
  const description = await describeCertificate(input.certificateDer);

  return {
    toBeSigned,
    keyAlgorithm,
    certificate: description,
    finish(signature: Uint8Array): Uint8Array {
      const signerInfo = new asn1js.Sequence({
        value: [
          new asn1js.Integer({ value: 1 }),
          issuerAndSerial(),
          sha256Algorithm(),
          new asn1js.Constructed({
            idBlock: { tagClass: 3, tagNumber: 0 },
            value: sortedDer(attributes),
          }),
          keyAlgorithm === 'rsa'
            ? new asn1js.Sequence({ value: [oid(OID.rsaEncryption), new asn1js.Null()] })
            : new asn1js.Sequence({ value: [oid(OID.ecdsaWithSha256)] }),
          new asn1js.OctetString({ valueHex: buffer(signature) }),
        ],
      });
      const signedData = new asn1js.Sequence({
        value: [
          // Version 3: the encapsulated content type is not id-data (RFC 5652 §5.1).
          new asn1js.Integer({ value: contentTypeOid === OID.data ? 1 : 3 }),
          new asn1js.Set({ value: [sha256Algorithm()] }),
          // Detached: the content type only, no content.
          new asn1js.Sequence({ value: [oid(contentTypeOid)] }),
          new asn1js.Constructed({
            idBlock: { tagClass: 3, tagNumber: 0 },
            value: [asn1js.fromBER(buffer(input.certificateDer)).result],
          }),
          new asn1js.Set({ value: [signerInfo] }),
        ],
      });
      const contentInfo = new asn1js.Sequence({
        value: [
          oid(OID.signedData),
          new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 0 }, value: [signedData] }),
        ],
      });
      return new Uint8Array(contentInfo.toBER(false));
    },
  };
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
