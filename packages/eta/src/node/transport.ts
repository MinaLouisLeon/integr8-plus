import { request as httpRequest } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';
import { type EtaTransport, TransportError, type TransportResponse } from '../client.js';

/**
 * An HTTPS transport for the ETA client.
 *
 * `extraCaPem` adds certificates to the trusted roots **for this transport
 * only** — the ETA's PreProd chain where a test deployment needs it (README
 * "Environments"). TLS verification is never turned off; there is no option
 * for it. Plain `http:` is accepted only for loopback addresses, for tests
 * against a local fake.
 */
export interface NodeTransportOptions {
  extraCaPem?: string | null;
  /** Largest answer read, in bytes. PDFs are the big ones. */
  maxResponseBytes?: number;
}

function loopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

export function createNodeTransport(options: NodeTransportOptions = {}): EtaTransport {
  const agent = new Agent({
    keepAlive: true,
    ...(options.extraCaPem === undefined ||
    options.extraCaPem === null ||
    options.extraCaPem.trim() === ''
      ? {}
      : { ca: [...rootCertificates, options.extraCaPem] }),
  });
  const maxBytes = options.maxResponseBytes ?? 20 * 1024 * 1024;

  return (req) =>
    new Promise<TransportResponse>((resolve, reject) => {
      const url = new URL(req.url);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) {
        reject(new TransportError('network', 'Only HTTPS is allowed'));
        return;
      }
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const body = req.body === undefined ? undefined : Buffer.from(req.body, 'utf8');
      const outgoing = send(
        url,
        {
          method: req.method,
          headers: {
            ...req.headers,
            ...(body === undefined ? {} : { 'content-length': String(body.length) }),
          },
          ...(url.protocol === 'https:' ? { agent } : {}),
          timeout: req.timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              response.destroy(new Error('The answer is too large'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers)) {
              if (typeof value === 'string') {
                headers[name.toLowerCase()] = value;
              } else if (Array.isArray(value)) {
                headers[name.toLowerCase()] = value.join(', ');
              }
            }
            resolve({
              status: response.statusCode ?? 0,
              headers,
              body: new Uint8Array(Buffer.concat(chunks)),
            });
          });
          response.on('error', (error) => reject(new TransportError('network', error.message)));
        },
      );
      outgoing.on('timeout', () => {
        outgoing.destroy();
        reject(new TransportError('timeout', 'No answer in time'));
      });
      outgoing.on('error', (error) => reject(new TransportError('network', error.message)));
      if (body !== undefined) {
        outgoing.write(body);
      }
      outgoing.end();
    });
}
