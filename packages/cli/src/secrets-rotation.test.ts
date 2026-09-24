// Row r: `x secrets rotate` sealed `secrets.enc.json` with the new key BEFORE the key file existed,
// so a crash between the two writes left a committed file no key on disk could open — every secret
// gone. The new key is now staged beside the old one first, and a later command finishes the move.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  generateMasterKey,
  masterKeyPath,
  SECRETS_KEY_FILE,
  stagedMasterKeyPath,
  writeSecretsFile,
} from '@ultimat3/core';
import { REQUIRED_BUN } from './app-root';
import { secretsCommand } from './cmd-secrets';
import type { CommandContext } from './command';
import { parseArgs } from './parse';
import { recoverRotation } from './secrets-rotation';

let base = '';
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'x-secrets-rotation-'));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const context = (argv: readonly string[], cwd: string): CommandContext =>
  ({
    args: parseArgs([...argv], [secretsCommand.spec]),
    cwd,
    runner: async (command) => ({
      command,
      code: 0,
      ok: true,
      stdout: '',
      stderr: '',
      durationMs: 0,
    }),
    env: {},
    bunVersion: REQUIRED_BUN,
  }) as CommandContext;

const keyOf = async (root: string): Promise<string> =>
  (await Bun.file(join(root, SECRETS_KEY_FILE)).text()).trim();

async function initialized(name: string): Promise<string> {
  const root = join(base, name);
  await Bun.write(join(root, 'app.config.ts'), 'export default {};\n');
  await secretsCommand.run(context(['secrets', 'init'], root));
  return root;
}

describe('unit · a rotation interrupted between its two writes loses nothing', () => {
  test('rotate leaves no staged key behind when it completes', async () => {
    const root = await initialized('complete');
    await secretsCommand.run(context(['secrets', 'rotate'], root));
    expect(await Bun.file(stagedMasterKeyPath(root)).exists()).toBe(false);
  });

  test('sealed with the staged key, crashed before the rename: the next command finishes it', async () => {
    const root = await initialized('crashed');
    const staged = generateMasterKey();
    await Bun.write(stagedMasterKeyPath(root), `${staged}\n`);
    await writeSecretsFile(root, {}, { hex: staged, source: 'file', at: masterKeyPath(root) });

    const shown = await secretsCommand.run(context(['secrets', 'show'], root));

    expect(shown.ok).toBe(true);
    expect(await keyOf(root)).toBe(staged);
    expect(await Bun.file(stagedMasterKeyPath(root)).exists()).toBe(false);
  });

  test('crashed before sealing: the old key still opens the file and the staged one is dropped', async () => {
    const root = await initialized('early');
    const before = await keyOf(root);
    await Bun.write(stagedMasterKeyPath(root), `${generateMasterKey()}\n`);

    const key = await recoverRotation(root, {
      hex: before,
      source: 'file',
      at: masterKeyPath(root),
    });

    expect(key.hex).toBe(before);
    expect(await keyOf(root)).toBe(before);
    expect(await Bun.file(stagedMasterKeyPath(root)).exists()).toBe(false);
  });
});
