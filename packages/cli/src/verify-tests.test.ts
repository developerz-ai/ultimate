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
import { SHARD_COMMAND_PREFIX } from './test-shards';
import type { VerifyContext, VerifyStep } from './verify-step';
import { resetTestDiscovery, SERIAL_TYPES, TEST_STEPS } from './verify-tests';

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
