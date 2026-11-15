// `TLS_CERT` / `TLS_KEY`: the container's own TLS listener, read from two paths at boot — both or
// neither, refused with a code naming the half that is wrong, the key's bytes never printed.

import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { tlsFromEnv } from './serve-env-tls';

const DIR = join(import.meta.dir, '..', `.serve-tls-fixture-${process.pid}`);
const CERT = join(DIR, 'cert.pem');
const KEY = join(DIR, 'key.pem');
afterAll(() => rm(DIR, { recursive: true, force: true }));

const PEM_CERT = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const PEM_KEY = '-----BEGIN PRIVATE KEY-----\nSECRETBYTES\n-----END PRIVATE KEY-----\n';

describe('unit · TLS_CERT and TLS_KEY', () => {
  test('neither set, or both blank, is a plaintext listener — no tls at all', async () => {
    expect(await tlsFromEnv({})).toBeUndefined();
    expect(await tlsFromEnv({ TLS_CERT: ' ', TLS_KEY: '' })).toBeUndefined();
  });

  test('both set: the two files are read as PEM text', async () => {
    await Bun.write(CERT, PEM_CERT);
    await Bun.write(KEY, PEM_KEY);
    expect(await tlsFromEnv({ TLS_CERT: CERT, TLS_KEY: KEY })).toEqual({
      cert: PEM_CERT,
      key: PEM_KEY,
    });
  });

  test('one half alone, or a path that reads nothing, is X_CONFIG_INVALID naming the variable', async () => {
    await Bun.write(CERT, PEM_CERT);
    await Bun.write(KEY, PEM_KEY);
    const cases: readonly [Record<string, string>, string][] = [
      [{ TLS_CERT: CERT }, 'TLS_KEY'],
      [{ TLS_KEY: KEY }, 'TLS_CERT'],
      [{ TLS_CERT: join(DIR, 'missing.pem'), TLS_KEY: KEY }, 'TLS_CERT'],
    ];
    for (const [env, named] of cases) {
      const refusal = await tlsFromEnv(env).then(
        () => expect.unreachable('a half-declared pair was accepted'),
        (error: unknown) => error as { code: string; cause: string },
      );
      expect(refusal.code).toBe('X_CONFIG_INVALID');
      expect(refusal.cause).toContain(named);
      expect(JSON.stringify(refusal)).not.toContain('SECRETBYTES');
    }
  });
});
