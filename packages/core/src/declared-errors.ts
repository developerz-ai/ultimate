// Single responsibility: an action's or a query's `errors:` list — what may be listed, which throw
// out of a handler the list judges, and what a test run and a production run do with a miss. Here
// and not in `@ultimat3/action` because `@ultimat3/query` needs the same rule and tiers never go
// sideways; the HTTP status is passed in because `@ultimat3/http` sits above this package.

import { FRAMEWORK_CODE } from './client-wire';
import { tryResolveEnvironment } from './environment';
import { renderCauseValue } from './error-render';
import { isUltimateError, UltimateError } from './errors';
import { logger } from './logger';
import { counter } from './metrics';

/** The status a code answers, `undefined` when nothing declared one: `@ultimat3/http`'s reader. */
export type ErrorStatusOf = (code: string) => number | undefined;

/** Which declaration a verdict is about — the two primitives that carry `errors:`. */
export interface DeclaredErrorsOwner {
  readonly primitive: 'action' | 'query';
  readonly name: string;
}

/**
 * The process's lifetime, never a refusal a handler chose: a drain or an abort reaches every
 * handler alike, so listing them on each would be a list nobody could keep true.
 */
export const LIFETIME_ERROR_CODES: readonly string[] = ['X_ABORTED', 'X_DRAINING'];

/** `open` — no list declared; `exempt` — not a contract member; else the list's answer. */
export type DeclaredErrorVerdict = 'open' | 'exempt' | 'declared' | 'undeclared';

/** Is `status` a refusal the caller can branch on? A 5xx or no status is an outage. */
const isRefusal = (status: number | undefined): boolean =>
  status !== undefined && status >= 400 && status <= 499;

/** The one judgement both halves make: the dynamic wrap and the contract's source scan. */
export function judgeThrown(
  declared: readonly string[] | undefined,
  code: string,
  status: number | undefined,
): DeclaredErrorVerdict {
  if (declared === undefined) return 'open';
  if (LIFETIME_ERROR_CODES.includes(code) || !isRefusal(status)) return 'exempt';
  return declared.includes(code) ? 'declared' : 'undeclared';
}

export class ErrorUndeclaredError extends UltimateError {
  static readonly code = 'X_ERROR_UNDECLARED';
  override readonly name = 'ErrorUndeclaredError';
  constructor(owner: DeclaredErrorsOwner, code: string, sourceError?: unknown) {
    super({
      code: ErrorUndeclaredError.code,
      cause: `${owner.primitive} ${owner.name} threw ${code}, which its errors: list does not declare`,
      fix: `errors: [ …, '${code}' ]   # add it in the ${owner.name} definition, or stop throwing it there; then: x verify --only contract`,
      meta: { primitive: owner.primitive, name: owner.name, undeclared: code },
      sourceError,
    });
  }
}

export class ActionErrorsInvalidError extends UltimateError {
  static readonly code = 'X_ACTION_ERRORS_INVALID';
  override readonly name = 'ActionErrorsInvalidError';
  constructor(owner: string, listed: unknown, why: string) {
    const shown = renderCauseValue(listed);
    const code = typeof listed === 'string' && FRAMEWORK_CODE.test(listed) ? listed : '<CODE>';
    super({
      code: ActionErrorsInvalidError.code,
      cause: `errors: in ${owner} lists ${shown}, which ${why}`,
      fix: `defineError({ code: '${code}', title, status: 4xx, cause, fix })   # import it where ${owner} is declared, list its .code once; x errors explain ${code} --json`,
      meta: { owner, listed: shown },
    });
  }
}

/**
 * The list as written, refused where it is written: malformed, unregistered, not a 4xx, or
 * repeated. Answers a frozen, sorted copy — what the descriptor, the manifest and the OpenAPI
 * document publish — so a caller mutating the literal it passed changes nothing that was checked.
 */
export function checkDeclaredErrors(
  errors: readonly string[],
  statusOf: ErrorStatusOf,
  owner: string,
): readonly string[];
export function checkDeclaredErrors(
  errors: readonly string[] | undefined,
  statusOf: ErrorStatusOf,
  owner: string,
): readonly string[] | undefined;
export function checkDeclaredErrors(
  errors: readonly string[] | undefined,
  statusOf: ErrorStatusOf,
  owner: string,
): readonly string[] | undefined {
  if (errors === undefined) return undefined;
  if (!Array.isArray(errors)) throw new ActionErrorsInvalidError(owner, errors, 'is not an array');
  const seen = new Set<string>();
  for (const code of errors as readonly unknown[]) {
    if (typeof code !== 'string' || !FRAMEWORK_CODE.test(code)) {
      throw new ActionErrorsInvalidError(owner, code, 'is not an X_SCREAMING_SNAKE code');
    }
    if (seen.has(code)) throw new ActionErrorsInvalidError(owner, code, 'is listed twice');
    const status = statusOf(code);
    if (!isRefusal(status)) {
      throw new ActionErrorsInvalidError(
        owner,
        code,
        status === undefined ? 'has no registered HTTP status' : `answers ${status}, not a 4xx`,
      );
    }
    seen.add(code);
  }
  return Object.freeze([...seen].sort());
}

const undeclaredErrors = counter('undeclared_errors_total', {
  unit: '{error}',
  description: 'Refusals a handler threw outside its declared errors: list, by primitive and name',
});

/**
 * Where a test or a dev run goes red. Anything that is not literally `test` or `development` —
 * an unset environment included — takes the production branch: a bookkeeping miss must never turn
 * a refusal into a 500 in front of a user.
 */
const raisesUndeclared = (): boolean => {
  const environment = tryResolveEnvironment({ fallback: 'production' });
  return environment === 'test' || environment === 'development';
};

/** The (primitive, name, code) triples already warned about in this process. */
const WARNED = new Set<string>();

/**
 * What to throw in place of `error`, a throw out of a handler. The original, unless it is a 4xx
 * code the list does not name: then `X_ERROR_UNDECLARED` in test and development (the
 * original as its `sourceError`), and the original with a warning and a count in production.
 */
export function enforceDeclared(
  error: unknown,
  declared: readonly string[] | undefined,
  statusOf: ErrorStatusOf,
  owner: DeclaredErrorsOwner,
): unknown {
  if (declared === undefined || !isUltimateError(error)) return error;
  const { code } = error;
  if (judgeThrown(declared, code, statusOf(code)) !== 'undeclared') return error;
  if (raisesUndeclared()) return new ErrorUndeclaredError(owner, code, error);
  undeclaredErrors.add(1, { primitive: owner.primitive, name: owner.name, code });
  // One line per (primitive, name, code) per process: a hot endpoint is counted on every hit and
  // logged once, never a line per request. The key space is bounded by the codebase.
  const key = `${owner.primitive}\u0000${owner.name}\u0000${code}`;
  if (!WARNED.has(key)) {
    WARNED.add(key);
    logger.warn('declared-errors.undeclared', { ...owner, code });
  }
  return error;
}

/** Run a handler under its list: the wrap `invoke` and the read path put around `handle`/`sql`. */
export async function withDeclaredErrors<T>(
  declared: readonly string[] | undefined,
  statusOf: ErrorStatusOf,
  owner: DeclaredErrorsOwner,
  run: () => T | Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw enforceDeclared(error, declared, statusOf, owner);
  }
}

/**
 * A tool's description, ending with the refusals its declaration lists — so an agent plans around
 * a refusal before it calls. One sentence for `@ultimat3/mcp`'s tool and `@ultimat3/ai`'s, which
 * the tier table keeps apart (`scripts/ai-mcp-tool-parity.test.ts`). Unchanged without a list.
 */
export function describeDeclaredErrors(
  description: string,
  errors: readonly string[] | undefined,
): string {
  if (errors === undefined || errors.length === 0) return description;
  return `${description} Declared refusals: ${errors.join(', ')}.`;
}
