#!/usr/bin/env bun
// The test files ci.yml's `flaky` job reruns `--rerun-each` times: the ones a pull request
// changed, of the suites the gate's unit parts run, as `./`-anchored paths. Selection only — the
// job runs `bun test`, and any of the runs failing is its red. At most `RERUN_CAP` files.
//
//   bun run scripts/lib/ci/rerun-changed.ts <file-of-changed-paths> [--json]

// why: Bun ships no synchronous existence check for a path; `Bun.file().exists()` is async.
import { existsSync } from 'node:fs';
import { isIgnoredTestPath } from '../../../packages/cli/src/test-ignores';
import { ownerOf } from '../../../packages/cli/src/verify-tests';
import { parseChangedFiles } from '../../ci-changes';
import { parseScriptArgs } from '../args';
import { report } from '../log';

/** Runs per changed file. A flake that fails one run in three is missed by five only 13% of the time. */
export const RERUN_EACH = 5;

/**
 * The suites the gate's `unit-N` parts run, beside the one Postgres the job starts. `live`, `e2e`
 * and `eval` need servers, a browser or a recording this job does not start: a skip is no rerun.
 */
const RERUN_SUITES: readonly string[] = ['unit', 'contract', 'job'];

/**
 * Files rerun per pull request, at most. A sweep touching 300 test files is 1,500 runs inside a
 * 10-minute job; past the cap the first of the sorted list run and the rest are a counted notice.
 */
export const RERUN_CAP = 40;

const TEST_FILE = /\.test\.tsx?$/;

/** The changed paths worth rerunning, posix, anchored, sorted, once each. */
export function rerunPaths(
  changed: readonly string[],
  exists: (path: string) => boolean,
): readonly string[] {
  const kept = changed
    .map((path) => path.replace(/\r$/, '').split('\\').join('/'))
    .filter(
      (path) =>
        TEST_FILE.test(path) &&
        !isIgnoredTestPath(path) &&
        RERUN_SUITES.includes(ownerOf(path)) &&
        exists(path),
    );
  return [...new Set(kept)].sort().map((path) => `./${path}`);
}

/** The first `RERUN_CAP` of the sorted paths, and how many past it were left out. */
export const capRerun = (
  paths: readonly string[],
): { readonly paths: readonly string[]; readonly skipped: number } => ({
  paths: paths.slice(0, RERUN_CAP),
  skipped: Math.max(0, paths.length - RERUN_CAP),
});

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const list = args.positionals[0];
  const file = list === undefined ? undefined : Bun.file(list);
  const text = file !== undefined && (await file.exists()) ? await file.text() : undefined;
  const { paths, skipped } = capRerun(
    rerunPaths(parseChangedFiles(text), (path) => existsSync(path)),
  );
  const past =
    skipped === 0 ? '' : `, ${String(skipped)} more past the cap of ${String(RERUN_CAP)}`;
  report(
    {
      ok: true,
      script: 'rerun-changed',
      summary: `${String(paths.length)} changed test file(s) to run ${String(RERUN_EACH)} times${past}`,
      data: { rerunEach: RERUN_EACH, cap: RERUN_CAP, skipped, paths: [...paths] },
      lines: [...paths],
    },
    args.json,
  );
}
