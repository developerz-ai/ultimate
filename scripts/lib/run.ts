// The single subprocess boundary for the root scripts. One implementation, so every script times,
// bounds, captures and reports a command the same way — and no child can hold a caller forever.

// why: Bun ships no path API; the root is spelt with the host separator so Windows can open it.
import { join } from 'node:path';
import { ScriptError } from './script-error';

/** The code a run that outlived its deadline answers. Gate-only: `scripts/` never ships. */
export const RUN_TIMEOUT_CODE = 'X_SPAWN_TIMED_OUT';

/**
 * Every run's deadline unless its caller passes one. Sized for a `git`, a `gh api` or a whole-repo
 * `bun run scripts/…` under a CI shard's contention — never for an install or a compiler, which
 * pass `LONG_RUN_TIMEOUT_MS`. A deadline, not a budget: what hits it has hung.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;

/** For a caller that legitimately runs long: `bun install`, a `tsc --noEmit` over a tree. */
export const LONG_RUN_TIMEOUT_MS = 600_000;

export interface RunOptions {
  readonly cwd: string;
  /** The whole call, the child's pipes included. Default `DEFAULT_RUN_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** The child's environment. Default: this process's. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface RunResult {
  readonly command: readonly string[];
  /** The exit code; `null` when the run was killed at its deadline. */
  readonly code: number | null;
  readonly ok: boolean;
  readonly output: string;
  readonly durationMs: number;
  /** The deadline expired first: the child was killed and `output` starts with the coded line. */
  readonly timedOut: boolean;
}

/** A pipe read to its end, or released on demand — `cancel()` is what lets this process exit. */
function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const done = (async () => {
    for (;;) {
      const { done: ended, value } = await reader.read();
      if (ended) return;
      text += decoder.decode(value, { stream: true });
    }
  })();
  return {
    done,
    text: (): string => text + decoder.decode(),
    cancel: (): Promise<void> => reader.cancel().catch(() => undefined),
  };
}

const joined = (parts: readonly string[]): string =>
  parts
    .filter((part) => part.trim().length > 0)
    .join('\n')
    .trimEnd();

const refuse = (cause: string, fix: string): never => {
  // A caller bug, never a user's — `packages/cli/src/exec.ts` makes the identical guard at the
  // identical seam, and for the identical reason: a bare `Error` from the one boundary every
  // script goes through surfaces as an unexplained crash with no code and no `fix:`.
  throw new ScriptError({ code: 'X_CLI_UNEXPECTED', cause, fix });
};

/**
 * Run `command` to completion or to its deadline, whichever is first. A non-zero exit and a
 * timeout are both REPORTED, never thrown. The deadline races the whole call, pipes included: a
 * child that exits leaving a process that holds its stdout (git's background maintenance, a pager,
 * a credential helper) would otherwise hold the caller until that process dies. stdin is never
 * the caller's, so nothing run here can wait on a person.
 */
export async function run(
  command: readonly string[],
  options: RunOptions = { cwd: process.cwd() },
): Promise<RunResult> {
  const started = performance.now();
  const [head, ...rest] = command;
  if (head === undefined) {
    return refuse(
      'run() was called with an empty command, so there is no program to spawn',
      'pass the program as the first element: run(["bun", "test"], { cwd })',
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    return refuse(
      'run() was given a deadline that is not a positive finite number of milliseconds',
      'run(command, { cwd, timeoutMs: LONG_RUN_TIMEOUT_MS })   # a positive, finite number of milliseconds',
    );
  }
  const proc = Bun.spawn([head, ...rest], {
    cwd: options.cwd,
    env: { ...(options.env ?? Bun.env) },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  const stdout = drain(proc.stdout);
  const stderr = drain(proc.stderr);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), timeoutMs);
  });
  const settled = await Promise.race([Promise.all([stdout.done, stderr.done, proc.exited]), late]);
  clearTimeout(timer);
  const durationMs = Math.round(performance.now() - started);
  if (settled !== 'late') {
    const code = settled[2];
    return {
      command,
      code,
      ok: code === 0,
      output: joined([stdout.text(), stderr.text()]),
      durationMs,
      timedOut: false,
    };
  }
  proc.kill('SIGKILL');
  await Promise.all([stdout.cancel(), stderr.cancel()]);
  const timeout = new ScriptError({
    code: RUN_TIMEOUT_CODE,
    cause: `${command.join(' ')} did not finish within ${timeoutMs} ms and was killed — it, or a process it left holding its output, was still running`,
    fix: 'run(command, { cwd, timeoutMs: LONG_RUN_TIMEOUT_MS })   # when it legitimately runs longer; when it hung, ps -eo pid,ppid,etime,args shows what still holds its output',
  });
  return {
    command,
    code: null,
    ok: false,
    output: joined([timeout.message, stdout.text(), stderr.text()]),
    durationMs,
    timedOut: true,
  };
}

/**
 * The checkout, as a path the host opens. Never a URL's `pathname`: that percent-encodes a space
 * (`My%20Projects`) and answers `/C:/…` on Windows, and every gate script reads the tree from here.
 */
export const repoRoot = (): string => join(import.meta.dir, '..', '..');

/**
 * The budget for a test that walks the WHOLE repo — `collectSourceFiles(repoRoot())`,
 * `buildManifest(repoRoot())`, `collectErrorCodes(repoRoot())`, a `tsc -b` in a temp tree. Beside
 * `repoRoot()` because calling it is what makes a scan whole-repo, and because a plain number
 * keeps this file importable with no `node_modules` present, which `boundaries.ts` requires.
 *
 * Bun's default is 5000ms. That covered these scans while the suite ran serially and stopped the
 * moment `x test unit` began sharding across workers, because the shards compete for the same
 * cores. The scan IS the point of each of those tests, so the timeout is what moves — never the
 * scan. One constant rather than eleven copies of this paragraph, and for a reason measured
 * twice: the second round of failures happened because CI shards SIX ways while the local
 * reproduction used EIGHT, so a different test crossed the line each time and no local run had
 * ever seen the one that broke main. A per-site number is a per-site guess.
 *
 * 30s -> 90s on 2026-08-19, a third time and for a real reason rather than flake: the `errors`
 * step's fix scan now RESOLVES cross-file helpers (#157) and the `boundaries` step now reads every
 * file under `packages/cli/src` to check that a declared flag has a reader (#161). Both scans grew,
 * both are the point of their test, and each takes ~5s alone against ~30s under eight competing
 * workers. Raise this, never narrow a scan, and never delete a test for being slow.
 *
 * **90s -> 180s on 2026-08-27, and this time the number was not the finding.** Trialling the repo
 * on Bun 1.3.14 turned 21 of these tests red — every one a timeout, none a wrong answer — and that
 * runtime is only ~1.3x slower here (`x test unit`: 64s against 230s, same machine, same corpus,
 * back to back). `scripts/verify.test.ts` is the shape of it: **12.5s alone**, and it did not
 * finish inside 90s in the pool. A 7x stretch means the budget was never sized against contention,
 * only against the last runtime anyone measured, and a gate that passes only on the fastest Bun
 * anybody has run it on is a flake with a release date — free `ubuntu-latest` runners vary by more
 * than 1.3x on their own. The trial was refused for other reasons
 * (`.github/actions/setup/action.yml`); this half of what it found is a defect either way.
 *
 * The other half of the same finding: **six whole-tree scanners had never joined this convention**
 * and sat on Bun's 5000ms default — `config-readers`, `frozen-records`, `node-imports`,
 * `flight-copies`, `sql-literal-copies`, `framework-tables`, all of them written after the constant
 * was. They now call `setDefaultTimeout(REPO_SCAN_TIMEOUT_MS)` at module scope, which is the second
 * legal form and the better one where EVERY test in the file scans the tree; the per-test third
 * argument stays where only some do, because the comment beside it says which scan it is paying
 * for. `scripts/repo-scan-timeout.test.ts` refuses a `scripts/` test that reads the real tree and
 * declares neither — the reason those six drifted is that nothing was checking.
 */
export const REPO_SCAN_TIMEOUT_MS = 180_000;
