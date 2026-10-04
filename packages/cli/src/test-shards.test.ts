// The run has to be reproducible: the line a failure prints has to reselect exactly the files that
// ran. The argv one `bun test` receives and every input the reproduction carries back are
// asserted here — nowhere else.
//
// WHAT LEFT WHEN THE PACKER DID. The determinism and balance cases below used to be about
// `planShards`, a largest-first greedy bin-packer over file SIZE. There is no packer any more —
// `bun test --parallel=N` hands each free worker the next file — so "is the split balanced?" is
// not a question this repo can answer about itself, and pretending otherwise with a fixture would
// be a test that cannot fail. What is left is what is still ours: the argv, and the reproduction.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no mkdtemp, no recursive remove, and `Bun.write` alone cannot pre-create an empty
// fixture root the way this test's own cleanup needs to remove afterward.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; // why: Bun exposes no temp-directory root.
import { join } from 'node:path'; // why: Bun exposes no path-join primitive.
import { testCommand } from './cmd-test';
import type { ExecOptions, Runner } from './exec';
import { renderJson } from './output';
import { flagBool, flagString, parseArgs } from './parse';
import type { TestFile } from './test-select';
import { filesIn, ISOLATED_TEST_ENV, reproduceFor, runShards, testArgs } from './test-shards';
import { SHARED_BATCH_FILES_PER_WORKER as BATCH_FILES_PER_WORKER } from './test-workers';

interface Call {
  readonly command: readonly string[];
  readonly env: ExecOptions['env'];
  readonly cwd: string;
}

interface Recorder {
  readonly calls: Call[];
  readonly runner: Runner;
}

/** The exec seam, faked: these tests assert on the argv, never on a real process. */
const recorder = (fails = false): Recorder => {
  const calls: Call[] = [];
  const runner: Runner = async (command, options) => {
    calls.push({ command, env: options.env, cwd: options.cwd });
    const code = fails ? 1 : 0;
    return { command, code, ok: code === 0, stdout: 'ran', stderr: '', durationMs: 7 };
  };
  return { calls, runner };
};

/** Deliberately uneven: a handful of very large files plus a long tail of small ones. */
const corpus = (count: number): readonly TestFile[] =>
  Array.from({ length: count }, (_unused, index) => ({
    path: `packages/p${index % 5}/file-${String(index).padStart(3, '0')}.test.ts`,
    bytes: index % 7 === 0 ? 40_000 - index * 13 : 400 + ((index * 37) % 900),
  }));

const firstFix = (result: {
  steps?: readonly { findings: readonly { fix: string }[] }[];
}): string => result.steps?.flatMap((step) => [...step.findings])[0]?.fix ?? '';

const firstCode = (result: {
  steps?: readonly { findings: readonly { code: string }[] }[];
}): string => result.steps?.flatMap((step) => [...step.findings])[0]?.code ?? '';

describe('unit · the argv one bun test receives', () => {
  test('the whole selection is one --parallel run, files listed explicitly, NOT isolated', () => {
    expect(testArgs({ files: ['b.test.ts', 'a.test.ts'], workers: 4 })).toEqual([
      'bun',
      'test',
      '--parallel=4',
      '--no-isolate',
      'a.test.ts',
      'b.test.ts',
    ]);
  });

  // 22.7: isolation is opt-in. `--parallel` implies `--isolate`, so the default run must say
  // `--no-isolate`. The framework repo itself opts back in through `x.verify.json` (its registries
  // are process-global by design).
  test('isolation is opt-in, and a caller’s -- --no-isolate beats the floor', () => {
    expect(testArgs({ files: ['a.test.ts'], workers: 2 })).toContain('--no-isolate');
    expect(testArgs({ files: ['a.test.ts'], workers: 2, isolate: true })).not.toContain(
      '--no-isolate',
    );
    const overridden = testArgs({
      files: ['a.test.ts'],
      workers: 2,
      isolate: true,
      passthrough: ['--no-isolate'],
    });
    expect(overridden.filter((arg) => arg === '--no-isolate')).toHaveLength(1);
  });

  // The slowest files first, from a local cache every run refreshes; a caller's own flag wins.
  test('a parallel run reads and refreshes the timings cache; a caller override wins', () => {
    const args = testArgs({ files: ['a.test.ts'], workers: 2, timings: '/r/.x/test-timings.json' });
    expect(args).toContain('--timings=/r/.x/test-timings.json');
    expect(args).toContain('--update-timings');
    const own = testArgs({
      files: ['a.test.ts'],
      workers: 2,
      timings: '/r/t.json',
      passthrough: ['--timings=mine.json'],
    });
    expect(own.filter((arg) => arg.startsWith('--timings'))).toEqual(['--timings=mine.json']);
  });

  test('filesIn is the inverse, and reads no flag as a filename', () => {
    const command = testArgs({ files: ['a.test.ts', 'b.test.ts'], workers: 8, timings: '/t' });
    expect(filesIn(command)).toEqual(['a.test.ts', 'b.test.ts']);
  });
});

describe('unit · x test execution', () => {
  // Bun 1.4.0 keeps every finished file alive under --isolate while a plugin is registered; the
  // testing preload frees them only when it is told the run is isolated (`isolated-plugins.ts`).
  test('only an isolated child is told so — the default shared-global run is not', async () => {
    const shared = recorder();
    await runShards({ root: '/repo', runner: shared.runner, files: corpus(6), workers: 2 });
    expect(shared.calls[0]?.env?.[ISOLATED_TEST_ENV]).toBeUndefined();
    const isolated = recorder();
    await runShards({
      root: '/repo',
      runner: isolated.runner,
      files: corpus(6),
      workers: 2,
      isolate: true,
    });
    expect(isolated.calls[0]?.env?.[ISOLATED_TEST_ENV]).toBe('1');
    const optedIn = recorder();
    await runShards({
      root: '/repo',
      runner: optedIn.runner,
      files: corpus(6),
      workers: 2,
      passthrough: ['--isolate'],
    });
    expect(optedIn.calls[0]?.env?.[ISOLATED_TEST_ENV]).toBe('1');
  });

  test('a default-width run leases each batch from the machine pool and runs at what it got', async () => {
    const { calls, runner } = recorder();
    const leased: number[] = [];
    let released = 0;
    await runShards({
      root: '/repo',
      runner,
      files: corpus(6),
      workers: 4,
      lease: async (want) => {
        leased.push(want);
        return { count: 1, release: () => (released += 1) };
      },
    });
    expect(leased).toEqual([4]);
    expect(released).toBe(1);
    expect(calls[0]?.command).toContain('--parallel=1');
  });

  test('one bun test carries every selected file, once', async () => {
    const { calls, runner } = recorder();
    const files = corpus(40);
    await runShards({ root: '/repo', runner, files, workers: 4 });

    expect(calls.length).toBe(1);
    expect(calls[0]?.cwd).toBe('/repo');
    expect(filesIn(calls[0]?.command ?? [])).toEqual([...files.map((f) => f.path)].sort());
    // Bun numbers its own workers with `BUN_TEST_WORKER_ID`, which `@ultimat3/testing`'s
    // `workerId` already reads — so a `--parallel` run must NOT pin every worker to one database
    // by exporting `ULTIMATE_TEST_WORKER`, which is that function's first key.
    expect(calls[0]?.env?.['ULTIMATE_TEST_WORKER']).toBeUndefined();
  });

  test('a corpus past the per-worker cap is batches in sequence, every file once, same width', async () => {
    const { calls, runner } = recorder();
    const files = corpus(BATCH_FILES_PER_WORKER * 4 * 2 + 3);
    const result = await runShards({ root: '/repo', runner, files, workers: 4 });

    expect(calls.length).toBe(3);
    for (const call of calls) expect(call.command).toContain('--parallel=4');
    expect(calls.flatMap((call) => filesIn(call.command)).sort()).toEqual(
      files.map((f) => f.path).sort(),
    );
    // One step for the pass, and the rerun names the width, which is all the split depends on.
    expect(result.steps).toHaveLength(1);
    expect(result.steps?.[0]?.name).toContain('3 batches');
    expect((result.data as { batches?: number }).batches).toBe(3);
    expect((result.data as { reproduce: string }).reproduce).toBe('x test --workers 4');
  });

  test('-- --watch is never batched: the first process never exits, so a second never starts', async () => {
    const { calls, runner } = recorder();
    const files = corpus(BATCH_FILES_PER_WORKER * 4 * 2 + 3);
    await runShards({ root: '/repo', runner, files, workers: 4, passthrough: ['--watch'] });
    expect(calls.length).toBe(1);
    expect(filesIn(calls[0]?.command ?? [])).toHaveLength(files.length);
  });

  test('-- --bail starts no batch after a red one', async () => {
    const { calls, runner } = recorder(true);
    const files = corpus(BATCH_FILES_PER_WORKER * 4 * 2 + 3);
    const result = await runShards({
      root: '/repo',
      runner,
      files,
      workers: 4,
      passthrough: ['--bail=1'],
    });
    expect(calls.length).toBe(1);
    expect(result.ok).toBe(false);
    const all = recorder(true);
    await runShards({ root: '/repo', runner: all.runner, files, workers: 4 });
    expect(all.calls.length).toBe(3);
  });

  test('a key `.env.development` leaked into this process is not handed to the bun test child', async () => {
    // Real mechanism, not a mock of it: Bun auto-loads `.env.development` into the PARENT `x`
    // process whenever `NODE_ENV` is unset, and `exec.ts`'s `spawnOrRefuse` used to spread
    // `Bun.env` as the child's base regardless — so this key rode along into every `bun test`
    // child even though a bare `bun test` (NODE_ENV=test) never reads `.env.development` at all.
    const root = mkdtempSync(join(tmpdir(), 'x-verify-env-leak-'));
    try {
      writeFileSync(join(root, '.env.development'), 'ULTIMATE_ENV=development\n');
      const { calls, runner } = recorder();
      // The parent process's env, exactly as `.env.development` would have left it: nothing else
      // set `ULTIMATE_ENV`, so its current value equals the dotenv file's.
      const env = { ULTIMATE_ENV: 'development' };
      await runShards({ root, runner, files: corpus(4), workers: 2, env });
      // `undefined` is `exec.ts`'s own signal for "delete this key from the child" — present as an
      // explicit override, not merely absent, so a base `Bun.env` spread cannot bring it back.
      expect(Object.hasOwn(calls[0]?.env ?? {}, 'ULTIMATE_ENV')).toBe(true);
      expect(calls[0]?.env?.['ULTIMATE_ENV']).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the width is clamped to the file count, so the reproduction is runnable', async () => {
    const { calls, runner } = recorder();
    const result = await runShards({ root: '/repo', runner, files: corpus(3), workers: 16 });
    expect(calls[0]?.command).toContain('--parallel=3');
    expect((result.data as { workers: number }).workers).toBe(3);
  });

  test('a failing run fails the command and names what reproduces it', async () => {
    const { runner } = recorder(true);
    const result = await runShards({ root: '/repo', runner, files: corpus(40), workers: 4 });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(firstCode(result)).toBe('X_TEST_FAILED');
    expect(firstFix(result)).toBe('x test --workers 4');
  });

  test('a filter is carried into the reproduction command as --filter, not a bare positional', async () => {
    const { runner } = recorder(true);
    const result = await runShards({
      root: '/repo',
      runner,
      files: corpus(10),
      workers: 2,
      filter: 'packages/http',
    });
    expect(firstFix(result)).toBe('x test --filter packages/http --workers 2');
  });

  test('a type is carried into the reproduction command ahead of --filter', async () => {
    const { runner } = recorder(true);
    const result = await runShards({
      root: '/repo',
      runner,
      files: corpus(10),
      workers: 2,
      filter: 'packages/http',
      type: 'contract',
    });
    expect(firstFix(result)).toBe('x test contract --filter packages/http --workers 2');
  });

  test('--json reports the width, the file count, the exit code and the rerun', async () => {
    const { runner } = recorder(true);
    const result = await runShards({ root: '/repo', runner, files: corpus(40), workers: 4 });
    // The RENDERED payload, never `result.data`: this test names the `--json` contract, and an
    // agent parses what `renderJson` emitted. `JSON.parse` either throws or answers, so asserting
    // it is defined is an assertion that cannot fail.
    const { data } = JSON.parse(renderJson(result)) as {
      readonly data: {
        readonly workers: number;
        readonly files: number;
        readonly ok: boolean;
        readonly exitCode: number;
        readonly reproduce: string;
      };
    };
    expect(data.workers).toBe(4);
    expect(data.files).toBe(40);
    expect(data.ok).toBe(false);
    expect(data.exitCode).toBe(1);
    expect(data.reproduce).toBe('x test --workers 4');
  });

  test('a pass exits zero and the step is named for the width it ran at', async () => {
    const { runner } = recorder();
    const result = await runShards({ root: '/repo', runner, files: corpus(9), workers: 3 });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.steps?.map((step) => step.ok)).toEqual([true]);
    expect(result.steps?.[0]?.name).toContain('3 worker(s) · 9 files');
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
});

describe('unit · x test --sample is part of the selection', () => {
  const sampled = () =>
    runShards({
      root: '/repo',
      runner: recorder(true).runner,
      files: corpus(10).slice(0, 3),
      workers: 2,
      type: 'eval',
      sample: { kept: 3, total: 10 },
    });

  test('a sampled run names kept/total and is flagged in the human lines, not just data', async () => {
    const result = await sampled();
    expect(result.data).toMatchObject({ sample: { kept: 3, total: 10 } });
    expect(result.lines?.[0]).toContain('sampled 3 of 10');
  });

  test('the reproduction carries --sample, so the rerun selects the same corpus', async () => {
    expect(firstFix(await sampled())).toBe('x test eval --sample 3 --workers 2');
  });
});

describe('unit · reproduceFor', () => {
  // Against the command's real spec, not a fixture: a reproduction the shipped parser rejects is
  // not a reproduction, and a fixture would go on agreeing with itself after the flags changed.
  test('round-trips through parseArgs to the same type, filter, sample and workers', () => {
    const command = reproduceFor({
      workers: 5,
      filter: 'packages/http',
      type: 'contract',
      sample: 4,
    });
    expect(command).toBe('x test contract --filter packages/http --sample 4 --workers 5');
    const parsed = parseArgs(command.split(' ').slice(1), [testCommand.spec]);
    expect(parsed.positionals[0]).toBe('contract');
    expect(flagString(parsed, 'filter')).toBe('packages/http');
    expect(flagString(parsed, 'sample')).toBe('4');
    expect(flagString(parsed, 'workers')).toBe('5');
  });

  // The input most easily dropped: `--affected` decides which files exist to run at all, so a
  // rerun without it selects the whole corpus. Round-tripped through the real spec for the reason
  // the case above is.
  test('the --affected narrowing survives into the rerun, base and all', () => {
    const command = reproduceFor({
      workers: 4,
      affected: { base: 'origin/main', dirty: false },
    });
    expect(command).toBe('x test --affected --base origin/main --workers 4');

    const parsed = parseArgs(command.split(' ').slice(1), [testCommand.spec]);
    expect(flagBool(parsed, 'affected')).toBe(true);
    expect(flagString(parsed, 'base')).toBe('origin/main');
  });

  test('--dirty survives too, because it changes which files the run saw', () => {
    expect(reproduceFor({ workers: 2, affected: { base: 'main', dirty: true } })).toBe(
      'x test --affected --base main --dirty --workers 2',
    );
  });

  test('a filter with whitespace stays one argument, not two', () => {
    expect(reproduceFor({ workers: 2, filter: 'my tests/http' })).toBe(
      "x test --filter 'my tests/http' --workers 2",
    );
  });

  test('a filter with shell punctuation cannot become a second command', () => {
    expect(reproduceFor({ workers: 2, filter: 'a; rm -rf b' })).toBe(
      "x test --filter 'a; rm -rf b' --workers 2",
    );
  });

  test('a single quote is escaped the one way a single-quoted string allows', () => {
    // `'it'\''s slow'` — close, an escaped quote, reopen. Anything else truncates the argument.
    expect(reproduceFor({ workers: 1, filter: "it's slow" })).toBe(
      "x test --filter 'it'\\''s slow' --workers 1",
    );
  });
});
