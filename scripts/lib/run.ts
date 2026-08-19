// The single subprocess boundary for the root scripts. One implementation, so every script times,
// captures and reports a command the same way.

import { ScriptError } from './script-error';

export interface RunResult {
  readonly command: readonly string[];
  readonly code: number;
  readonly ok: boolean;
  readonly output: string;
  readonly durationMs: number;
}

export async function run(
  command: readonly string[],
  options: { readonly cwd: string } = { cwd: process.cwd() },
): Promise<RunResult> {
  const started = performance.now();
  const [head, ...rest] = command;
  // A caller bug, never a user's — `packages/cli/src/exec.ts` makes the identical guard at the
  // identical seam, and for the identical reason: a bare `Error` from the one boundary every
  // script goes through surfaces as an unexplained crash with no code and no `fix:`.
  if (head === undefined) {
    throw new ScriptError({
      code: 'X_CLI_UNEXPECTED',
      cause: 'run() was called with an empty command, so there is no program to spawn',
      fix: 'pass the program as the first element: run(["bun", "test"], { cwd })',
    });
  }
  const proc = Bun.spawn([head, ...rest], {
    cwd: options.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    command,
    code,
    ok: code === 0,
    output: [stdout, stderr]
      .filter((part) => part.trim().length > 0)
      .join('\n')
      .trimEnd(),
    durationMs: Math.round(performance.now() - started),
  };
}

export const repoRoot = (): string => new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

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
 */
export const REPO_SCAN_TIMEOUT_MS = 90_000;
