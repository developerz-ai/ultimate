// libpq's sslmode semantics for the replicator's own wire client: which modes verify, what a
// handshake's authorization error means under each, and where the trust anchor comes from. The
// socket half is `pg-socket.test.ts`; the real server is `pg-tls.live.test.ts`.
import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { ReplicationFailedError, ReplicationTlsError } from './errors';
import { judgeHandshake, parseSsl, rootCertificate } from './pg-tls';

const params = (query: string): URLSearchParams => new URLSearchParams(query);

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return expect.unreachable('expected a refusal');
};

const verificationError = (code: string): Error => Object.assign(new Error(code), { code });

describe('parseSsl', () => {
  test('libpq defaults to prefer, and accepts all six modes', () => {
    expect(parseSsl(params(''))).toEqual({ ssl: 'prefer', rootCert: undefined });
    for (const mode of [
      'disable',
      'allow',
      'prefer',
      'require',
      'verify-ca',
      'verify-full',
    ] as const) {
      expect(parseSsl(params(`sslmode=${mode}`)).ssl).toBe(mode);
    }
  });

  test('an unknown sslmode is refused with the six it could have been', () => {
    const error = thrown(() => parseSsl(params('sslmode=verify')));
    expect(error).toBeInstanceOf(ReplicationFailedError);
    expect((error as ReplicationFailedError).cause).toContain('verify-full');
  });

  // libpq: "if a root CA file exists, the behavior of sslmode=require will be the same as that of
  // verify-ca" — a CA the operator named is a CA they meant to be checked against.
  test('require with an sslrootcert file verifies the chain, as libpq does', () => {
    expect(parseSsl(params('sslmode=require&sslrootcert=/etc/ca.crt'))).toEqual({
      ssl: 'verify-ca',
      rootCert: '/etc/ca.crt',
    });
  });

  test('sslrootcert=system defaults to verify-full and refuses a weaker mode', () => {
    expect(parseSsl(params('sslrootcert=system'))).toEqual({
      ssl: 'verify-full',
      rootCert: 'system',
    });
    const error = thrown(() => parseSsl(params('sslrootcert=system&sslmode=verify-ca')));
    expect((error as { code?: string }).code).toBe('X_REPLICATION_FAILED');
    expect((error as ReplicationFailedError).fix).toContain('sslmode=verify-full');
  });
});

describe('judgeHandshake', () => {
  const host = 'db.internal';

  // libpq's prefer and require encrypt and verify NOTHING — a private-CA server (every CNPG
  // cluster) failed here because Bun's default verifies the chain.
  test('allow, prefer and require accept an unverifiable certificate', () => {
    for (const ssl of ['allow', 'prefer', 'require'] as const) {
      expect(
        judgeHandshake({ ssl, host }, verificationError('UNABLE_TO_VERIFY_LEAF_SIGNATURE')),
      ).toBeUndefined();
      expect(
        judgeHandshake({ ssl, host }, verificationError('ERR_TLS_CERT_ALTNAME_INVALID')),
      ).toBeUndefined();
    }
  });

  test('verify-ca refuses a chain it cannot verify, and names the CA setting', () => {
    const error = judgeHandshake(
      { ssl: 'verify-ca', host },
      verificationError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'),
    );
    expect(error).toBeInstanceOf(ReplicationTlsError);
    expect(error?.code).toBe('X_REPLICATION_TLS');
    expect(error?.cause).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(error?.fix).toContain('sslrootcert=');
  });

  test('verify-ca accepts a verified chain whatever the host name', () => {
    expect(
      judgeHandshake({ ssl: 'verify-ca', host }, verificationError('ERR_TLS_CERT_ALTNAME_INVALID')),
    ).toBeUndefined();
    expect(judgeHandshake({ ssl: 'verify-ca', host }, null)).toBeUndefined();
  });

  test('verify-full refuses a host name the certificate does not carry', () => {
    const error = judgeHandshake(
      { ssl: 'verify-full', host },
      verificationError('ERR_TLS_CERT_ALTNAME_INVALID'),
    );
    expect(error?.code).toBe('X_REPLICATION_TLS');
    expect(error?.cause).toContain(host);
    expect(error?.fix).toContain('sslmode=verify-ca');
    expect(judgeHandshake({ ssl: 'verify-full', host }, null)).toBeUndefined();
  });

  test('an authorization error that is not an Error still refuses a verifying mode', () => {
    const error = judgeHandshake({ ssl: 'verify-full', host }, 'CERT_HAS_EXPIRED');
    expect(isUltimateError(error)).toBe(true);
    expect(error?.cause).toContain('CERT_HAS_EXPIRED');
  });
});

describe('rootCertificate', () => {
  test('no sslrootcert, or system, is the runtime trust store', async () => {
    expect(await rootCertificate(undefined)).toBeUndefined();
    expect(await rootCertificate('system')).toBeUndefined();
  });

  test('a file is read as the only trust anchor', async () => {
    const path = `${Bun.env['TMPDIR'] ?? '/tmp'}/x-pg-tls-${process.pid}.crt`;
    await Bun.write(path, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    try {
      expect(await rootCertificate(path)).toContain('BEGIN CERTIFICATE');
    } finally {
      await Bun.file(path).delete();
    }
  });

  test('a file that is not there is X_REPLICATION_TLS naming the setting, never a bare ENOENT', async () => {
    const error = await rootCertificate('/nonexistent/x-ca.crt').then(
      () => expect.unreachable('a missing root certificate was accepted'),
      (failure: unknown) => failure,
    );
    expect((error as { code?: string }).code).toBe('X_REPLICATION_TLS');
    expect((error as ReplicationTlsError).fix).toContain('sslrootcert');
  });
});
