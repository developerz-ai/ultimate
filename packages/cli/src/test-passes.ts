// Which of a selection's files may share a worker pool, and which may not. `--parallel=N` is the
// width of the WHOLE run, so a selection holding a `live` or an `e2e` file is more than one run —
// this file decides how many, and `test-shards.ts` spends them.

import type { TestFile } from './test-select';
import type { TestType } from './verify-tests';
import { ownerOf, SERIAL_TYPES } from './verify-tests';

/** One `bun test` invocation: which files, how wide, and the type its reproduce line names. */
export interface TestPass {
  readonly files: readonly TestFile[];
  readonly workers: number;
  /**
   * The type this pass is exactly the selection of, when it is one — so a failure's `fix:` names
   * `x test live --workers 1` and reruns THESE files, not the whole corpus at this width.
   */
  readonly type?: TestType;
}

export interface PassInput {
  readonly files: readonly TestFile[];
  /** What the caller asked for, already bounded by `--workers`' own reader. */
  readonly workers: number;
  /** The positional, when there was one. A pass over one type keeps it; the split never adds one. */
  readonly type?: TestType;
  /** Set for a `--worker I` rerun, which is one process by construction. */
  readonly shard?: number;
}

const widthFor = (files: readonly TestFile[], workers: number): number =>
  Math.max(1, Math.min(Math.trunc(workers), files.length || 1));

/**
 * The passes one invocation becomes. One, for every selection that holds no serial file — which
 * is every `x test unit`, every `--filter` over a feature's contract tests, and the whole corpus
 * of an app that has neither.
 *
 * `live` and `e2e` are the exception, and `verify-tests.ts` owns both the list and the reasons: a
 * logical replication slot is named at the Postgres CLUSTER level so a per-worker database does
 * not isolate it, and `e2e` shares one `dist/` and one browser profile. `x verify` has routed them
 * through `runSerial` since 2026-08 while `x test` clamped on the POSITIONAL alone — so a bare
 * `x test --workers 8` ran the very files the gate runs one at a time, eight at a time, and only
 * a real `TEST_DATABASE_URL` makes that visible.
 *
 * Each serial type is its own pass rather than one pass over both, because the pass's `type` is
 * what its failure reproduces with: `x test live --workers 1` selects exactly the files that ran.
 *
 * A `--worker I` rerun is left whole: it is a single `bun test --isolate --shard=i/N` process, so
 * nothing inside it runs beside anything else, and splitting it would make shard i of the rerun a
 * different set of files from shard i of the run it reproduces.
 */
export function testPasses(input: PassInput): readonly TestPass[] {
  const serialTypes = new Set<TestType>(SERIAL_TYPES);
  if (input.shard !== undefined) {
    return [
      {
        files: input.files,
        workers: widthFor(input.files, input.workers),
        ...(input.type === undefined ? {} : { type: input.type }),
      },
    ];
  }
  const shared = input.files.filter((file) => !serialTypes.has(ownerOf(file.path)));
  const passes: TestPass[] = [];
  // Cheapest first, and the widest first: the pool run is most of the corpus and most of the
  // signal, and a serial suite that needs a database is the one a laptop is least likely to have.
  if (shared.length > 0) {
    passes.push({
      files: shared,
      workers: widthFor(shared, input.workers),
      ...(input.type === undefined ? {} : { type: input.type }),
    });
  }
  for (const type of SERIAL_TYPES) {
    const files = input.files.filter((file) => ownerOf(file.path) === type);
    if (files.length > 0) passes.push({ files, workers: 1, type });
  }
  return passes;
}
