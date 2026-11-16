// `flake-hunt-round.ts` over an injected runner: the argv one round spawns (the suite, shuffled by
// the recorded seed), the failures read out of a red `x test` document, the rerun line built from
// the document's own `reproduce`, and a document that never parsed refused as unreadable.

import { describe, expect, test } from 'bun:test';
import { huntRound, isSeed, rerunCommand } from './flake-hunt-round';
import type { RunResult } from './lib/run';

const result = (output: string, code = 1): RunResult => ({
  command: [],
  code,
  ok: code === 0,
  output,
  durationMs: 1,
  timedOut: false,
});

const RED = JSON.stringify({
  ok: false,
  command: 'test',
  steps: [
    {
      name: 'unit · 4 worker(s)',
      ok: false,
      findings: [{ code: 'X_TEST_FAILED', cause: 'unit run exited 1', fix: 'x test unit' }],
      output: 'packages/core/src/a.test.ts:\nExpected: 1\n(fail) a > adds [2.00ms]',
    },
  ],
  data: { reproduce: 'x test unit --workers 4 --isolate -- --randomize --seed=77', ok: false },
});

describe('unit · flake-hunt · one round', () => {
  test('spawns x test for the suite with the seed handed to bun --randomize', async () => {
    const asked: (readonly string[])[] = [];
    const runner = async (command: readonly string[]): Promise<RunResult> => {
      asked.push(command);
      return result('{"ok":true,"command":"test","data":{"ok":true}}', 0);
    };
    const doc = await huntRound({ root: '.', suite: 'live', seed: 77, round: 2, runner });
    expect(asked).toEqual([
      [
        'bun',
        'run',
        'packages/cli/src/bin.ts',
        'test',
        'live',
        '--json',
        '--',
        '--randomize',
        '--seed=77',
      ],
    ]);
    expect(doc).toMatchObject({ suite: 'live', seed: 77, round: 2, ok: true, failures: [] });
  });

  test("a red document names each failing test and keeps x's own reproduce line", async () => {
    const doc = await huntRound({
      root: '.',
      suite: 'unit',
      seed: 77,
      round: 1,
      runner: async () => result(RED),
    });
    expect(doc.ok).toBe(false);
    expect(doc.failures.map(({ file, test }) => `${file} > ${test}`)).toEqual([
      'packages/core/src/a.test.ts > a > adds',
    ]);
    expect(doc.rerun).toBe('bun run x -- test unit --workers 4 --isolate -- --randomize --seed=77');
    expect(doc.findings.map((one) => one.code)).toEqual(['X_TEST_FAILED']);
  });

  test('output that holds no document is unreadable, never a green round', async () => {
    const doc = await huntRound({
      root: '.',
      suite: 'unit',
      seed: 5,
      round: 1,
      runner: async () => result('segmentation fault', 139),
    });
    expect(doc.ok).toBe(false);
    expect(doc.findings.map((one) => one.code)).toEqual(['X_FLAKE_HUNT_UNREADABLE']);
    expect(doc.tail).toContain('segmentation fault');
  });

  test('a document that says ok over a non-zero exit is still red', async () => {
    const doc = await huntRound({
      root: '.',
      suite: 'unit',
      seed: 5,
      round: 1,
      runner: async () => result('{"ok":true,"command":"test"}', 1),
    });
    expect(doc.ok).toBe(false);
  });
});

describe('unit · flake-hunt · the rerun line and the seed', () => {
  test('a live rerun loads the test services first; no reproduce falls back to the seed', () => {
    expect(rerunCommand('live', 9, undefined)).toBe(
      'set -a; . docker/test-services.env; set +a; bun run x -- test live -- --randomize --seed=9',
    );
  });

  test('a seed is a whole number bun can take; anything else is not one', () => {
    expect(isSeed(1)).toBe(true);
    expect(isSeed(4_294_967_295)).toBe(true);
    expect(isSeed(0)).toBe(false);
    expect(isSeed(4_294_967_296)).toBe(false);
    expect(isSeed(1.5)).toBe(false);
  });
});
