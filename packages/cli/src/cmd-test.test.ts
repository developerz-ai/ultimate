import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Shard, TestFile } from './cmd-test';
import {
  discoverTests,
  planShards,
  reproduceFor,
  runShards,
  shardArgs,
  testCommand,
} from './cmd-test';
import type { CommandContext } from './command';
import type { ExecOptions, Runner } from './exec';
import { renderJson } from './output';
import { flagString, parseArgs } from './parse';
import type { TestType } from './verify-tests';
import { TEST_TYPES } from './verify-tests';

interface Call {
  readonly command: readonly string[];
  readonly env: ExecOptions['env'];
  readonly cwd: string;
}

interface Recorder {
  readonly calls: Call[];
  readonly runner: Runner;
}

/** The exec seam, faked: these tests assert on the split and the argv, never on a real process. */
const recorder = (failing: readonly number[] = []): Recorder => {
  const calls: Call[] = [];
  const runner: Runner = async (command, options) => {
    calls.push({ command, env: options.env, cwd: options.cwd });
    const worker = Number.parseInt(options.env?.['ULTIMATE_TEST_WORKER'] ?? '-1', 10);
    const code = failing.includes(worker) ? 1 : 0;
    return { command, code, ok: code === 0, stdout: `worker ${worker}`, stderr: '', durationMs: 7 };
  };
  return { calls, runner };
};

/** Deliberately uneven: a handful of very large files plus a long tail of small ones. */
const corpus = (count: number): readonly TestFile[] =>
  Array.from({ length: count }, (_unused, index) => ({
    path: `packages/p${index % 5}/file-${String(index).padStart(3, '0')}.test.ts`,
    bytes: index % 7 === 0 ? 40_000 - index * 13 : 400 + ((index * 37) % 900),
  }));

const shuffled = (files: readonly TestFile[]): readonly TestFile[] => {
  const out = [...files];
  // Reverse plus a rotation: a fixed permutation, so the test itself stays deterministic.
  return [...out.slice(17), ...out.slice(0, 17)].reverse();
};

const totalBytes = (files: readonly TestFile[]): number =>
  files.reduce((sum, file) => sum + file.bytes, 0);

const paths = (shards: readonly Shard[]): readonly (readonly string[])[] =>
  shards.map((shard) => shard.files);

/** A `CommandContext` for `testCommand.run`, scoped to just this command's own spec — never the
 *  full registry, so these tests do not depend on another worker's in-progress `registry.ts`. */
const context = (argv: readonly string[], cwd: string, runner: Runner): CommandContext => ({
  args: parseArgs(argv, [testCommand.spec]),
  cwd,
  runner,
  env: {},
  bunVersion: '1.3.0',
});

describe('unit · x test sharding', () => {
  test('the same file set produces the same split, every run', () => {
    const files = corpus(120);
    expect(paths(planShards(files, 6))).toEqual(paths(planShards(files, 6)));
  });

  test('discovery order cannot change the assignment', () => {
    const files = corpus(120);
    expect(paths(planShards(shuffled(files), 6))).toEqual(paths(planShards(files, 6)));
  });

  test('every file is assigned exactly once', () => {
    const files = corpus(97);
    const assigned = planShards(files, 8).flatMap((shard) => [...shard.files]);
    expect(assigned.length).toBe(files.length);
    expect(new Set(assigned).size).toBe(files.length);
  });

  test('largest-first greedy keeps every bin under average + largest file', () => {
    const files = corpus(200);
    const shards = planShards(files, 8);
    const largest = Math.max(...files.map((file) => file.bytes));
    const ceiling = totalBytes(files) / 8 + largest;
    for (const shard of shards) expect(shard.bytes).toBeLessThanOrEqual(ceiling);
  });

  test('the slow files are spread, not piled onto one worker', () => {
    // Four slow files whose names sort adjacently: round-robin over discovery order would put
    // every one of them on the same worker, which is the failure mode this algorithm exists for.
    const files: readonly TestFile[] = [
      { path: 'a/slow-1.test.ts', bytes: 90_000 },
      { path: 'a/slow-2.test.ts', bytes: 90_000 },
      { path: 'a/slow-3.test.ts', bytes: 90_000 },
      { path: 'a/slow-4.test.ts', bytes: 90_000 },
      ...Array.from({ length: 12 }, (_unused, index) => ({
        path: `b/fast-${index}.test.ts`,
        bytes: 500,
      })),
    ];
    const shards = planShards(files, 4);
    for (const shard of shards) {
      expect(shard.files.filter((path) => path.includes('slow')).length).toBe(1);
    }
  });

  test('worker count never exceeds the file count, and never drops below one', () => {
    expect(planShards(corpus(3), 16).length).toBe(3);
    expect(planShards(corpus(50), 0).length).toBe(1);
    expect(planShards([], 8).length).toBe(1);
  });
});

describe('unit · x test execution', () => {
  test('each shard is one `bun test` carrying its own files and worker index', async () => {
    const { calls, runner } = recorder();
    const files = corpus(40);
    await runShards({ root: '/repo', runner, files, workers: 4 });
    expect(calls.length).toBe(4);
    const workers = calls.map((call) => call.env?.['ULTIMATE_TEST_WORKER']);
    expect([...workers].sort()).toEqual(['0', '1', '2', '3']);
    for (const call of calls) {
      expect(call.command.slice(0, 2)).toEqual(['bun', 'test']);
      expect(call.command.length).toBeGreaterThan(2);
      expect(call.cwd).toBe('/repo');
    }
    const passed = calls.flatMap((call) => call.command.slice(2));
    expect(new Set(passed).size).toBe(files.length);
  });

  test('--worker reruns exactly the shard CI ran, with the same files', async () => {
    const files = corpus(40);
    const expected = planShards(files, 4)[2];
    const { calls, runner } = recorder();
    await runShards({ root: '/repo', runner, files, workers: 4, only: 2 });
    expect(calls.length).toBe(1);
    expect(calls[0]?.env?.['ULTIMATE_TEST_WORKER']).toBe('2');
    expect(calls[0]?.command.slice(2)).toEqual([...(expected?.files ?? [])]);
  });

  test('a failing shard fails the run and names the command that reproduces it', async () => {
    const { runner } = recorder([1]);
    const result = await runShards({ root: '/repo', runner, files: corpus(40), workers: 4 });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    const finding = result.steps?.flatMap((step) => [...step.findings])[0];
    expect(finding?.code).toBe('X_TEST_SHARD_FAILED');
    expect(finding?.fix).toBe('x test --workers 4 --worker 1');
  });

  test('a filter is carried into the reproduction command as --filter, not a bare positional', async () => {
    const { runner } = recorder([0]);
    const result = await runShards({
      root: '/repo',
      runner,
      files: corpus(10),
      workers: 2,
      filter: 'packages/http',
    });
    expect(result.steps?.[0]?.findings[0]?.fix).toBe(
      'x test --filter packages/http --workers 2 --worker 0',
    );
  });

  test('a type is carried into the reproduction command ahead of --filter', async () => {
    const { runner } = recorder([0]);
    const result = await runShards({
      root: '/repo',
      runner,
      files: corpus(10),
      workers: 2,
      filter: 'packages/http',
      type: 'contract',
    });
    expect(result.steps?.[0]?.findings[0]?.fix).toBe(
      'x test contract --filter packages/http --workers 2 --worker 0',
    );
  });

  test('every shard reports its files, pass/fail and duration in --json', async () => {
    const { runner } = recorder([3]);
    const result = await runShards({ root: '/repo', runner, files: corpus(40), workers: 4 });
    const parsed: unknown = JSON.parse(renderJson(result));
    expect(parsed).toBeDefined();
    const data = result.data as {
      readonly workers: number;
      readonly failed: readonly number[];
      readonly shards: readonly {
        readonly index: number;
        readonly files: number;
        readonly exitCode: number;
        readonly durationMs: number;
        readonly reproduce: string;
      }[];
    };
    expect(data.workers).toBe(4);
    expect(data.failed).toEqual([3]);
    expect(data.shards.length).toBe(4);
    expect(data.shards.reduce((sum, shard) => sum + shard.files, 0)).toBe(40);
    expect(data.shards[3]?.exitCode).toBe(1);
    expect(data.shards[0]?.durationMs).toBe(7);
    expect(data.shards[2]?.reproduce).toBe('x test --workers 4 --worker 2');
  });

  test('a whole-suite pass exits zero and every step is named for its shard', async () => {
    const { runner } = recorder();
    const result = await runShards({ root: '/repo', runner, files: corpus(9), workers: 3 });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.steps?.map((step) => step.ok)).toEqual([true, true, true]);
    expect(result.steps?.[0]?.name).toContain('shard 0');
  });

  test('a typed run uses the .type. summary keys and names its type in data', async () => {
    const { runner } = recorder();
    const result = await runShards({
      root: '/repo',
      runner,
      files: corpus(6),
      workers: 2,
      type: 'contract',
    });
    expect(result.summary).toContain('contract');
    expect((result.data as { type?: string }).type).toBe('contract');
  });

  test('a sampled run names kept/total and is flagged in the human lines, not just data', async () => {
    const { runner } = recorder();
    const files = corpus(10);
    const result = await runShards({
      root: '/repo',
      runner,
      files: files.slice(0, 3),
      workers: 1,
      sample: { total: files.length },
    });
    expect(result.data).toMatchObject({ sample: { kept: 3, total: 10 } });
    expect(result.lines?.[0]).toContain('sampled 3 of 10');
  });
});

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

  test('shardArgs never re-globs in the child: the file list is explicit', () => {
    const shard: Shard = { index: 1, files: ['a.test.ts', 'b.test.ts'], bytes: 2 };
    expect(shardArgs(shard)).toEqual(['bun', 'test', 'a.test.ts', 'b.test.ts']);
    expect(reproduceFor(shard, 4, undefined, undefined)).toBe('x test --workers 4 --worker 1');
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
      const filesOf = (calls: readonly Call[]): readonly string[] =>
        [...calls.flatMap((call) => call.command.slice(2))].sort();
      expect(filesOf(first.calls)).toEqual(filesOf(second.calls));
      expect(filesOf(first.calls).length).toBe(2);
      expect(resultA.data).toMatchObject({ sample: { kept: 2, total: 5 } });
      expect(resultB.ok).toBe(true);
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

describe('unit · reproduceFor', () => {
  test('round-trips through parseArgs to the same type, filter, workers and worker', () => {
    const shard: Shard = { index: 2, files: ['a.test.ts'], bytes: 1 };
    const command = reproduceFor(shard, 5, 'packages/http', 'contract');
    expect(command).toBe('x test contract --filter packages/http --workers 5 --worker 2');
    const tokens = command.split(' ').slice(1); // drop the leading `x`
    const parsed = parseArgs(tokens, [testCommand.spec]);
    expect(parsed.positionals[0]).toBe('contract');
    expect(flagString(parsed, 'filter')).toBe('packages/http');
    expect(flagString(parsed, 'workers')).toBe('5');
    expect(flagString(parsed, 'worker')).toBe('2');
  });

  test('round-trips with no type and no filter, matching today’s bare form', () => {
    const shard: Shard = { index: 0, files: ['a.test.ts'], bytes: 1 };
    const command = reproduceFor(shard, 3, undefined, undefined);
    expect(command).toBe('x test --workers 3 --worker 0');
    const parsed = parseArgs(command.split(' ').slice(1), [testCommand.spec]);
    expect(parsed.positionals[0]).toBeUndefined();
    expect(flagString(parsed, 'filter')).toBeUndefined();
  });
});
