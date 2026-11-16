#!/usr/bin/env bun
// Writes `scripts/lib/ci/test-weights.json` — the per-file wall ms ci.yml's gate shards are dealt
// on — from one CI run's artifacts, and prints the shard loads the new weights predict against
// round-robin. Refresh after a green run on main:
//
//   gh run download <run-id> -p 'verify-part-unit-*' -p 'test-timings-*' -D .x/ci-run/<run-id>
//   bun run scripts/test-weights.ts .x/ci-run/<run-id> [--out <file>] [--json]
//
// `--out` writes elsewhere (a preview, a test); the default is the committed `WEIGHTS_FILE`.

// why: Bun ships no path-basename or path-join primitive.
import { basename, join } from 'node:path';
import { flagString, parseScriptArgs } from './lib/args';
import {
  corpusOf,
  freshWeights,
  predictedLoads,
  readMeasuredParts,
  renderWeights,
  WEIGHTS_FILE,
} from './lib/ci/test-weights';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';

const SCRIPT = 'test-weights';
const FIX = `gh run download <run-id> -p 'verify-part-unit-*' -p 'test-timings-*' -D .x/ci-run/<run-id> && bun run scripts/${SCRIPT}.ts .x/ci-run/<run-id>`;

/** Seconds at four workers — what a gate part's step wall reads, to compare with a run's log. */
const wall = (loads: readonly number[]): number[] => loads.map((ms) => Math.round(ms / 4000));

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2), {
    names: ['out'],
    refuse: (unknown) =>
      new ScriptError({
        code: 'X_CLI_BAD_FLAG',
        cause: `${SCRIPT} reads one artifacts directory, --out and --json only, and was given --${unknown.join(', --')}`,
        fix: FIX,
      }),
  });
  const dir = args.positionals[0];
  const read = dir === undefined ? { parts: [], unpaired: [] } : await readMeasuredParts(dir);
  const files = freshWeights(read.parts);
  if (Object.keys(files).length === 0) {
    report(
      {
        ok: false,
        script: SCRIPT,
        summary: 'no weights written',
        findings: [
          {
            code: 'X_CORPUS_UNSCANNED',
            cause: `${dir ?? 'no directory given'} holds no test-timings-<part>-attempt-<n> artifact paired with its verify-part document, so no file was measured${read.unpaired.length === 0 ? '' : ` (unpaired: ${read.unpaired.join(', ')})`}`,
            fix: FIX,
          },
        ],
      },
      args.json,
    );
  }
  const source = `ci run ${basename(dir as string)}`;
  const out = flagString(args, 'out') ?? join(repoRoot(), WEIGHTS_FILE);
  await Bun.write(out, renderWeights({ measuredAt: new Date().toISOString(), source, files }));
  // Each step's corpus, from the parts themselves, dealt as the next run will deal it.
  const corpus = corpusOf(read.parts);
  const shards = new Set(read.parts.map((p) => p.part)).size;
  const predicted = [shards, shards + 1].map((total) => ({
    shards: total,
    roundRobinSeconds: wall(predictedLoads(corpus, files, total, false)),
    weightedSeconds: wall(predictedLoads(corpus, files, total, true)),
  }));
  report(
    {
      ok: true,
      script: SCRIPT,
      summary: `${out}: ${String(Object.keys(files).length)} file(s) from ${String(read.parts.length)} part(s) of ${source}`,
      data: { file: out, source, files: Object.keys(files).length, predicted },
      lines: [
        ...read.unpaired.map((name) => `skipped ${name}: no verify-part document beside it`),
        ...predicted.map(
          (row) =>
            `${String(row.shards)} shards, s at 4 workers: round-robin ${row.roundRobinSeconds.join(' ')} · weighted ${row.weightedSeconds.join(' ')}`,
        ),
      ],
    },
    args.json,
  );
}
