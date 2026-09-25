// `x test --filter a,b` and `x test --allow-empty`: the two selection knobs an app's scoped runner
// needs to hand `x test` every affected slice in ONE process — and to say "nothing here yet"
// without a red build. Its own file because `cmd-test.test.ts` is at the line ceiling.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive: `mkdtemp`/`rm` own the throwaway tree, `tmpdir`
// says where, and `join` is the host-separator path into it.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { testCommand } from './cmd-test';
import type { CommandContext } from './command';
import type { Runner } from './exec';
import { parseArgs } from './parse';
import { discoverTests, readFilters } from './test-select';
import { filesIn } from './test-shards';
import { thrownBy } from './thrown-by';

let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ultimate-x-test-filters-'));
  for (const path of ['billing/a.test.ts', 'case/b.test.ts', 'org/c.test.ts']) {
    await Bun.write(join(root, path), 'export {};\n');
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const run = async (argv: readonly string[]) => {
  const calls: (readonly string[])[] = [];
  const runner: Runner = async (command) => {
    calls.push(command);
    return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 1 };
  };
  const ctx: CommandContext = {
    args: parseArgs(argv, [testCommand.spec]),
    cwd: root,
    runner,
    env: {},
    bunVersion: REQUIRED_BUN,
  };
  const result = await testCommand.run(ctx);
  return { result, files: calls.flatMap((command) => filesIn(command)).sort(), calls };
};

describe('unit · x test --filter takes a list', () => {
  test('a comma-separated list keeps a path matching ANY item, in one run', async () => {
    const { files, calls } = await run(['test', '--filter', 'billing/,case/']);
    expect(files).toEqual(['billing/a.test.ts', 'case/b.test.ts']);
    expect(calls.length).toBe(1);
  });

  test('one substring behaves exactly as before', async () => {
    expect((await run(['test', '--filter', 'org/'])).files).toEqual(['org/c.test.ts']);
    expect((await discoverTests(root, 'org/')).map((file) => file.path)).toEqual(['org/c.test.ts']);
  });

  test('an empty item is refused, because "" matches every path and would widen the run', () => {
    const failure = thrownBy(() => readFilters('billing/,,case/'));
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.fix).toBe('x test --filter billing/,case/');
    expect(thrownBy(() => readFilters(',')).fix).toBe('x test --json');
    expect(readFilters(' billing/ , case/ ')).toEqual(['billing/', 'case/']);
  });
});

describe('unit · x test --allow-empty', () => {
  test('without it, a selection matching nothing is still X_TEST_NO_FILES', async () => {
    await expect(run(['test', '--filter', 'nope/'])).rejects.toMatchObject({
      code: 'X_TEST_NO_FILES',
    });
  });

  test('with it, the same selection is green, spawns nothing, and says what matched nothing', async () => {
    const { result, calls } = await run(['test', '--filter', 'nope/,gone/', '--allow-empty']);
    expect(calls.length).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('"nope/,gone/"');
    expect(result.summary).toContain('0 test file(s) ran');
    expect(result.data).toEqual({ filter: 'nope/,gone/', files: 0, empty: true });
  });

  test('it changes nothing when the selection matches', async () => {
    const { files } = await run(['test', '--filter', 'case/', '--allow-empty']);
    expect(files).toEqual(['case/b.test.ts']);
  });
});
