// A value a tool THREW, read as a framework error (code, title, cause, fix) or rejected as a bug —
// and its rendering, byte-identical to `UltimateError.format()`. Split from `server.ts`, whose two
// dispatch paths (a flat `tools/call` and `manage_resource`) and resource reads all share it.
// Also what a REMOTE caller may read of it: a 5xx cause only when core's `hasPublicCause` says so.

import type { ErrorAudience } from '@ultimat3/core';
import {
  ERROR_DOCS_URL,
  FRAMEWORK_CODE,
  fixFor,
  hasPublicCause,
  isUltimateError,
  renderFixShellArg,
  singleLine,
  stringField,
} from '@ultimat3/core';
import { statusFor } from '@ultimat3/http';

export interface FrameworkError {
  readonly code: string;
  /** `''` for a foreign thrown object that carries no title. See `renderFrameworkError`. */
  readonly title: string;
  readonly cause: string;
  readonly fix: string;
  /** The remote caller's fix, when the error declared one (`UltimateErrorInit.callerFix`). */
  readonly callerFix?: string;
  /**
   * Where the reader goes next, ONLY when it is not the framework's one Error-Codes page — an app's
   * `docs://recipes/...` guide. The default page is the same URL on every error and names nothing
   * about this one, so it is not worth a line of an agent's context.
   */
  readonly docs?: string;
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
  // BRANDED only, for `@ultimat3/http`'s `factsOf` reason: `callerFix` and `docs` are lines an
  // agent is told to act on, and an `UltimateError` built them in this process. A foreign object's
  // are remote text.
  const branded = isUltimateError(error);
  const callerFix = branded ? stringField(error, 'callerFix') : undefined;
  const docs = branded ? stringField(error, 'docs') : undefined;
  return {
    code,
    title: stringField(error, 'title') ?? '',
    cause: stringField(error, 'cause') ?? 'unknown',
    // A substituted fix is still a fix an agent will act on, so it has to be runnable. `see docs`
    // named no docs and no command; `code` is already narrowed to an `X_` string by the guard
    // above, so the substitute is the one command that explains exactly this code.
    fix: stringField(error, 'fix') ?? `x errors explain ${code}`,
    ...(callerFix === undefined ? {} : { callerFix }),
    ...(docs === undefined || docs === '' || docs === ERROR_DOCS_URL ? {} : { docs }),
  };
}

/**
 * The fixed sentence a remote caller reads in place of a hidden cause. The real one is in the
 * audit line this call wrote and in the error monitor, never on the wire.
 */
export const HIDDEN_CAUSE =
  'the server failed while handling this call; the details are in this process\u2019s logs';

/**
 * What THIS audience may read of a thrown error — the verdict `@ultimat3/http`'s `toProblem` gives
 * the problem document, asked of the same two tables. A remote caller (`'caller'`) of a code whose
 * status is 5xx gets the cause only when core's `hasPublicCause` says so: `X_DB_STATEMENT_FAILED`
 * carries the server's message and the statement, and an MCP client is a remote client. The
 * developer's `fix` is withheld with it — a driver's fix is built from the same statement — and
 * `callerFix`, authored for the caller, still goes. `'developer'` (the dev server) keeps both, as
 * HTTP's `dev: true` does: the reader is the author fixing their own SQL.
 */
export function forAudience(error: FrameworkError, audience: ErrorAudience): FrameworkError {
  if (audience === 'developer') return error;
  if (statusFor(error.code) < 500 || hasPublicCause(error.code)) return error;
  const fix = `x errors explain ${renderFixShellArg(error.code, '<code>')} --json`;
  return { ...error, cause: HIDDEN_CAUSE, fix };
}

/**
 * The agent-readable form, BYTE-IDENTICAL to `UltimateError.format({ audience })` — plus
 * `{ docs: true }` when the error names a page of its own — so one denial reads the same over MCP
 * as it does in the terminal, and an agent that learned the shape from `x` does not have to learn a
 * second one here. Dropping the title would be a second rendering of the same contract, and the two
 * would drift.
 *
 * `audience` is the server's (`mcpServer({ errorAudience })`): an app's server answers remote
 * agents, who cannot run `x policy explain`, so it renders `callerFix` where the error has one.
 *
 * The bare-`code` head is the fallback for a foreign thrown object that carries `code`/`cause`
 * but no title; a real `UltimateError` always has one.
 */
export function renderFrameworkError(
  error: FrameworkError,
  audience: ErrorAudience = 'developer',
): string {
  const head =
    error.title === ''
      ? singleLine(error.code)
      : `${singleLine(error.code)}: ${singleLine(error.title)}`;
  const shown = forAudience(error, audience);
  const lines = [
    head,
    `  cause: ${singleLine(shown.cause)}`,
    `  fix:   ${singleLine(fixFor(shown, audience))}`,
  ];
  if (error.docs !== undefined) lines.push(`  docs:  ${singleLine(error.docs)}`);
  return lines.join('\n');
}
