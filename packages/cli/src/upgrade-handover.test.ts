// The risk `overview.md` names: an old app's first `x upgrade` is the newest CLI, run inside an app
// whose own CLI is older and has no such command. The real `bin.ts`, spawned, over a planted app CLI
// that only says who it is — so a hand-over that came back is visible as that CLI's answer.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { exec } from './exec';
import { LOCAL_CLI_BIN } from './local-cli';
import { cliVersion } from './registry';

const BIN = join(import.meta.dir, 'bin.ts');
const CANARY = 'the-app-cli-answered';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const appHolding = async (version: string): Promise<string> => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'x-upgrade-handover-')));
  dirs.push(dir);
  await Bun.write(join(dir, 'app.config.ts'), 'export const config = {};\n');
  await Bun.write(join(dir, 'package.json'), '{ "dependencies": {} }\n');
  await Bun.write(join(dir, LOCAL_CLI_BIN), `console.log(${JSON.stringify(CANARY)});\n`);
  await Bun.write(
    join(dir, 'node_modules/@ultimat3/cli/package.json'),
    JSON.stringify({ name: '@ultimat3/cli', version }),
  );
  return dir;
};

const x = async (cwd: string, ...args: readonly string[]) =>
  exec([process.execPath, BIN, ...args], { cwd });

describe('unit · the newest CLI, run in an app whose own CLI is older', () => {
  test('upgrade stays in the CLI that was invoked and answers from it', async () => {
    const dir = await appHolding('6.0.0');
    const result = await x(dir, 'upgrade', '--json');
    expect(result.stdout).not.toContain(CANARY);
    // The directory is no repository, so its first refusal proves whose code ran: an app CLI below
    // this slice has no such code, only `X_NOT_IMPLEMENTED`.
    expect(JSON.parse(result.stdout).findings[0].code).toBe('X_UPGRADE_DIRTY_TREE');
    expect(result.code).toBe(1);
  });

  test('--cwd decides which app, from anywhere', async () => {
    const dir = await appHolding('6.0.0');
    const result = await x(tmpdir(), 'upgrade', '--json', '--cwd', dir);
    expect(JSON.parse(result.stdout).findings[0].code).toBe('X_UPGRADE_DIRTY_TREE');
  });

  test('every other command still goes to the app CLI: one process, one registry', async () => {
    const dir = await appHolding('6.0.0');
    expect((await x(dir, 'doctor', '--json')).stdout).toContain(CANARY);
  });

  test('an app CLI at this same version answers upgrade itself', async () => {
    const dir = await appHolding(cliVersion());
    expect((await x(dir, 'upgrade', '--json')).stdout).toContain(CANARY);
  });
});

describe('unit · cmd-upgrade.ts survives the install that replaces it', () => {
  test('nothing the command runs after `bun install` is loaded lazily', async () => {
    const files = [
      'cmd-upgrade',
      'upgrade-gate',
      'upgrade-pins',
      'upgrade-plan',
      'upgrade-registry',
    ];
    for (const file of files) {
      const source = await Bun.file(join(import.meta.dir, `${file}.ts`)).text();
      expect(source.replace(/\/\/.*$/gm, '')).not.toMatch(/\bimport\(/);
    }
  });
});
