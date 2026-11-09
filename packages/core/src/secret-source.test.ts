// The master key's port: the two built-in sources in their order, and an app-written one (a KMS,
// Vault) reaching both readers of the key — `installSecrets()` and the seal ring — through the one
// installer on `@ultimat3/core/adapter`.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive (`mkdtemp`) and no directory removal (`rm`).
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no temp-directory location; `tmpdir()` is the platform's.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { installSecretSource } from './adapter';
import { resolveSealKeys } from './seal-keys';
import {
  defaultSecretSource,
  envSecretSource,
  fileSecretSource,
  resolveMasterKey,
  SECRETS_KEY_ENV,
  type SecretSource,
} from './secret-source';
import { generateMasterKey, masterKeyId, parseMasterKey, sealSecrets } from './secrets';
import { installSecrets, secretsPath, writeMasterKeyFile } from './secrets-store';

const KEY = generateMasterKey();
const OTHER = generateMasterKey();
let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ultimate-secret-source-'));
  writeMasterKeyFile(root, OTHER);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

let release = (): void => {};
const install = (source: SecretSource): void => {
  release = installSecretSource(source);
};

afterEach(() => {
  release();
});

/** What a KMS adapter looks like from here: an async lookup with a name of its own. */
const kms = (hex: string | undefined): SecretSource => ({
  name: 'kms',
  masterKey: async () => (hex === undefined ? undefined : { hex, source: 'kms', at: 'kms://k1' }),
});

describe('the built-in sources', () => {
  test('env reads ULTIMATE_SECRETS_KEY, file reads .secrets.key', async () => {
    const env = { [SECRETS_KEY_ENV]: KEY };
    expect((await envSecretSource.masterKey({ root, env }))?.hex).toBe(KEY);
    expect((await fileSecretSource.masterKey({ root, env: {} }))?.hex).toBe(OTHER);
  });

  test('the default asks env first, the file second', async () => {
    const both = await defaultSecretSource.masterKey({ root, env: { [SECRETS_KEY_ENV]: KEY } });
    expect([both?.source, both?.hex]).toEqual(['env', KEY]);
    expect((await defaultSecretSource.masterKey({ root, env: {} }))?.source).toBe('file');
  });
});

describe('an installed source', () => {
  test('is what resolveMasterKey asks, and its release restores the default', async () => {
    install(kms(KEY));
    expect((await resolveMasterKey(root, {}))?.at).toBe('kms://k1');
    release();
    expect((await resolveMasterKey(root, {}))?.source).toBe('file');
  });

  test('installSecrets opens the committed file with its key and reports its name', async () => {
    const app = join(root, 'app');
    const at = { file: secretsPath(app), key: 'kms' };
    await Bun.write(secretsPath(app), await sealSecrets({ SESSION_SECRET: 's' }, KEY, at));
    install(kms(KEY));
    const env: Record<string, string | undefined> = {};
    const report = await installSecrets({ root: app, env });
    expect([report.keySource, env['SESSION_SECRET']]).toEqual(['kms', 's']);
  });

  test('a source with no key is X_SECRETS_KEY_MISSING, never an empty install', async () => {
    const app = join(root, 'app');
    install(kms(undefined));
    await expect(installSecrets({ root: app, env: {} })).rejects.toBeUltimateError(
      'X_SECRETS_KEY_MISSING',
    );
  });

  test('the seal ring takes its current key from the same source', async () => {
    install(kms(KEY));
    const ring = await resolveSealKeys({ root, env: {} });
    expect(ring.current.id).toBe(await masterKeyId(parseMasterKey(KEY, 'kms')));
  });
});

describe('the resolved key is cached per installed source', () => {
  /** A KMS stand-in that counts its round trips. */
  const counting = (hex: string | undefined) => {
    let calls = 0;
    const source: SecretSource = {
      name: 'kms',
      masterKey: async () => {
        calls += 1;
        return hex === undefined ? undefined : { hex, source: 'kms', at: 'kms://k1' };
      },
    };
    return { source, calls: () => calls };
  };

  test('fifty seals and fifty opens ask the source once', async () => {
    const kmsSource = counting(KEY);
    install(kmsSource.source);
    for (let i = 0; i < 100; i += 1) await resolveSealKeys({ root, env: {} });
    expect(kmsSource.calls()).toBe(1);
  });

  test('a new install and its release each ask again', async () => {
    const first = counting(KEY);
    install(first.source);
    await resolveMasterKey(root, {});
    const second = counting(OTHER);
    const releaseSecond = installSecretSource(second.source);
    expect((await resolveMasterKey(root, {}))?.hex).toBe(OTHER);
    releaseSecond();
    expect((await resolveMasterKey(root, {}))?.hex).toBe(KEY);
    expect([first.calls(), second.calls()]).toEqual([2, 1]);
  });

  test('a source with no key, or one that throws, is asked again next time', async () => {
    const missing = counting(undefined);
    install(missing.source);
    await resolveMasterKey(root, {});
    await resolveMasterKey(root, {});
    expect(missing.calls()).toBe(2);
    release();
    let calls = 0;
    install({
      name: 'kms',
      masterKey: async () => {
        calls += 1;
        throw { code: 'X_PROBE' };
      },
    });
    await expect(resolveMasterKey(root, {})).rejects.toEqual({ code: 'X_PROBE' });
    await expect(resolveMasterKey(root, {})).rejects.toEqual({ code: 'X_PROBE' });
    expect(calls).toBe(2);
  });

  test('the built-in default is never cached: a rotated key file is read on the next call', async () => {
    const dir = join(root, 'rotating');
    await Bun.write(join(dir, '.keep'), '');
    writeMasterKeyFile(dir, KEY);
    expect((await resolveMasterKey(dir, {}))?.hex).toBe(KEY);
    writeMasterKeyFile(dir, OTHER);
    expect((await resolveMasterKey(dir, {}))?.hex).toBe(OTHER);
  });
});

describe("an app source's refusals name the source, never the env var or a key file", () => {
  test('a seal with no key from the source is X_SEAL_KEY_MISSING naming it and runtime.ts', async () => {
    install(kms(undefined));
    try {
      await resolveSealKeys({ root, env: {} });
      expect.unreachable('a missing key sealed');
    } catch (error) {
      expect(error).toBeUltimateError('X_SEAL_KEY_MISSING');
      const { cause, fix } = error as { cause: string; fix: string };
      expect(cause).toContain('kms');
      expect(cause).not.toContain(SECRETS_KEY_ENV);
      expect(fix).toContain('apps/<app>/runtime.ts');
    }
  });

  test('a malformed key from the source is X_SECRETS_KEY_INVALID with no `wc -c` of a file', async () => {
    install(kms('abc'));
    try {
      await resolveSealKeys({ root, env: {} });
      expect.unreachable('a malformed key sealed');
    } catch (error) {
      expect(error).toBeUltimateError('X_SECRETS_KEY_INVALID');
      const { fix } = error as { fix: string };
      expect(fix).not.toContain('wc -c');
      expect(fix).toContain('apps/<app>/runtime.ts');
    }
  });
});
