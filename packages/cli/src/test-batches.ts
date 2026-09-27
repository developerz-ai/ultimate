// Spending one pass as a few `bun test --parallel=N` processes in sequence, not one. The width of
// a pass is `test-workers.ts`'s to decide; how many files one set of N workers is allowed to chew
// through before it is thrown away is this file's.
//
// WHY THERE IS MORE THAN ONE PROCESS, `As of 2026-09-27`. A `--parallel` worker is not freed file
// by file: it keeps its heap for the life of the `bun test` process and it GROWS with every file it
// is handed (JIT, module-resolution caches, PGlite heaps the collector has not yet returned). On
// notificado.co's unit corpus (768 files, PGlite per file, 12-core box, Bun 1.4.0), whole-tree RSS
// at 12 workers:
//
//   | form                                        | peak tree RSS | wall   |
//   |---------------------------------------------|---------------|--------|
//   | 1x `--parallel=12`, 768 files (~64/worker)  | 12.4-13.3 GB  | 134-158s |
//   | 3x `--parallel=12`, 256 files (~21/worker)  | 10.8-11.4 GB  | 133-147s |
//   | 6x `--parallel=12`, 128 files (~11/worker)  |  9.7 GB       | 166s   |
//
// (Wall is noisy — the box was shared, at load 30-40 — but batching at the same width never
// measured slower than not batching outside one outlier run.)
//
// One process's footprint scales with the files each worker sees, so an unbatched run's peak is a
// function of the CORPUS: every test file an app adds raises it, and nothing ever gives it back
// until the run ends. A batch boundary gives all of it back. At `BATCH_FILES_PER_WORKER` files per
// worker the peak is a function of the WIDTH alone — and the wall clock does not move, because a
// worker restart costs a second against a batch of ~40s. Halving the batch again bought 1.5 GB for
// 25% more wall, which is why the constant is not smaller.
//
// THE DEAL IS ROUND-ROBIN over the sorted list, so every batch gets a slice of every directory
// (a slow directory is not one batch's tail) and the split is a pure function of the file list and
// the width: `x test unit --workers N` reruns exactly the batches the failing run ran.

import type { ExecResult, Runner } from './exec';
import { execOutput } from './exec';
import { msg } from './messages';
import { SLOT_HELD_ENV } from './test-slots';
import { BATCH_FILES_PER_WORKER } from './test-workers';

/**
 * The file groups one pass runs as, in order. One group — the list itself — whenever the list fits
 * in `workers x BATCH_FILES_PER_WORKER`, which is every small selection and every `--filter`.
 * Otherwise the fewest groups that fit, dealt round-robin so their sizes differ by at most one.
 */
export function testBatches(files: readonly string[], workers: number): readonly string[][] {
  const sorted = [...files].sort();
  const cap = Math.max(1, Math.trunc(workers)) * BATCH_FILES_PER_WORKER;
  const count = Math.max(1, Math.ceil(sorted.length / cap));
  const batches: string[][] = Array.from({ length: count }, () => []);
  sorted.forEach((file, index) => {
    batches[index % count]?.push(file);
  });
  return batches;
}

/** Every batch's own result, and what they add up to. */
export interface BatchedRun {
  /** One per batch, in order — `countsOf` reads each one's own Bun summary. */
  readonly results: readonly ExecResult[];
  /** The width each batch really ran at, after the machine lease. */
  readonly widths: readonly number[];
  readonly ok: boolean;
  /** The first non-zero exit, or 0. */
  readonly code: number;
  /** Summed: the batches ran one after another. */
  readonly durationMs: number;
  /**
   * Every batch's output, each under a line naming it when there was more than one. One batch is
   * `execOutput` of it, byte for byte, so a small run reads exactly as it always has.
   */
  readonly output: string;
}

/**
 * Run `batches` one after another — never `Promise.all`, which would put every batch's workers on
 * the machine at once and undo the bound — and keep going after a red one, because the caller
 * asked for the whole selection and a report that stops at the first failure hides the rest. The
 * one exception is a caller that asked to stop (`stopOnFailure`, i.e. `-- --bail`).
 */
export async function runBatches(input: {
  readonly runner: Runner;
  readonly batches: readonly (readonly string[])[];
  /** `width` is the batch's real worker count — the ask, narrowed by the machine lease. */
  readonly argsFor: (files: readonly string[], width: number) => readonly string[];
  /** The width each batch asks for; required with `lease`. */
  readonly workers?: number;
  /**
   * Lease the batch's workers from the machine pool (`test-slots.ts`) before it starts, and give
   * them back when it exits — so two runs on one box share its budget batch by batch.
   */
  readonly lease?: (want: number) => Promise<{ readonly count: number; release(): void }>;
  readonly options: Parameters<Runner>[1];
  /**
   * Launch no further batch once one is red. Set for a caller-forwarded `--bail`: Bun stops a
   * process at its threshold, and without this the next batch would start over from zero.
   */
  readonly stopOnFailure?: boolean;
}): Promise<BatchedRun> {
  const results: ExecResult[] = [];
  const widths: number[] = [];
  for (const files of input.batches) {
    const want = Math.max(1, Math.min(input.workers ?? files.length, files.length));
    const lease = input.lease === undefined ? undefined : await input.lease(want);
    const width = Math.min(want, lease?.count ?? want);
    let result: ExecResult;
    try {
      result = await input.runner(
        input.argsFor(files, width),
        lease === undefined
          ? input.options
          : { ...input.options, env: { ...input.options.env, [SLOT_HELD_ENV]: '1' } },
      );
    } finally {
      lease?.release();
    }
    results.push(result);
    widths.push(width);
    if (!result.ok && input.stopOnFailure === true) break;
  }
  const first = results.find((result) => !result.ok);
  const output =
    results.length === 1
      ? execOutput(results[0] as ExecResult)
      : results
          .map((result, index) =>
            [
              msg('cli.test.batch', {
                batch: index + 1,
                batches: results.length,
                files: input.batches[index]?.length ?? 0,
              }),
              execOutput(result),
            ].join('\n'),
          )
          .join('\n');
  return {
    results,
    widths,
    ok: first === undefined,
    code: first?.code ?? 0,
    durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    output,
  };
}
