// `x clean` end to end through `cleanCommand.run`: every test leftover the framework knows of, on
// demand (#738) — `--dry-run` names them and removes nothing; the developer's own state stays.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, no existence check for a directory and no recursive remove.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { cleanCommand } from './cmd-clean';
import type { CommandContext } from './command';
import type { ExecResult } from './exec';
import type { JsonValue } from './output';
import { parseArgs } from './parse';

const scratch = mkdtempSync(join(tmpdir(), 'x-cmd-clean-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const runner = async (command: readonly string[]): Promise<ExecResult> => ({
  command,
  ok: true,
  code: 0,
  stdout: '',
  stderr: '',
  durationMs: 0,
});

const context = (argv: readonly string[], cwd: string): CommandContext =>
  ({
    args: parseArgs([...argv], [cleanCommand.spec]),
    cwd,
    runner,
    env: {},
    bunVersion: REQUIRED_BUN,
  }) as CommandContext;

function put(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x');
}

function app(name: string): string {
  const root = join(scratch, name);
  put(join(root, 'app.config.ts'));
  put(join(root, '.x', 'test-db', 'pglite-aaaaaaaaaaaaaaaa.tar'));
  put(join(root, '.x', 'test-db', 'pglite-bbbbbbbbbbbbbbbb.tar'));
  put(join(root, '.x', 'cache', 'sass', 'entry.json'));
  put(join(root, '.x', 'pgdata', 'PG_VERSION'));
  put(join(root, '.x', 'storage', 'upload.bin'));
  put(join(root, 'apps', 'web', 'app', '.x', 'cache', 'sass', 'entry.json'));
  return root;
}

const data = (value: JsonValue | undefined): Record<string, JsonValue> =>
  (value ?? {}) as Record<string, JsonValue>;

describe('x clean', () => {
  test('removes the templates, the cache and the stray .x; the dev database and storage stay', async () => {
    const root = app('clean');
    // From a source folder: the app root is found, as for every `x` command.
    const result = await cleanCommand.run(context(['clean'], join(root, 'apps', 'web')));
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, '.x', 'test-db', 'pglite-aaaaaaaaaaaaaaaa.tar'))).toBe(false);
    expect(existsSync(join(root, '.x', 'cache'))).toBe(false);
    expect(existsSync(join(root, 'apps', 'web', 'app', '.x'))).toBe(false);
    expect(existsSync(join(root, '.x', 'pgdata', 'PG_VERSION'))).toBe(true);
    expect(existsSync(join(root, '.x', 'storage', 'upload.bin'))).toBe(true);
    expect(data(result.data)['dryRun']).toBe(false);
    expect((data(result.data)['paths'] as JsonValue[]).length).toBe(4);
  });

  test('--dry-run names the same paths and removes nothing', async () => {
    const root = app('dry');
    const result = await cleanCommand.run(context(['clean', '--dry-run'], root));
    expect(result.ok).toBe(true);
    expect(data(result.data)['dryRun']).toBe(true);
    expect((data(result.data)['paths'] as JsonValue[]).length).toBe(4);
    expect(existsSync(join(root, '.x', 'test-db', 'pglite-aaaaaaaaaaaaaaaa.tar'))).toBe(true);
    expect(existsSync(join(root, 'apps', 'web', 'app', '.x'))).toBe(true);
  });

  test('a clean app is a green no-op', async () => {
    const root = join(scratch, 'empty');
    put(join(root, 'app.config.ts'));
    const result = await cleanCommand.run(context(['clean'], root));
    expect(result.ok).toBe(true);
    expect(data(result.data)['paths']).toEqual([]);
  });
});
