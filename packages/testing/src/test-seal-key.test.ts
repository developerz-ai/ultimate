// The throwaway seal key: installed for a test process that has no key, and for nothing else. The
// last test is the claim an app cares about — a scaffold-shaped test over a sealed entity, run by
// `bun test` under the app preload with NO key in the environment and no `.secrets.key`, passes.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API; mkdtemp/rm own the fixture directory.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { generateMasterKey, isUltimateError, SECRETS_KEY_ENV } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import * as barrel from './index';
import { installTestSealKey, testSealKeyEnv } from './test-seal-key';

const previousKey = process.env[SECRETS_KEY_ENV];
const scratch: string[] = [];

const tempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'x-seal-key-'));
  scratch.push(dir);
  return dir;
};

afterAll(() => {
  if (previousKey === undefined) delete process.env[SECRETS_KEY_ENV];
  else process.env[SECRETS_KEY_ENV] = previousKey;
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  clearRegistry();
});

describe('unit · the test seal key', () => {
  test('a test process with no key gets one, and it is a key `seal()` accepts', () => {
    const env: Record<string, string | undefined> = { NODE_ENV: 'test' };
    expect(installTestSealKey({ root: tempRoot(), env })).toBe(true);
    expect(env[SECRETS_KEY_ENV]).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic: the same key on every machine, so a lookup column seals to the same string.
    const again: Record<string, string | undefined> = { NODE_ENV: 'test' };
    installTestSealKey({ root: tempRoot(), env: again });
    expect(again[SECRETS_KEY_ENV]).toBe(env[SECRETS_KEY_ENV]);
  });

  test('anything but NODE_ENV=test gets none — a server that imported the preload stays keyless', () => {
    for (const mode of ['production', 'development', '', undefined]) {
      const env: Record<string, string | undefined> = { NODE_ENV: mode };
      expect(installTestSealKey({ root: tempRoot(), env })).toBe(false);
      expect(env[SECRETS_KEY_ENV]).toBeUndefined();
    }
  });

  test("the app's own key wins: the variable, or `.secrets.key` in the root", () => {
    const own = generateMasterKey();
    const env: Record<string, string | undefined> = { NODE_ENV: 'test', [SECRETS_KEY_ENV]: own };
    expect(installTestSealKey({ root: tempRoot(), env })).toBe(false);
    expect(env[SECRETS_KEY_ENV]).toBe(own);

    const root = tempRoot();
    writeFileSync(join(root, '.secrets.key'), `${own}\n`);
    const fromFile: Record<string, string | undefined> = { NODE_ENV: 'test' };
    expect(installTestSealKey({ root, env: fromFile })).toBe(false);
    expect(fromFile[SECRETS_KEY_ENV]).toBeUndefined();
  });

  test('as a value for a spawned app: the one variable, or nothing — and it writes nowhere', () => {
    const env: Record<string, string | undefined> = { NODE_ENV: 'test' };
    const added = testSealKeyEnv({ root: tempRoot(), env });
    expect(Object.keys(added)).toEqual([SECRETS_KEY_ENV]);
    expect(env[SECRETS_KEY_ENV]).toBeUndefined();
    expect(testSealKeyEnv({ root: tempRoot(), env: { NODE_ENV: 'production' } })).toEqual({});
    expect(
      testSealKeyEnv({ root: tempRoot(), env: { NODE_ENV: 'test', [SECRETS_KEY_ENV]: 'a' } }),
    ).toEqual({});
  });

  test('the key is reachable from no export of the package', () => {
    const env: Record<string, string | undefined> = { NODE_ENV: 'test' };
    installTestSealKey({ root: tempRoot(), env });
    const key = env[SECRETS_KEY_ENV];
    // Not the installer, and not the key under any name: the preload is the one way in.
    expect(Object.keys(barrel)).not.toContain('installTestSealKey');
    expect(Object.values(barrel)).not.toContain(key);
    expect(Object.keys(import.meta.require('./test-seal-key'))).toEqual([
      'installTestSealKey',
      'testSealKeyEnv',
    ]);
  });

  test('a sealed write is X_SEAL_KEY_MISSING without it, and round-trips with it', async () => {
    const vault = entity('tsk_vault', {
      columns: { id: uuid().primaryKey(), credential: text().sealed() },
    });
    const table = database({ vault }, { driver: memoryDriver() }).vault;
    delete process.env[SECRETS_KEY_ENV];
    let code = 'resolved';
    try {
      await table.insert({ credential: 's3cret' });
    } catch (error) {
      code = isUltimateError(error) ? error.code : 'uncoded';
    }
    expect(code).toBe('X_SEAL_KEY_MISSING');

    expect(installTestSealKey()).toBe(true);
    const made = await table.insert({ credential: 's3cret' });
    expect(made.credential).toBe('s3cret');
  });
});

describe('unit · the app preload installs it', () => {
  test('a scaffold-shaped test over a sealed entity passes with no key anywhere', async () => {
    const root = tempRoot();
    const repo = join(import.meta.dir, '..', '..', '..');
    writeFileSync(
      join(root, 'bunfig.toml'),
      `[test]\npreload = [${JSON.stringify(join(import.meta.dir, 'preload.ts'))}]\n`,
    );
    writeFileSync(
      join(root, 'vault.test.ts'),
      [
        "import { expect, test } from 'bun:test';",
        `import { database, entity, memoryDriver, text, uuid } from ${JSON.stringify(join(repo, 'packages/entity/src/index.ts'))};`,
        "const vault = entity('vault', { columns: { id: uuid().primaryKey(), credential: text().sealed() } });",
        "test('a sealed column round-trips', async () => {",
        '  const table = database({ vault }, { driver: memoryDriver() }).vault;',
        "  const made = await table.insert({ credential: 's3cret' });",
        "  expect(made.credential).toBe('s3cret');",
        '});',
        '',
      ].join('\n'),
    );
    const { [SECRETS_KEY_ENV]: _key, NODE_ENV: _mode, ...env } = process.env;
    const child = Bun.spawn(['bun', 'test', 'vault.test.ts'], {
      cwd: root,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exit, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(output).toContain('1 pass');
    expect(exit).toBe(0);
  });
});
