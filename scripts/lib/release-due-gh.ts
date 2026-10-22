// The `gh` binary the release-due bump-PR lookup runs: through the one subprocess boundary
// (`lib/run.ts`), on a deadline shorter than the default, so a hung `gh` cannot hold a checkup.
// Its answer is decoration, so a non-zero exit is REPORTED, never thrown — the caller decides what
// an unanswerable lookup means (`release-due.ts` reads it as no known PRs, never as none open).

import type { RunResult } from './run';
import { run } from './run';

/** A read-only lookup's deadline, well under `DEFAULT_RUN_TIMEOUT_MS`: none of these does work. */
export const GH_TIMEOUT_MS = 30_000;

/** A `gh` command in `cwd`, bounded; `run()` gives it `stdin: 'ignore'`, so it can never prompt. */
export const gh = (args: readonly string[], cwd: string): Promise<RunResult> =>
  run(['gh', ...args], { cwd, timeoutMs: GH_TIMEOUT_MS });
