// Spending a pass as a few `bun test` processes in sequence: the split is a pure function of the
// file list and the width, every batch fits the per-worker cap, and the results add up.

import { describe, expect, test } from 'bun:test';
import type { ExecResult, Runner } from './exec';
import { runBatches, testBatches } from './test-batches';
import { BATCH_FILES_PER_WORKER } from './test-workers';

const filesOf = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `t/${String(index).padStart(4, '0')}.test.ts`);

describe('unit · test batches', () => {
  test('a selection that fits one batch is ONE batch, the list itself, sorted', () => {
    const files = filesOf(BATCH_FILES_PER_WORKER * 4).reverse();
    const batches = testBatches(files, 4);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([...files].sort());
  });

  test('a corpus larger than the cap is split into the fewest batches that fit', () => {
    const cap = BATCH_FILES_PER_WORKER * 12;
    const batches = testBatches(filesOf(768), 12);
    expect(batches).toHaveLength(Math.ceil(768 / cap));
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(cap);
    // Sizes differ by at most one, and every file lands exactly once.
    const sizes = batches.map((batch) => batch.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(batches.flat().sort()).toEqual(filesOf(768));
  });

  test('the peak is a function of the width, not the corpus: batch size never grows with it', () => {
    for (const corpus of [300, 3000, 30000]) {
      const largest = Math.max(...testBatches(filesOf(corpus), 8).map((batch) => batch.length));
      expect(largest).toBeLessThanOrEqual(8 * BATCH_FILES_PER_WORKER);
    }
  });

  test('the split is deterministic: discovery order cannot change which batch a file is in', () => {
    const files = filesOf(1000);
    const shuffled = [...files].sort(() => 0.5 - Math.random());
    expect(testBatches(shuffled, 6)).toEqual(testBatches(files, 6));
  });

  test('round-robin: every batch gets a slice of every stretch of the sorted list', () => {
    const batches = testBatches(filesOf(100), 1);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches[0]?.slice(0, 2)).toEqual([
      't/0000.test.ts',
      `t/${String(batches.length).padStart(4, '0')}.test.ts`,
    ]);
  });

  test('an empty selection is one empty batch, never zero', () => {
    expect(testBatches([], 4)).toEqual([[]]);
  });
});

const result = (command: readonly string[], code: number, stdout: string): ExecResult => ({
  command,
  code,
  ok: code === 0,
  stdout,
  stderr: '',
  durationMs: 10,
});

describe('unit · running batches', () => {
  test('batches run one after another, and a red one does not stop the rest', async () => {
    let running = 0;
    const seen: string[][] = [];
    const runner: Runner = async (command) => {
      running += 1;
      expect(running).toBe(1);
      await Bun.sleep(1);
      running -= 1;
      seen.push(command.slice(2));
      return result(command, seen.length === 1 ? 1 : 0, `batch ${seen.length}`);
    };
    const run = await runBatches({
      runner,
      batches: [['a'], ['b'], ['c']],
      argsFor: (files) => ['bun', 'test', ...files],
      options: { cwd: '/' },
    });
    expect(seen).toEqual([['a'], ['b'], ['c']]);
    expect(run.ok).toBe(false);
    expect(run.code).toBe(1);
    expect(run.results).toHaveLength(3);
    expect(run.durationMs).toBe(30);
    // Every batch's output is kept, each under the line that names it.
    expect(run.output).toContain('batch 1 of 3 · 1 file(s)');
    expect(run.output).toContain('batch 3');
  });

  test('one batch reads byte for byte as the unbatched run always did', async () => {
    const run = await runBatches({
      runner: async (command) => result(command, 0, ' 3 pass\n 0 fail\nRan 3 tests across 1 file.'),
      batches: [['a']],
      argsFor: (files) => ['bun', 'test', ...files],
      options: { cwd: '/' },
    });
    expect(run.output).toBe(' 3 pass\n 0 fail\nRan 3 tests across 1 file.');
    expect(run.ok).toBe(true);
    expect(run.code).toBe(0);
  });
});
