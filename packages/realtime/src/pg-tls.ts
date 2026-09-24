// Single responsibility: libpq's `sslmode` / `sslrootcert` semantics for the replicator's own wire
// client — which modes exist, which of them VERIFY, what a handshake's authorization error means
// under each, and where the trust anchor comes from. The socket mechanics are `pg-socket.ts`'s.

import { renderFixShellArg, renderThrowable, stringField } from '@ultimat3/core';
import { ReplicationFailedError, ReplicationTlsError } from './errors';

/**
 * libpq's six. `disable` never offers TLS; `allow`, `prefer` and `require` encrypt and verify
 * NOTHING; `verify-ca` checks the chain; `verify-full` checks the chain and the host name.
 */
export type SslMode = 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';

const SSL_MODES: readonly SslMode[] = [
  'disable',
  'allow',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
];

const isSslMode = (value: string): value is SslMode =>
  (SSL_MODES as readonly string[]).includes(value);

/** A path to a PEM file, `'system'` for the runtime's store, or `undefined` for its default. */
export interface SslSettings {
  readonly ssl: SslMode;
  readonly rootCert: string | undefined;
}

/**
 * The connection URL's TLS half, with libpq's two couplings: `require` with a root certificate
 * FILE behaves as `verify-ca` (a CA the operator named is one they meant to be checked against),
 * and `sslrootcert=system` defaults to `verify-full` and refuses anything weaker — the system
 * store trusts every public CA, so only the host name makes it mean anything.
 */
export function parseSsl(params: URLSearchParams): SslSettings {
  const given = params.get('sslmode');
  const rootCert = params.get('sslrootcert') ?? undefined;
  const mode = given ?? (rootCert === 'system' ? 'verify-full' : 'prefer');
  if (!isSslMode(mode)) {
    throw new ReplicationFailedError({
      stage: 'connect',
      detail: `sslmode=${mode} is not one of ${SSL_MODES.join(', ')}`,
      fix: 'use ?sslmode=verify-full for a managed database, ?sslmode=disable for a local one',
    });
  }
  if (rootCert === 'system' && mode !== 'verify-full') {
    throw new ReplicationFailedError({
      stage: 'connect',
      detail: `sslrootcert=system trusts every public CA, so sslmode=${mode} would prove nothing`,
      fix: 'use ?sslrootcert=system&sslmode=verify-full, or name your CA: ?sslrootcert=/path/ca.crt',
    });
  }
  if (mode === 'require' && rootCert !== undefined && rootCert !== 'system') {
    return { ssl: 'verify-ca', rootCert };
  }
  return { ssl: mode, rootCert };
}

/** Whether a mode asks the runtime for the verification at all. */
export const verifies = (ssl: SslMode): boolean => ssl === 'verify-ca' || ssl === 'verify-full';

/** OpenSSL's code for a certificate whose chain verified but whose names do not include the host. */
const HOST_MISMATCH = 'ERR_TLS_CERT_ALTNAME_INVALID';

/**
 * The verdict on a completed handshake. The runtime is always asked NOT to reject
 * (`rejectUnauthorized: false`) and reports what it found instead, chain errors ahead of the host
 * name; this decides what that report means under `ssl`. `undefined` is "carry on".
 */
export function judgeHandshake(
  target: { readonly ssl: SslMode; readonly host: string; readonly port: number },
  authorizationError: unknown,
): ReplicationTlsError | undefined {
  if (!verifies(target.ssl)) return undefined;
  if (authorizationError === null || authorizationError === undefined) return undefined;
  const code =
    stringField(authorizationError, 'code') ??
    (typeof authorizationError === 'string'
      ? authorizationError
      : renderThrowable(authorizationError));
  if (code === HOST_MISMATCH) {
    if (target.ssl === 'verify-ca') return undefined;
    return new ReplicationTlsError({
      detail: `the server certificate does not name ${target.host} (${code}) and sslmode=verify-full checks it`,
      // The target's own host and port, so the pasted command reaches this server; a host a shell
      // would misread becomes the libpq env pair instead, which a shell expands rather than runs.
      fix: `openssl s_client -starttls postgres -connect ${renderFixShellArg(`${target.host}:${target.port}`, '"$PGHOST:$PGPORT"')} </dev/null | openssl x509 -noout -ext subjectAltName   # connect with a name it lists, or use ?sslmode=verify-ca to check the chain alone`,
    });
  }
  return new ReplicationTlsError({
    detail: `the server certificate did not verify (${code}) and sslmode=${target.ssl} checks it`,
    fix: 'pass the server CA with ?sslrootcert=/path/to/ca.crt, or use ?sslmode=require to encrypt without verifying',
  });
}

/**
 * The trust anchor `upgradeTLS` gets as `ca`: a named file REPLACES the runtime store, as libpq's
 * `root.crt` does; `system` and absent both leave the runtime's store (which honours
 * `NODE_EXTRA_CA_CERTS`). libpq reads `~/.postgresql/root.crt` when nothing is named — a container
 * has no such home, so this build never looks there.
 */
export async function rootCertificate(rootCert: string | undefined): Promise<string | undefined> {
  if (rootCert === undefined || rootCert === 'system') return undefined;
  const file = Bun.file(rootCert);
  if (!(await file.exists())) {
    throw new ReplicationTlsError({
      detail: 'sslrootcert names a file that does not exist',
      fix: 'mount the server CA and point ?sslrootcert= at it, or use ?sslrootcert=system for a public CA',
    });
  }
  // `exists()` is not readability: a secret mounted 0600 for another user exists and still refuses
  // the read, which escaped as a raw runtime error with no code.
  try {
    return await file.text();
  } catch (error) {
    throw new ReplicationTlsError({
      detail: `sslrootcert names a file this process cannot read: ${renderThrowable(error)}`,
      fix: 'id -u   # the replicator runs as this user: mount the CA readable by it, or use ?sslrootcert=system for a public CA',
    });
  }
}
