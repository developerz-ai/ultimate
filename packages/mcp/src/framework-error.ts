// A value a tool THREW, read as a framework error (code, title, cause, fix) or rejected as a bug —
// and its rendering, byte-identical to `UltimateError.format()`. Split from `server.ts`, whose two
// dispatch paths (a flat `tools/call` and `manage_resource`) and resource reads all share it.

import { FRAMEWORK_CODE, singleLine, stringField } from '@ultimat3/core';

export interface FrameworkError {
  readonly code: string;
  /** `''` for a foreign thrown object that carries no title. See `renderFrameworkError`. */
  readonly title: string;
  readonly cause: string;
  readonly fix: string;
}

/**
 * Read a thrown framework error, or `undefined` when it is not one (a genuine bug, which
 * becomes `-32603` with no internals leaked). Structural rather than `instanceof`: the
 * transport must stay independent of which package threw.
 */
export function asFrameworkError(error: unknown): FrameworkError | undefined {
  // `stringField` from `@ultimat3/core`, never `typeof e.code === 'string'`: the value is whatever
  // an app's handler, its driver or its SDK threw, so each read is a getter call or a `Proxy`
  // trap. This runs inside the catch block that owes the caller an answer, and a probe that
  // raises here leaves the JSON-RPC request with no response at all — not even the `-32603` the
  // header promises for a genuine bug.
  const code = stringField(error, 'code');
  // `FRAMEWORK_CODE`, never `startsWith('X_')`: the substituted `fix:` below interpolates this
  // value into a COMMAND an agent is told to run, and `X_$(id)` passes a prefix test. A code is
  // `X_SCREAMING_SNAKE` and nothing else, so a value that is not one is not a framework error —
  // it takes the `-32603` branch, which leaks nothing of the throw.
  if (code === undefined || !FRAMEWORK_CODE.test(code)) return undefined;
  return {
    code,
    title: stringField(error, 'title') ?? '',
    cause: stringField(error, 'cause') ?? 'unknown',
    // A substituted fix is still a fix an agent will act on, so it has to be runnable. `see docs`
    // named no docs and no command; `code` is already narrowed to an `X_` string by the guard
    // above, so the substitute is the one command that explains exactly this code.
    fix: stringField(error, 'fix') ?? `x errors explain ${code}`,
  };
}

/**
 * The agent-readable form, BYTE-IDENTICAL to `UltimateError.format()` — one denial reads the
 * same over MCP as it does in the terminal, so an agent that learned the shape from `x` does
 * not have to learn a second one here. Dropping the title would be a second rendering of the
 * same contract, and the two would drift.
 *
 * The bare-`code` head is the fallback for a foreign thrown object that carries `code`/`cause`
 * but no title; a real `UltimateError` always has one.
 */
export function renderFrameworkError(error: FrameworkError): string {
  const head =
    error.title === ''
      ? singleLine(error.code)
      : `${singleLine(error.code)}: ${singleLine(error.title)}`;
  return `${head}\n  cause: ${singleLine(error.cause)}\n  fix:   ${singleLine(error.fix)}`;
}
