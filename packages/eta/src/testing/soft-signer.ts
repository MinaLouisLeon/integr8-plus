import { createHash, generateKeyPairSync, sign, webcrypto, type KeyObject } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { toHex } from '../canonical.js';
import { describeCertificate } from '../cms.js';
import type { DigestSigner } from '../signer.js';

/**
 * A software signer with a self-signed certificate. **Tests only.**
 *
 * It exists so the CMS assembly, the agent protocol and the server's
 * verification can be exercised end to end without a token. Nothing in the
 * API or the apps imports this module, and the ETA would reject its
 * certificate. It proves nothing about real hardware signing (PLAN §9).
 */

export interface SoftSigner extends DigestSigner {
  certificateDer: Uint8Array;
  certificateSha256: string;
  privateKey: KeyObject;
}

let engineReady = false;

function useNodeWebCrypto(): void {
  if (!engineReady) {
    pkijs.setEngine(
      'node',
      new pkijs.CryptoEngine({ name: 'node', crypto: webcrypto as unknown as Crypto }),
    );
    engineReady = true;
  }
}

export async function createSoftSigner(
  options: {
    algorithm?: 'rsa' | 'ecdsa';
    commonName?: string;
    notBefore?: Date;
    notAfter?: Date;
  } = {},
): Promise<SoftSigner> {
  useNodeWebCrypto();
  const algorithm = options.algorithm ?? 'rsa';
  const pair =
    algorithm === 'rsa'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ec', { namedCurve: 'P-256' });

  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  certificate.serialNumber = new asn1js.Integer({
    value: Math.floor(Math.random() * 1_000_000) + 1,
  });
  const name = [
    new pkijs.AttributeTypeAndValue({
      type: '2.5.4.6',
      value: new asn1js.PrintableString({ value: 'EG' }),
    }),
    new pkijs.AttributeTypeAndValue({
      type: '2.5.4.10',
      value: new asn1js.Utf8String({ value: 'Integr8 Test Only' }),
    }),
    new pkijs.AttributeTypeAndValue({
      type: '2.5.4.3',
      value: new asn1js.Utf8String({ value: options.commonName ?? 'Software test signer' }),
    }),
  ];
  certificate.issuer.typesAndValues = name;
  certificate.subject.typesAndValues = name;
  certificate.notBefore.value = options.notBefore ?? new Date(Date.now() - 24 * 3600 * 1000);
  certificate.notAfter.value = options.notAfter ?? new Date(Date.now() + 365 * 24 * 3600 * 1000);

  const subtle = webcrypto.subtle;
  const publicKey = await subtle.importKey(
    'spki',
    pair.publicKey.export({ type: 'spki', format: 'der' }),
    algorithm === 'rsa'
      ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
      : { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
  const privateKey = await subtle.importKey(
    'pkcs8',
    pair.privateKey.export({ type: 'pkcs8', format: 'der' }),
    algorithm === 'rsa'
      ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
      : { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  );
  await certificate.subjectPublicKeyInfo.importKey(publicKey as unknown as CryptoKey);
  await certificate.sign(privateKey as unknown as CryptoKey, 'SHA-256');
  const der = new Uint8Array(certificate.toSchema(true).toBER(false));
  const sha256 = toHex(createHash('sha256').update(der).digest());
  const info = await describeCertificate(der);

  return {
    kind: 'test',
    certificateDer: der,
    certificateSha256: sha256,
    privateKey: pair.privateKey,
    listCertificates: () => Promise.resolve([{ info, der }]),
    sign: (certificateSha256, data) => {
      if (certificateSha256 !== sha256) {
        return Promise.reject(new Error('Unknown certificate'));
      }
      return Promise.resolve(new Uint8Array(sign('sha256', data, pair.privateKey)));
    },
  };
}
