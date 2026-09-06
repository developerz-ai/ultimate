// What one `x test` invocation becomes: how many `bun test` runs, at what width, and what tail
// each carries. Split from `cmd-test.test.ts`, which is the ARGUMENT surface — a refusal there
// happens before a process starts, and everything here is about the processes that do.

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
import { testPasses } from './test-passes';
import type { TestFile } from './test-select';
import { filesIn } from './test-shards';
import { SERIAL_TYPES } from './verify-tests';

interface Recorder {
  readonly calls: readonly (readonly string[])[];
  readonly runner: Runner;
}

/** The exec seam, faked: what the command SPAWNED is the whole subject of this file. */
const recorder = (): Recorder => {
  const calls: (readonly string[])[] = [];
  const runner: Runner = async (command) => {
    calls.push(command);
    return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 7 };
  };
  return { calls, runner };
};

/** Scoped to this command's own spec, never the full registry — `cmd-test.test.ts`'s reason. */
const context = (argv: readonly string[], cwd: string, runner: Runner): CommandContext => ({
  args: parseArgs(argv, [testCommand.spec]),
  cwd,
  runner,
  env: {},
  bunVersion: REQUIRED_BUN,
});

const filesRun = (calls: readonly (readonly string[])[]): readonly string[] =>
  [...calls.flatMap((command) => filesIn(command))].sort();

const file = (path: string): TestFile => ({ path, bytes: 10 });

const pathsOf = (files: readonly TestFile[]): readonly string[] => files.map((entry) => entry.path);

describe('unit · a selection becomes one pass, or one per serial type', () => {
  test('a selection with nothing serial in it is one pass at the asked width', () => {
    const passes = testPasses({
      files: [file('a.test.ts'), file('b.contract.test.ts')],
      workers: 4,
    });
    expect(passes).toHaveLength(1);
    expect(passes[0]?.workers).toBe(2); // clamped to the file count, as the run always was
  });

  test('each serial type is its own one-worker pass, named so its failure reproduces', () => {
    const passes = testPasses({
      files: [file('a.test.ts'), file('feed.live.test.ts'), file('checkout.e2e.test.ts')],
      workers: 8,
    });
    expect(passes.map((pass) => pass.type)).toEqual([undefined, 'live', 'e2e']);
    expect(passes.map((pass) => pass.workers)).toEqual([1, 1, 1]);
    expect(passes.flatMap((pass) => pathsOf(pass.files)).sort()).toEqual([
      'a.test.ts',
      'checkout.e2e.test.ts',
      'feed.live.test.ts',
    ]);
  });

  test('a selection that is ALL serial is one pass, and it is not widened', () => {
    const passes = testPasses({
      files: [file('a.live.test.ts'), file('b.live.test.ts')],
      workers: 8,
    });
    expect(passes).toHaveLength(1);
    expect(passes[0]?.workers).toBe(1);
  });

  // A `--worker I` rerun is a single `bun test --isolate --shard=i/N` process, so nothing inside it
  // runs beside anything else — and splitting it would make shard i of the rerun a different set
  // of files from shard i of the run it reproduces, which is the one thing a shard must not do.
  test('a shard rerun is left whole, serial files included', () => {
    const files = [file('a.test.ts'), file('feed.live.test.ts')];
    expect(testPasses({ files, workers: 2, shard: 1 })).toHaveLength(1);
  });
});

describe('unit · x test spends those passes, one bun test each', () => {
  // The half a human hits: `x test` with no positional selects EVERY type, so the `--workers`
  // clamp — which only looked at the POSITIONAL — ran `f.live.test.ts` and `f.e2e.test.ts` at
  // `--parallel=8` beside the unit corpus, over the very files `x verify` runs one at a time. A
  // logical replication slot is named at the Postgres CLUSTER level, so a per-worker database does
  // not isolate it, and PGlite hides that until a real `TEST_DATABASE_URL` is set.
  test('a bare run puts the serial files in their own one-worker pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-x-test-mixed-'));
    try {
      for (let i = 0; i < 4; i += 1) await Bun.write(join(root, `f${i}.test.ts`), 'export {};\n');
      await Bun.write(join(root, 'feed.live.test.ts'), 'export {};\n');
      await Bun.write(join(root, 'checkout.e2e.test.ts'), 'export {};\n');
      const { calls, runner } = recorder();

      const result = await testCommand.run(context(['test', '--workers', '4'], root, runner));

      expect(result.ok).toBe(true);
      // Every file still runs, exactly once, whichever pass it belongs to.
      expect(filesRun(calls)).toEqual([
        'checkout.e2e.test.ts',
        'f0.test.ts',
        'f1.test.ts',
        'f2.test.ts',
        'f3.test.ts',
        'feed.live.test.ts',
      ]);
      for (const call of calls) {
        const serial = filesIn(call).some((path) => SERIAL_TYPES.some((t) => path.includes(t)));
        // `--parallel=N` is the whole width of the run, so a serial file may only appear in a
        // call whose width is 1 — and a widened one may hold no serial file at all.
        expect(call).toContain(serial ? '--parallel=1' : '--parallel=4');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // `ParsedArgs.passthrough` is documented as "handed to the underlying tool verbatim" and had no
  // reader in the whole package: both flags below were parsed, carried through the command and
  // dropped, so `x test unit -- --coverage` reported a pass and measured nothing.
  test('everything after -- reaches the spawned argv and the reproduce line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-x-test-tail-'));
    try {
      await Bun.write(join(root, 'a.test.ts'), 'export {};\n');
      const { calls, runner } = recorder();

      const result = await testCommand.run(
        context(['test', '--workers', '1', '--', '--coverage', '--bail'], root, runner),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('--coverage');
      expect(calls[0]).toContain('--bail');
      // Still an explicit file list, and the tail did not become one.
      expect(filesRun(calls)).toEqual(['a.test.ts']);
      expect((result.data as { reproduce: string }).reproduce).toContain('-- --coverage --bail');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
