// `x test`'s argument surface, end to end through `testCommand.run`: every invocation it refuses
// before a process starts, and the files a surviving invocation actually selects from a real tree.
// The fake runner is the point — a real `bun test` here would be testing Bun, not this command.

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
import { discoverTests } from './test-select';
import { filesIn } from './test-shards';
import { defaultWorkers, WORKER_CEILING, WORKER_FLOOR } from './test-workers';
import type { TestType } from './verify-tests';
import { SERIAL_TYPES, TEST_TYPES } from './verify-tests';

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

describe('unit · x test discovery', () => {
  test('it finds the test files next to it and sizes every one of them', async () => {
    const files = await discoverTests(import.meta.dir);
    expect(files.map((file) => file.path)).toContain('cmd-test.test.ts');
    expect(files.every((file) => file.bytes > 0)).toBe(true);
    expect(files.every((file) => !file.path.includes('node_modules'))).toBe(true);
    expect(files.every((file) => !file.path.includes('/dist/'))).toBe(true);
  });

  // `x test` and `bun run test` must see one suite. An e2e file dropped here is a file that only
  // ever runs in CI, which is how `packages/http/e2e` stayed broken for as long as it did.
  test('an opt-in e2e suite is discovered, not silently dropped', async () => {
    const files = await discoverTests(join(import.meta.dir, '..', '..', 'http'));
    expect(files.map((file) => file.path)).toContain('e2e/server.e2e.test.ts');
  });

  test('a filter narrows the set to matching paths', async () => {
    const files = await discoverTests(import.meta.dir, 'cmd-test');
    expect(files.map((file) => file.path)).toEqual(['cmd-test.test.ts']);
  });
});

describe('unit · x test type selection', () => {
  const TYPE_FILES: Readonly<Record<TestType, string>> = {
    unit: 'plain.test.ts',
    contract: 'thing.contract.test.ts',
    live: 'thing.live.test.ts',
    job: 'thing.job.test.ts',
    e2e: 'thing.e2e.test.ts',
    eval: 'thing.eval.test.ts',
  };

  test('each of the six types selects exactly its own files, and no other type’s', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-x-test-types-'));
    try {
      for (const path of Object.values(TYPE_FILES)) {
        await Bun.write(join(root, path), 'export {};\n');
      }
      // e2e's directory form: unit must exclude this too, not just the *.e2e.test.ts suffix.
      await Bun.write(join(root, 'e2e/nested.test.ts'), 'export {};\n');

      for (const type of TEST_TYPES) {
        const selected = (await discoverTests(root, undefined, type))
          .map((file) => file.path)
          .sort();
        const expected =
          type === 'e2e' ? ['e2e/nested.test.ts', 'thing.e2e.test.ts'] : [TYPE_FILES[type]];
        expect(selected).toEqual(expected);
      }

      // No positional still runs everything — today's whole-suite behaviour, unchanged.
      const everything = await discoverTests(root);
      expect(everything.length).toBe(Object.keys(TYPE_FILES).length + 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('--filter composes with type: it narrows within the selected type only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-x-test-filter-'));
    try {
      await Bun.write(join(root, 'cache.contract.test.ts'), 'export {};\n');
      await Bun.write(join(root, 'other.contract.test.ts'), 'export {};\n');
      await Bun.write(join(root, 'cache.live.test.ts'), 'export {};\n');
      const selected = await discoverTests(root, 'cache', 'contract');
      expect(selected.map((file) => file.path)).toEqual(['cache.contract.test.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('x test contrat is refused before any discovery, suggesting the real type', async () => {
    const { runner, calls } = recorder();
    await expect(
      testCommand.run(context(['test', 'contrat'], import.meta.dir, runner)),
    ).rejects.toMatchObject({ code: 'X_CLI_BAD_FLAG', fix: 'x test contract' });
    expect(calls.length).toBe(0);
  });

  test('a type + filter combination that matches nothing throws X_TEST_NO_FILES', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-x-test-nofiles-'));
    try {
      await Bun.write(join(root, 'thing.contract.test.ts'), 'export {};\n');
      const { runner, calls } = recorder();
      await expect(
        testCommand.run(context(['test', 'contract', '--filter', 'nope'], root, runner)),
      ).rejects.toMatchObject({ code: 'X_TEST_NO_FILES' });
      expect(calls.length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the spec lists --filter and --sample, so `x help test` cannot lie about them', () => {
    const names = (testCommand.spec.flags ?? []).map((flag) => flag.name);
    expect(names).toContain('filter');
    expect(names).toContain('sample');
    expect(testCommand.spec.usage).toContain('--sample');
  });
});

describe('unit · x test --workers is bounded by the ceiling it documents', () => {
  // The bug this guards: the summary said "max 8" and the reader passed no `max` at all, so
  // `--workers 5000` was accepted and `planShards` clamped only to the file count — 842 concurrent
  // Bun processes over this repo, each with the framework module graph and its own database.
  test('a width above WORKER_CEILING is refused before a single process starts', async () => {
    const { runner, calls } = recorder();
    await expect(
      testCommand.run(
        context(['test', '--workers', String(WORKER_CEILING + 1)], import.meta.dir, runner),
      ),
    ).rejects.toMatchObject({ code: 'X_CLI_BAD_FLAG', fix: 'x test --workers 1' });
    expect(calls.length).toBe(0);
  });

  test('the ceiling itself is accepted — the bound is inclusive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-x-test-ceiling-'));
    try {
      await Bun.write(join(root, 'a.test.ts'), 'export {};\n');
      const { runner, calls } = recorder();
      await testCommand.run(context(['test', '--workers', String(WORKER_CEILING)], root, runner));
      expect(calls.length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // `x help test` derives from the spec, so a summary naming a default the code measured and
  // REJECTED (`test-workers.ts`: `cpus - 1` is slower than not sharding at all) sends an agent to
  // a number no run ever uses.
  test('the summary names the default the code actually computes', () => {
    const summary = (testCommand.spec.flags ?? []).find((flag) => flag.name === 'workers')?.summary;
    expect(summary).not.toContain('CPUs - 1');
    expect(summary).toContain(`max ${WORKER_CEILING}`);
    expect(defaultWorkers(4)).toBe(6);
    expect(defaultWorkers(1)).toBe(WORKER_FLOOR);
    expect(defaultWorkers(64)).toBe(WORKER_CEILING);
  });
});

describe('unit · x test extra positionals', () => {
  // `x test contract live` used to run contract and drop `live` in silence: a caller reading
  // "contract passed" believed both suites had run. Nothing may spawn before this is refused.
  test('a second positional is refused, and the fix moves it to --filter', async () => {
    const { runner, calls } = recorder();
    await expect(
      testCommand.run(context(['test', 'contract', 'live'], import.meta.dir, runner)),
    ).rejects.toMatchObject({
      code: 'X_CLI_BAD_FLAG',
      fix: 'x test contract --filter live',
    });
    expect(calls.length).toBe(0);
  });

  test('the refusal comes before the type is validated, and quotes what it hands back', async () => {
    const { runner, calls } = recorder();
    await expect(
      testCommand.run(context(['test', 'nonsense', 'two words'], import.meta.dir, runner)),
    ).rejects.toMatchObject({
      code: 'X_CLI_BAD_FLAG',
      fix: "x test unit --filter 'two words'",
    });
    expect(calls.length).toBe(0);
  });
});

describe('unit · x test --sample', () => {
  test('--sample 2 runs exactly 2 files, the same two on a repeat run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-x-test-sample-'));
    try {
      for (let i = 0; i < 5; i += 1) {
        await Bun.write(join(root, `f${i}.test.ts`), `${'x'.repeat(i * 10)}\nexport {};\n`);
      }
      const first = recorder();
      const resultA = await testCommand.run(
        context(['test', '--sample', '2', '--workers', '1'], root, first.runner),
      );
      const second = recorder();
      const resultB = await testCommand.run(
        context(['test', '--sample', '2', '--workers', '1'], root, second.runner),
      );
      expect(filesRun(first.calls)).toEqual(filesRun(second.calls));
      expect(filesRun(first.calls).length).toBe(2);
      expect(resultA.data).toMatchObject({ sample: { kept: 2, total: 5 } });
      expect(resultB.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the reproduction carries --sample, so a rerun selects the same corpus', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-x-test-sample-repro-'));
    try {
      for (let i = 0; i < 5; i += 1) {
        await Bun.write(join(root, `f${i}.test.ts`), `${'x'.repeat(i * 10)}\nexport {};\n`);
      }
      const result = await testCommand.run(
        context(['test', '--sample', '3', '--workers', '2'], root, recorder().runner),
      );
      // One run, so one reproduction — and it must name the sample rather than the whole tree,
      // which is the input a rerun most easily drops.
      expect((result.data as { readonly reproduce: string }).reproduce).toBe(
        'x test --sample 3 --workers 2',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('--sample 0 and --sample abc are refused, never silently coerced', async () => {
    await expect(
      testCommand.run(context(['test', '--sample', '0'], import.meta.dir, recorder().runner)),
    ).rejects.toMatchObject({ code: 'X_CLI_BAD_FLAG' });
    await expect(
      testCommand.run(context(['test', '--sample', 'abc'], import.meta.dir, recorder().runner)),
    ).rejects.toMatchObject({ code: 'X_CLI_BAD_FLAG' });
  });
});

describe('unit · x test --worker names a shard that exists', () => {
  // The shard index is a position in a split the command computed, not a free integer: asking for
  // shard 2 of a 2-worker split runs nothing and reports green, which is the one outcome a shard
  // reproduction must never produce.
  test('a shard past the end of the split is refused before anything runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-x-test-shard-'));
    try {
      for (let i = 0; i < 4; i += 1) await Bun.write(join(root, `f${i}.test.ts`), 'export {};\n');
      const { calls, runner } = recorder();
      const thrown: unknown = await testCommand
        .run(context(['test', '--workers', '2', '--worker', '2'], root, runner))
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect((thrown as { code?: string }).code).toBe('X_CLI_BAD_FLAG');
      expect((thrown as { cause?: string }).cause).toBe(
        '--worker on "x test": shard 2 does not exist in a 2-worker split (0..1)',
      );
      expect(calls).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the last shard of the split is accepted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-x-test-shard-'));
    try {
      for (let i = 0; i < 4; i += 1) await Bun.write(join(root, `f${i}.test.ts`), 'export {};\n');
      const { calls, runner } = recorder();
      const result = await testCommand.run(
        context(['test', '--workers', '2', '--worker', '1'], root, runner),
      );
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // The clamp is what makes this reachable: 2 files can only be a 2-worker split, so `--workers 8
  // --worker 3` is out of range for a reason the caller cannot see from their own flags.
  test('the split is clamped to the file count, and the refusal names the clamped width', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-x-test-shard-'));
    try {
      for (let i = 0; i < 2; i += 1) await Bun.write(join(root, `f${i}.test.ts`), 'export {};\n');
      const thrown: unknown = await testCommand
        .run(context(['test', '--workers', '8', '--worker', '3'], root, recorder().runner))
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect((thrown as { cause?: string }).cause).toContain('in a 2-worker split (0..1)');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // `x verify` routes `live` and `e2e` through `runSerial`; this command read no such list, so the
  // same files ran one process under the gate and eight under the command a human types. What is
  // at stake is not tidiness: a logical replication slot is named at the Postgres CLUSTER level,
  // so a per-worker database does not isolate it, and PGlite hides that until a real
  // `TEST_DATABASE_URL` is set. `--parallel=N` is the whole width, so N must be 1 here.
  test.each([...SERIAL_TYPES])('x test %s never widens past one worker', async (type) => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-x-test-serial-'));
    try {
      for (let i = 0; i < 4; i += 1) {
        await Bun.write(join(root, `f${i}.${type}.test.ts`), 'export {};\n');
      }
      const { calls, runner } = recorder();
      const result = await testCommand.run(context(['test', type, '--workers', '8'], root, runner));
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('--parallel=1');
      expect(result.summary).toContain('1 worker(s)');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

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
