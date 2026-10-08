// `x vapid` against real files: `create` seals BOTH halves of a real pair in one write and refuses a
// second pair; `show` names the pair the boot would sign with; the private key reaches neither the
// terminal nor `--json`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive: `mkdtemp`/`rm` build and remove the throwaway roots.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { openSecrets, SECRETS_FILE, SECRETS_KEY_FILE } from '@ultimat3/core';
import { assertVapidPair, DEV_VAPID_KEYS } from '@ultimat3/pwa';
import { REQUIRED_BUN } from './app-root';
import { secretsCommand } from './cmd-secrets';
import { vapidCommand } from './cmd-vapid';
import type { CommandContext } from './command';
import type { ExecResult } from './exec';
import type { JsonValue } from './output';
import { parseArgs } from './parse';

let base = '';
let counter = 0;

const runner = async (command: readonly string[]): Promise<ExecResult> => ({
  command,
  ok: true,
  code: 0,
  stdout: '',
  stderr: '',
  durationMs: 0,
});

const context = (
  argv: readonly string[],
  cwd: string,
  env: Record<string, string> = {},
): CommandContext =>
  ({
    args: parseArgs([...argv], [secretsCommand.spec, vapidCommand.spec]),
    cwd,
    runner,
    env,
    bunVersion: REQUIRED_BUN,
  }) as CommandContext;

const record = (value: JsonValue | undefined): Record<string, JsonValue> =>
  (value ?? {}) as Record<string, JsonValue>;

async function initialized(name: string): Promise<string> {
  counter += 1;
  const root = join(base, `${name}-${counter}`);
  await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  await secretsCommand.run(context(['secrets', 'init'], root));
  return root;
}

const sealed = async (root: string): Promise<Record<string, string>> =>
  openSecrets(
    await Bun.file(join(root, SECRETS_FILE)).text(),
    (await Bun.file(join(root, SECRETS_KEY_FILE)).text()).trim(),
    { file: SECRETS_FILE, key: SECRETS_KEY_FILE },
  ) as Promise<Record<string, string>>;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'x-cmd-vapid-'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('unit · x vapid create', () => {
  test('seals a real pair — both halves, one write — and prints only the public key', async () => {
    const root = await initialized('create');
    const result = await vapidCommand.run(context(['vapid', 'create'], root));
    expect(result.ok).toBe(true);
    const values = await sealed(root);
    const pair = {
      publicKey: values['ULTIMATE_VAPID_PUBLIC_KEY'] ?? '',
      privateKey: values['ULTIMATE_VAPID_PRIVATE_KEY'] ?? '',
    };
    await assertVapidPair(pair);
    expect(record(result.data)['publicKey']).toBe(pair.publicKey);
    expect(JSON.stringify(result)).not.toContain(pair.privateKey);
  });

  test('a second create is refused — a new pair unsubscribes every browser', async () => {
    const root = await initialized('twice');
    await vapidCommand.run(context(['vapid', 'create'], root));
    const before = await sealed(root);
    try {
      await vapidCommand.run(context(['vapid', 'create'], root));
      expect.unreachable('a second pair must not replace the first');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('X_GENERATE_CONFLICT');
      expect((error as { fix?: string }).fix).toContain('x secrets edit');
    }
    expect(await sealed(root)).toEqual(before);
  });

  test('with no secrets set up, the refusal names x secrets init', async () => {
    counter += 1;
    const root = join(base, `bare-${counter}`);
    await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
    try {
      await vapidCommand.run(context(['vapid', 'create'], root));
      expect.unreachable('no master key, no seal');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('X_SECRETS_KEY_MISSING');
    }
  });
});

describe('unit · x vapid show', () => {
  test('the bare command reads: sealed pair, then environment, else the development pair', async () => {
    const root = await initialized('show');
    const dev = await vapidCommand.run(context(['vapid'], root));
    expect(record(dev.data)['source']).toBe('development');
    expect(record(dev.data)['publicKey']).toBe(DEV_VAPID_KEYS.publicKey);
    await vapidCommand.run(context(['vapid', 'create'], root));
    const values = await sealed(root);
    const shown = await vapidCommand.run(context(['vapid', 'show'], root));
    expect(record(shown.data)).toEqual({
      source: 'sealed',
      publicKey: values['ULTIMATE_VAPID_PUBLIC_KEY'] ?? '',
      privateKey: true,
    });
    expect(JSON.stringify(shown)).not.toContain(values['ULTIMATE_VAPID_PRIVATE_KEY'] ?? '');
    const env = await vapidCommand.run(
      context(['vapid', 'show'], root, { ULTIMATE_VAPID_PUBLIC_KEY: 'B-from-env' }),
    );
    expect(record(env.data)).toEqual({
      source: 'environment',
      publicKey: 'B-from-env',
      privateKey: false,
    });
  });

  test('a sealed file it cannot open is that refusal — never "the development pair"', async () => {
    const root = await initialized('tampered');
    await vapidCommand.run(context(['vapid', 'create'], root));
    const path = join(root, SECRETS_FILE);
    const text = await Bun.file(path).text();
    // One character of the ciphertext changed: the file is there, and it is not the one sealed.
    const at = text.lastIndexOf('"') - 2;
    await Bun.write(
      path,
      `${text.slice(0, at)}${text[at] === 'A' ? 'B' : 'A'}${text.slice(at + 1)}`,
    );
    let code: string | undefined;
    try {
      await vapidCommand.run(context(['vapid', 'show'], root));
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toStartWith('X_SECRETS_');
    // No secrets set up at all is absence: the development pair, as before.
    const bare = join(base, 'bare-vapid');
    await Bun.write(join(bare, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
    const dev = await vapidCommand.run(context(['vapid'], bare));
    expect(record(dev.data)['source']).toBe('development');
  });
});
