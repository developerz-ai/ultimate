// `HttpConfig.tls`, judged once at the boundary: a listener serves TLS with BOTH halves or not at
// all. A half pair handed to `Bun.serve` is a bare error or a plaintext socket nobody asked for,
// and a message that echoed the value would print a private key into a log.

import { HttpError } from './errors';

/** PEM text, as `Bun.serve`'s `tls` takes it — the CALLER reads files; this never touches disk. */
export interface HttpTls {
  readonly cert: string;
  readonly key: string;
}

const PEM_CERT = /-----BEGIN CERTIFICATE-----/;
const PEM_KEY = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;

/** Names which half is wrong, never what it holds. */
const tlsInvalid = (half: 'cert' | 'key', expected: string): HttpError =>
  new HttpError({
    code: 'X_CONFIG_INVALID',
    cause: `http.tls.${half} is not ${expected}; a listener serves TLS with a PEM certificate and its PEM private key together, or with neither`,
    fix: `TLS_CERT=/path/to/cert.pem TLS_KEY=/path/to/key.pem bun apps/web/server.ts   # or x dev --tls, which generates both`,
    meta: { option: `tls.${half}` },
  });

/** The pair as given when both halves are PEM of the right kind; refused otherwise. */
export function resolveHttpTls(tls: HttpTls | undefined): { tls?: HttpTls } {
  if (tls === undefined) return {};
  if (typeof tls.cert !== 'string' || !PEM_CERT.test(tls.cert)) {
    throw tlsInvalid('cert', 'a PEM certificate (-----BEGIN CERTIFICATE-----)');
  }
  if (typeof tls.key !== 'string' || !PEM_KEY.test(tls.key)) {
    throw tlsInvalid('key', 'a PEM private key (-----BEGIN PRIVATE KEY-----)');
  }
  return { tls: { cert: tls.cert, key: tls.key } };
}
