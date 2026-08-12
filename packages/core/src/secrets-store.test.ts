// The store's job is the seam between a committed file and `defineEnv`, so what is tested is the
// seam: which key wins, what happens when there is none, and — the load-bearing one — that a real
// environment variable is never overwritten by the committed file.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// Bun ships no temp-directory primitive: `mkdtemp`/`rm` build and remove the throwaway app roots.
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineEnv, type EnvSchema } from './env';
import { generateMasterKey, sealSecrets } from './secrets';
import {
  findMasterKey,
  installSecrets,
  masterKeyPath,
  readSecretsFile,
  requireMasterKey,
  SECRETS_FILE,
  SECRETS_KEY_ENV,
  SECRETS_KEY_MODE,
  secretsFileExists,
  secretsPath,
  writeMasterKeyFile,
  writeSecretsFile,
} from './secrets-store';

const KEY = generateMasterKey();
const OTHER_KEY = generateMasterKey();

let base = '';
let counter = 0;

/** A throwaway app root, optionally holding a sealed file and/or a key file. */
async function appRoot(options: { values?: Record<string, string>; keyFile?: string } = {}) {
  counter += 1;
  const root = join(base, `app-${counter}`);
  await Bun.write(join(root, '.keep'), '');
  if (options.values !== undefined) {
    const at = { file: secretsPath(root), key: SECRETS_KEY_ENV };
    await Bun.write(secretsPath(root), await sealSecrets(options.values, KEY, at));
  }
  if (options.keyFile !== undefined) writeMasterKeyFile(root, options.keyFile);
  return root;
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'ultimate-secrets-'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('unit · finding the master key', () => {
  test('the env var wins over the key file — that is what makes one image run everywhere', async () => {
    const root = await appRoot({ keyFile: OTHER_KEY });
    const found = findMasterKey(root, { [SECRETS_KEY_ENV]: KEY });
    expect(found?.source).toBe('env');
    expect(found?.hex).toBe(KEY);
    expect(found?.at).toBe(SECRETS_KEY_ENV);
  });

  test('the key file answers when the env var is unset', async () => {
    const root = await appRoot({ keyFile: KEY });
    const found = findMasterKey(root, {});
    expect(found?.source).toBe('file');
    expect(found?.hex).toBe(KEY);
    expect(found?.at).toBe(masterKeyPath(root));
  });

  test('an empty env var is not a key — an unset variable often arrives as ""', async () => {
    const root = await appRoot({ keyFile: KEY });
    expect(findMasterKey(root, { [SECRETS_KEY_ENV]: '   ' })?.source).toBe('file');
  });

  test('no key anywhere is X_SECRETS_KEY_MISSING, naming both places it looked', async () => {
    const root = await appRoot();
    expect(findMasterKey(root, {})).toBeUndefined();
    expect(() => requireMasterKey(root, {})).toThrow(/X_SECRETS_KEY_MISSING/);
    expect(() => requireMasterKey(root, {})).toThrow(new RegExp(SECRETS_KEY_ENV));
  });

  test('the key file is written 0600 — a world-readable key is a leaked key', async () => {
    const root = await appRoot({ keyFile: KEY });
    const mode = (await stat(masterKeyPath(root))).mode & 0o777;
    expect(mode).toBe(SECRETS_KEY_MODE);
  });
});

describe('unit · reading and writing the file', () => {
  test('a round trip through the two files preserves the values', async () => {
    const root = await appRoot({ keyFile: KEY });
    const key = requireMasterKey(root, {});
    await writeSecretsFile(root, { SESSION_SECRET: 's3cr3t' }, key);
    expect(secretsFileExists(root)).toBe(true);
    expect(await readSecretsFile(root, key)).toEqual({ SESSION_SECRET: 's3cr3t' });
  });

  test('the committed file never holds a value in the clear', async () => {
    const root = await appRoot({ keyFile: KEY });
    await writeSecretsFile(root, { SESSION_SECRET: 's3cr3t' }, requireMasterKey(root, {}));
    expect(await Bun.file(secretsPath(root)).text()).not.toContain('s3cr3t');
  });

  test('no file at all is X_SECRETS_FILE_MISSING, never an empty map', async () => {
    const root = await appRoot({ keyFile: KEY });
    const key = requireMasterKey(root, {});
    expect(secretsFileExists(root)).toBe(false);
    await expect(readSecretsFile(root, key)).rejects.toBeUltimateError('X_SECRETS_FILE_MISSING');
  });

  test('the wrong key on a real file is X_SECRETS_KEY_MISMATCH, with the file path in it', async () => {
    const root = await appRoot({ values: { SESSION_SECRET: 's3cr3t' }, keyFile: OTHER_KEY });
    await expect(readSecretsFile(root, requireMasterKey(root, {}))).rejects.toBeUltimateError(
      'X_SECRETS_KEY_MISMATCH',
    );
    await expect(readSecretsFile(root, requireMasterKey(root, {}))).rejects.toThrow(
      new RegExp(SECRETS_FILE),
    );
  });
});

describe('unit · installSecrets is the one path to defineEnv', () => {
  test('a decrypted value becomes the env var of the same name', async () => {
    const root = await appRoot({ values: { SESSION_SECRET: 's3cr3t' }, keyFile: KEY });
    const env: Record<string, string | undefined> = {};
    const report = await installSecrets({ root, env });
    expect(report.present).toBe(true);
    expect(report.installed).toEqual(['SESSION_SECRET']);
    expect(env['SESSION_SECRET']).toBe('s3cr3t');
  });

  test('defineEnv reads it back with no second declaration and no second reader', async () => {
    const root = await appRoot({ values: { SESSION_SECRET: 's3cr3t' }, keyFile: KEY });
    const env: Record<string, string | undefined> = { ROLE: 'web' };
    await installSecrets({ root, env });
    const schema = {
      SESSION_SECRET: { type: 'string', secret: true },
    } as const satisfies EnvSchema;
    expect(defineEnv(schema, { env, redact: false }).SESSION_SECRET).toBe('s3cr3t');
  });

  // The whole reason a platform can override a committed value: same image, different deploy.
  test('the real environment wins — a committed value never overwrites an injected one', async () => {
    const root = await appRoot({ values: { SESSION_SECRET: 'from-file' }, keyFile: KEY });
    const env: Record<string, string | undefined> = { SESSION_SECRET: 'from-platform' };
    const report = await installSecrets({ root, env });
    expect(env['SESSION_SECRET']).toBe('from-platform');
    expect(report.skipped).toEqual(['SESSION_SECRET']);
    expect(report.installed).toEqual([]);
  });

  test('an empty env var is treated as unset, so the file fills it', async () => {
    const root = await appRoot({ values: { SESSION_SECRET: 'from-file' }, keyFile: KEY });
    const env: Record<string, string | undefined> = { SESSION_SECRET: '' };
    await installSecrets({ root, env });
    expect(env['SESSION_SECRET']).toBe('from-file');
  });

  test('no secrets file is not an error — an app may declare none', async () => {
    const root = await appRoot({ keyFile: KEY });
    const report = await installSecrets({ root, env: {} });
    expect(report.present).toBe(false);
    expect(report.installed).toEqual([]);
    expect(report.keyId).toBeUndefined();
  });

  // Booting past this produces an app that authenticates against nothing and reports itself
  // healthy — the one failure a rolling deploy cannot see.
  test('a file with no key to open it is fatal, not a silent skip', async () => {
    const root = await appRoot({ values: { SESSION_SECRET: 's3cr3t' } });
    await expect(installSecrets({ root, env: {} })).rejects.toBeUltimateError(
      'X_SECRETS_KEY_MISSING',
    );
  });

  test('the report carries names and a key id, and no value anywhere in it', async () => {
    const root = await appRoot({ values: { SESSION_SECRET: 's3cr3t' }, keyFile: KEY });
    const report = await installSecrets({ root, env: {} });
    expect(report.keySource).toBe('file');
    expect(report.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(report)).not.toContain('s3cr3t');
    expect(JSON.stringify(report)).not.toContain(KEY);
  });
});
