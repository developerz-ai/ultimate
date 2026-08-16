// Which gate step spreads across processes and which one cannot, asserted through the steps
// themselves rather than through the table that declares it — a table nobody reads is a comment.
// The runner is fake on purpose: a real `bun test` here would be testing Bun.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// Bun ships no temp-directory primitive: `mkdtemp`/`rm` build and remove the throwaway tree these
// steps discover over, `tmpdir` says where, and `join` is the host-separator path into it.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecOptions, ExecResult } from './exec';
import { belongsToType } from './test-select';
import { SHARD_COMMAND_PREFIX } from './test-shards';
import type { VerifyContext, VerifyStep } from './verify-step';
import {
  ownerOf,
  resetTestDiscovery,
  SERIAL_TYPES,
  TEST_STEPS,
  TEST_TYPES,
  testStepCommand,
  typeFiltersOf,
} from './verify-tests';

interface Call {
  readonly command: readonly string[];
  readonly worker: string | undefined;
}

let root = '';
const calls: Call[] = [];

const runner = async (command: readonly string[], options?: ExecOptions): Promise<ExecResult> => {
  calls.push({ command, worker: options?.env?.['ULTIMATE_TEST_WORKER'] });
  return { ok: true, code: 0, stdout: '', stderr: '', durationMs: 1 };
};

const ctx = (workers: number): VerifyContext => ({ root, runner, workers });

const stepFor = (name: string): VerifyStep => {
  const step = TEST_STEPS.find((candidate) => candidate.name === name);
  if (step === undefined) throw new RangeError(`no ${name} step`);
  return step;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-verify-tests-'));
  // Twelve unit files and three live ones: enough that a four-worker split is visibly a split.
  for (let i = 0; i < 12; i += 1) {
    await Bun.write(join(root, `pkg/unit-${i}.test.ts`), `// ${'x'.repeat(i * 10)}\n`);
  }
  for (let i = 0; i < 3; i += 1) {
    await Bun.write(join(root, `pkg/feed-${i}.live.test.ts`), '// live\n');
  }
  resetTestDiscovery();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  resetTestDiscovery();
});

describe('unit · the gate runs its test steps in parallel', () => {
  test('unit spreads over N processes, each with its own worker index', async () => {
    calls.length = 0;
    const outcome = await stepFor('unit').run(ctx(4));
    expect(outcome.ok).toBe(true);
    expect(outcome.workers).toBe(4);
    expect(calls.length).toBe(4);
    expect(calls.map((call) => call.worker).sort()).toEqual(['0', '1', '2', '3']);
  });

  test('every shard isolates the module registry per file — an arbitrary split needs it', async () => {
    calls.length = 0;
    await stepFor('unit').run(ctx(3));
    for (const call of calls) {
      expect(call.command.slice(0, SHARD_COMMAND_PREFIX.length)).toEqual([...SHARD_COMMAND_PREFIX]);
    }
  });

  test('every file lands in exactly one shard, so nothing is run twice or dropped', async () => {
    calls.length = 0;
    await stepFor('unit').run(ctx(4));
    const files = calls.flatMap((call) => call.command.slice(SHARD_COMMAND_PREFIX.length));
    expect(files.length).toBe(12);
    expect(new Set(files).size).toBe(12);
  });

  test('--workers 1 is one process, and the split is still every file', async () => {
    calls.length = 0;
    const outcome = await stepFor('unit').run(ctx(1));
    expect(outcome.workers).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0]?.command.slice(SHARD_COMMAND_PREFIX.length).length).toBe(12);
  });
});

describe('unit · a step reports what bun actually ran, not just how it exited', () => {
  // Verbatim bun 1.3.14 output for a file whose whole describe block is `skipIf`-ed away. The
  // step exits 0, so the exit code alone reports it green — which is how `live` passed the gate
  // over 114 skipped tests and 4 real ones.
  const skippedSummary = ' 0 pass\n 2 skip\n 0 fail\nRan 2 tests across 1 file. [240.00ms]\n';
  const ranSummary = ' 7 pass\n 1 skip\n 0 fail\nRan 8 tests across 2 files. [12.00ms]\n';

  const counting = (stdout: string): VerifyContext => ({
    root,
    workers: 2,
    runner: async (command) => ({ command, ok: true, code: 0, stdout, stderr: '', durationMs: 1 }),
  });

  test('a parallel step sums every shard summary into what it ran and what it skipped', async () => {
    const outcome = await stepFor('unit').run(counting(skippedSummary));
    // Two shards, each reporting the same all-skipped summary: nothing ran, four were skipped.
    expect(outcome.tests).toEqual({ ran: 0, skipped: 4 });
  });

  test('pass and fail both count as ran — a suite that failed is a suite that executed', async () => {
    const outcome = await stepFor('unit').run(counting(ranSummary));
    expect(outcome.tests).toEqual({ ran: 14, skipped: 2 });
  });

  test('a serial step reads its one summary the same way', async () => {
    const outcome = await stepFor('live').run(counting(skippedSummary));
    expect(outcome.workers).toBe(1);
    expect(outcome.tests).toEqual({ ran: 0, skipped: 2 });
  });

  // Output this cannot recognise is a runner that died before it printed a summary. Reporting
  // zero there would turn a crash into a vanished suite and send the reader at the wrong file.
  test('output with no summary in it is not read as a suite that ran nothing', async () => {
    const outcome = await stepFor('live').run(counting('bun: command not found\n'));
    expect(outcome.tests?.ran).toBeGreaterThan(0);
  });
});

describe('unit · a type claims a file by a boundary, never a bare substring', () => {
  // The e2e filter was the bare word `e2e` matched against the whole path, so a file whose NAME
  // merely holds those three characters joined the e2e step — and left the unit step, which
  // selects by exclusion. Both halves are asserted, because the file has to land in exactly one.
  test('e2e claims the directory and the suffix, and refuses a name that only contains e2e', () => {
    expect(belongsToType('packages/x/src/e2e-helpers.test.ts', 'e2e')).toBe(false);
    expect(belongsToType('packages/x/src/e2e-helpers.test.ts', 'unit')).toBe(true);
    expect(belongsToType('packages/x/e2e/boot.test.ts', 'e2e')).toBe(true);
    expect(belongsToType('packages/x/src/boot.e2e.test.ts', 'e2e')).toBe(true);
  });

  test('every typed step passes bun exactly the filters that decide the type', () => {
    // `e2e/` and not `/e2e/`: bun matches a filter against the cwd-relative path and answers
    // `Test filter "/e2e/" had no matches` for the anchored form — measured on bun 1.3.14. The
    // step's argv and `belongsToType` must stay one predicate, so this is the form both use.
    expect([...typeFiltersOf('e2e')]).toEqual(['.e2e.test.', 'e2e/']);
    const command = testStepCommand('e2e');
    expect(command.slice(0, 2)).toEqual(['bun', 'test']);
    for (const filter of typeFiltersOf('e2e')) expect(command).toContain(filter);
    for (const type of ['contract', 'live', 'job', 'eval'] as const) {
      expect([...typeFiltersOf(type)]).toEqual([`.${type}.test.`]);
    }
  });

  // Two rules can match one path, and until 2026-08 both claimed it: the `contract` step selected
  // `e2e/payment.contract.test.ts` by name while the `e2e` step's argv selected it by directory, so
  // one test ran twice in one gate — and a second run proves nothing the first did not.
  test('a typed filename inside e2e/ belongs to its NAME, and only to it', () => {
    const path = 'packages/app/e2e/payment.contract.test.ts';
    expect(ownerOf(path)).toBe('contract');
    expect(belongsToType(path, 'contract')).toBe(true);
    expect(belongsToType(path, 'e2e')).toBe(false);
    // The directory still decides for a filename that declares nothing.
    expect(ownerOf('packages/app/e2e/boot.test.ts')).toBe('e2e');
  });

  test('the e2e step is told to skip the files its directory filter does not own', () => {
    // The file list is only half of it: `e2e` is SERIAL, so what it actually runs is this argv —
    // exclusivity that lived only in `ownerOf` would still have handed bun the file.
    expect(testStepCommand('e2e')).toContain(
      '--path-ignore-patterns=**/e2e/**/*.{contract,live,job,eval}.test.*',
    );
    // e2e's own suffix is never disowned by its own step.
    expect(testStepCommand('e2e').join(' ')).not.toContain('e2e}.test.*');
  });

  test('no path has two owners', () => {
    const paths = [
      'packages/app/e2e/payment.contract.test.ts',
      'packages/app/e2e/feed.live.test.ts',
      'packages/app/e2e/boot.test.ts',
      'packages/app/src/boot.e2e.test.ts',
      'packages/app/src/prompt.eval.test.ts',
      'packages/app/src/e2e-helpers.test.ts',
      'packages/app/src/plain.test.ts',
    ];
    for (const path of paths) {
      expect(TEST_TYPES.filter((type) => belongsToType(path, type))).toEqual([ownerOf(path)]);
    }
  });
});

describe('unit · the two types that cannot be split stay serial', () => {
  test('live runs as one process no matter how many workers are asked for', async () => {
    calls.length = 0;
    const outcome = await stepFor('live').run(ctx(8));
    // A cluster-wide replication slot is not isolated by a per-worker database, so this type is
    // one process by design — and the report says so rather than leaving a reader to infer it.
    expect(outcome.workers).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0]?.worker).toBeUndefined();
    expect(calls[0]?.command.slice(0, 2)).toEqual(['bun', 'test']);
  });

  test('the serial list is exactly the two types with a documented reason', () => {
    expect([...SERIAL_TYPES]).toEqual(['live', 'e2e']);
  });
});
