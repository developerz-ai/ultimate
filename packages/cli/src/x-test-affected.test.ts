// `x test --affected` over a throwaway monorepo and a recorded git: only the test files a diff can
// break run. Split from cmd-test.test.ts, which keeps selection, width and the sample.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive: `mkdtemp`/`rm` build and remove the throwaway trees
// these tests discover over, `tmpdir` says where, and `join` is the host-separator path into them.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { testCommand } from './cmd-test';
import type { CommandContext } from './command';
import type { Runner } from './exec';
import { parseArgs } from './parse';
import { filesIn } from './test-shards';

interface Recorder {
  readonly calls: readonly (readonly string[])[];
  readonly runner: Runner;
}

/** The exec seam, faked: a refused invocation is proved by an empty `calls`, not by a green run. */
const recorder = (): Recorder => {
  const calls: (readonly string[])[] = [];
  const runner: Runner = async (command) => {
    calls.push(command);
    return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 7 };
  };
  return { calls, runner };
};

/** A `CommandContext` for `testCommand.run`, scoped to just this command's own spec — never the
 *  full registry, so these tests do not depend on another worker's in-progress `registry.ts`. */
const context = (argv: readonly string[], cwd: string, runner: Runner): CommandContext => ({
  args: parseArgs(argv, [testCommand.spec]),
  cwd,
  runner,
  env: {},
  bunVersion: REQUIRED_BUN,
});

const filesRun = (calls: readonly (readonly string[])[]): readonly string[] =>
  [...calls.flatMap((command) => filesIn(command))].sort();

/**
 * `--affected`, driven through the same fake-runner seam as everything above: git is answered from
 * a table and `bun test` is recorded, so the verdict never depends on this checkout's own history
 * — which matters more here than anywhere else, because several agents share it.
 */
const gitRecorder = (
  replies: Readonly<Record<string, string>>,
): { readonly shards: readonly (readonly string[])[]; readonly runner: Runner } => {
  const shards: (readonly string[])[] = [];
  const runner: Runner = async (command) => {
    if (command[0] !== 'git') {
      shards.push(command);
      return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 3 };
    }
    const stdout = replies[command.join(' ')];
    const ok = stdout !== undefined;
    return { command, code: ok ? 0 : 1, ok, stdout: stdout ?? '', stderr: '', durationMs: 1 };
  };
  return { shards, runner };
};

/** `@t/a` → `@t/b`, one test file each, plus an unrelated `@t/z`. */
async function affectedRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ultimate-x-test-affected-'));
  const write = (path: string, body: unknown): Promise<number> =>
    Bun.write(join(root, path), JSON.stringify(body));
  await write('package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
  for (const [name, deps] of [
    ['a', { '@t/b': 'workspace:*' }],
    ['b', {}],
    ['z', {}],
  ] as const) {
    await write(`packages/${name}/package.json`, { name: `@t/${name}`, dependencies: deps });
    await Bun.write(join(root, `packages/${name}/src/thing.test.ts`), 'export {};\n');
  }
  return root;
}

const TOPLEVEL = 'git rev-parse --show-toplevel';
const VERIFY = 'git rev-parse --verify --quiet main^{commit}';
const DIFF = 'git diff --name-only -z main...HEAD';

const gitReplies = (root: string, diff: string): Readonly<Record<string, string>> => ({
  [TOPLEVEL]: `${root}\n`,
  [VERIFY]: 'abc\n',
  [DIFF]: diff,
});

interface TestAffectedData {
  readonly files?: number;
  readonly affected?: Readonly<Record<string, unknown>>;
}

/** One throwaway monorepo per case, removed however the case ends. */
async function withRepo(run: (root: string) => Promise<void>): Promise<void> {
  const root = await affectedRepo();
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('unit · x test --affected', () => {
  test('a change in a dependency runs its dependents too, and nothing else', async () => {
    await withRepo(async (root) => {
      const { runner, shards } = gitRecorder(gitReplies(root, 'packages/b/src/thing.ts\0'));
      const result = await testCommand.run(
        context(['test', '--affected', '--workers', '1'], root, runner),
      );
      expect(result.ok).toBe(true);
      // `@t/a` is two files away from the edit and must still run; `@t/z` is discovered and then
      // dropped, and must never be spawned nor be a reason the run is called complete.
      expect(filesRun(shards)).toEqual([
        'packages/a/src/thing.test.ts',
        'packages/b/src/thing.test.ts',
      ]);
    });
  });

  test('the run reports the diff it narrowed to, so --json can tell it from a full run', async () => {
    await withRepo(async (root) => {
      const { runner } = gitRecorder(gitReplies(root, 'packages/z/src/thing.ts\0'));
      const result = await testCommand.run(
        context(['test', '--affected', '--workers', '1'], root, runner),
      );
      expect((result.data as TestAffectedData).affected).toEqual({
        base: 'main',
        dirty: false,
        changed: 1,
        workspaces: ['packages/z'],
      });
    });
  });

  // A doc re-checks nothing, so this is green — but it must spawn NOTHING. An empty file list
  // reaching `runShards` is `bun test --isolate` with no arguments, which runs the whole suite.
  test('a doc-only diff runs no process at all and still exits ok', async () => {
    await withRepo(async (root) => {
      const { runner, shards } = gitRecorder(gitReplies(root, 'docs/plan.md\0'));
      const result = await testCommand.run(context(['test', '--affected'], root, runner));
      expect(result.ok).toBe(true);
      expect(shards).toEqual([]);
      expect(result.data as TestAffectedData).toMatchObject({
        files: 0,
        affected: { base: 'main', changed: 1, workspaces: [] },
      });
    });
  });

  test('--base and --dirty are refused without --affected, before anything is spawned', async () => {
    const { runner, calls } = recorder();
    await expect(
      testCommand.run(context(['test', '--base', 'main'], import.meta.dir, runner)),
    ).rejects.toMatchObject({ code: 'X_CLI_BAD_FLAG', fix: 'x test --affected --base main' });
    await expect(
      testCommand.run(context(['test', '--dirty'], import.meta.dir, runner)),
    ).rejects.toMatchObject({ code: 'X_CLI_BAD_FLAG', fix: 'x test --affected --dirty' });
    expect(calls).toEqual([]);
  });

  test('the spec declares the three flags, so `x help test` cannot lie about them', () => {
    const names = (testCommand.spec.flags ?? []).map((flag) => flag.name);
    expect(names).toContain('affected');
    expect(names).toContain('base');
    expect(names).toContain('dirty');
    expect(testCommand.spec.usage).toContain('--affected');
  });
});
