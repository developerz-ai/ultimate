// The single subprocess boundary for the CLI. Every shell-out goes through `exec` so timing,
// output capture and the "command not found" failure mode are identical everywhere, and so a
// test can substitute a fake runner instead of spawning anything.

// `UltimateError` straight from core rather than a class in `./errors`: this module is imported by
// every command, and `./errors` runs `registerErrorCodes` on import — a subprocess boundary must
// not decide when the CLI's registry is populated. `X_CLI_UNEXPECTED` is owned there all the same.
import { renderThrowable, UltimateError } from '@ultimat3/core';
// `shell-quote.ts` is a leaf — it imports nothing, so the subprocess boundary stays importable
// from anywhere, this file's header rule about a single boundary included.
import { quoteArg } from './shell-quote';

export interface ExecResult {
  readonly command: readonly string[];
  readonly code: number;
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface ExecOptions {
  readonly cwd: string;
  /**
   * Overlaid onto `Bun.env`, key by key: a string sets/overrides it for the child, and
   * `undefined` UNSETS it — the child does not inherit it at all, even though the parent has it.
   * The delete case exists for one caller (`test-dotenv.ts`'s `testEnvOverrides`, spent by
   * `test-shards.ts`/`verify-tests.ts`/`verify-test-run.ts`/`mcp-host.ts`): a `bun test` child
   * must not inherit a key that reached the parent only through Bun auto-loading
   * `.env.development`. A merge that only ever adds or overrides (`{ ...Bun.env, ...env }`) cannot
   * express that — `Bun.env` is always the base, so a key just absent from `env` survives from it.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string;
}

export type Runner = (command: readonly string[], options: ExecOptions) => Promise<ExecResult>;

/** performance.now(), not Date.now(): the test preload freezes the wall clock on purpose. */
const now = (): number => performance.now();

/**
 * The failure mode this file's header already promised was identical everywhere, and the one it
 * never coded. `x deploy` on a machine without `docker` threw Bun's own `Error: Executable not
 * found in $PATH`; `dispatch.ts` rendered it as `X_CLI_UNEXPECTED` with `fix: x doctor --json`,
 * and `runDoctor` checks nothing about an absent binary — an instruction that cannot close the
 * error is axiom 4 inverted. The code stays `X_CLI_UNEXPECTED` (the CLI already owns it for a
 * failure of its own machinery); what changes is that the fix names the program to install.
 *
 * The program name goes through `quoteArg` at BOTH references: `docker compose` or any name a
 * shell would resplit produced a `fix:` that runs something else, which is axiom 4 inverted twice
 * in one line.
 *
 * The thrown value goes through core's render helper and is never interpolated: an `unknown`
 * reaching a `cause:` through `${…}` is what `bun run error-render` refuses, and this one is
 * genuinely unknown — Bun raises `ENOENT` for a missing program, `EACCES` for an unrunnable one.
 *
 * The return type is inferred so this stays one statement of `Bun.spawn`'s own shape.
 */
/**
 * `Bun.env` overlaid with `overrides`, an `undefined` value deleting the key rather than setting
 * it to the string `"undefined"` — see `ExecOptions.env`'s own comment for why a delete has to be
 * expressible here at all.
 */
function mergedEnv(
  overrides: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  // A `Map`, not an object indexed by `key`: the keys are DATA (environment variable names), and
  // a plain-object table read or deleted by a computed key is the `Object.prototype` hazard
  // `scripts/proto-index.ts` ratchets. `Object.fromEntries` builds the record once, at the end.
  const merged = new Map<string, string>();
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value !== undefined) merged.set(key, value);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) merged.delete(key);
    else merged.set(key, value);
  }
  return Object.fromEntries(merged);
}

function spawnOrRefuse(command: readonly string[], options: ExecOptions) {
  const [head = '', ...rest] = command;
  try {
    return Bun.spawn([head, ...rest], {
      cwd: options.cwd,
      env: options.env === undefined ? Bun.env : mergedEnv(options.env),
      stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (error) {
    throw new UltimateError({
      code: 'X_CLI_UNEXPECTED',
      cause: `the CLI could not run "${head}" from ${options.cwd}: ${renderThrowable(error)}`,
      fix: `install ${quoteArg(head)} and put it on PATH, then re-run — confirm with: command -v ${quoteArg(head)}`,
    });
  }
}

export const exec: Runner = async (command, options) => {
  const started = now();
  const [head, ...rest] = command;
  // A caller bug, never a user's: an empty argv reaches `Bun.spawn` as "spawn nothing" and there is
  // no shell-out to report on. Coded like every other CLI failure, because a bare Error here would
  // surface as an unexplained crash from the one boundary every command goes through.
  if (head === undefined) {
    throw new UltimateError({
      code: 'X_CLI_UNEXPECTED',
      cause: 'exec() was called with an empty command, so there is no program to spawn',
      fix: 'pass the program as the first element: exec(["bun", "test"], { cwd })',
    });
  }
  const proc = spawnOrRefuse([head, ...rest], options);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    command,
    code,
    ok: code === 0,
    stdout,
    stderr,
    durationMs: Math.round(now() - started),
  };
};

/** Merged stream, trimmed — what a human wants to read under a failed step. */
export const execOutput = (result: ExecResult): string =>
  [result.stdout, result.stderr]
    .filter((part) => part.trim().length > 0)
    .join('\n')
    .trimEnd();
