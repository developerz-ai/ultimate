// An app's own convention, made into a build error (axiom 3). A file in `guards/` exports one
// `guard`; the gate discovers the directory and runs each one inside the `boundaries` step. The
// framework decides what a guard IS — a function returning findings, held to the error contract —
// and nothing about what a guard may check.

// Bun ships no equivalent for either: `existsSync` answers whether this app has a guards
// directory, `join` builds the host-separator path, and `pathToFileURL` is the only spelling of an
// absolute path `import()` accepts on every host.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ERROR_DOCS_URL, renderCauseValue, renderThrowable } from '@ultimat3/core';
import { fixProblem } from './error-contract';
import type { Finding } from './output';
import type { HostCheck } from './verify-step';

/** The directory IS the registration. An app-side list is a list an app can forget to add to. */
export const GUARD_DIR = 'guards';

export interface Guard {
  /** What this app refuses, in one line. It names the rule when the guard itself is the problem. */
  readonly summary: string;
  /**
   * The rule, over the app root. Returns findings — it never prints, never decides an exit code
   * and never throws for a normal result, because `--json`, the step table and the exit code are
   * all projections of what it returns (axiom 2).
   */
  check(root: string): Promise<readonly Finding[]> | readonly Finding[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isGuard = (value: unknown): value is Guard =>
  isRecord(value) &&
  typeof value['summary'] === 'string' &&
  value['summary'].trim() !== '' &&
  typeof value['check'] === 'function';

const CODE = /^X_[A-Z0-9_]+$/;

/**
 * A value named in a cause, without ever throwing to name it — the one thing this validator may
 * never do is fail while it is explaining a failure, because then a bug in an app's guard reaches
 * its author as a stack trace out of framework internals. The rendering itself is
 * `@ultimat3/core`'s `renderCauseValue`: the local copy this used to hold called `String(value)` on
 * an unnarrowed `unknown`, so a guard returning an object with a throwing `toString` destroyed the
 * refusal — the case a scan over `String(` cannot see, because the call is one helper away.
 * The `typeof` prefix stays: "object null" and "number 42" say what a bare literal does not.
 */
const shown = (value: unknown): string =>
  typeof value === 'string' ? `"${value}"` : `${typeof value} ${renderCauseValue(value)}`;

/**
 * Why a returned value is not a finding, or `undefined` when it is one. The `fix:` half is
 * `fixProblem` — the identical rule `x verify`'s `errors` step applies to every shipped `fix:` in
 * the framework — because a mechanism for producing errors that are not instructions is worse than
 * no mechanism. It runs on the returned value rather than on the source, which is the half a
 * static scan cannot reach: a `fix` assembled at run time has no literal to read.
 */
export function findingProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return `${shown(value)} is not a finding object`;
  const code = value['code'];
  if (typeof code !== 'string' || !CODE.test(code)) {
    return `${shown(code)} is not an X_SCREAMING_SNAKE code, so nothing can explain it`;
  }
  const cause = value['cause'];
  if (typeof cause !== 'string' || cause.trim() === '') return `${code} states no cause`;
  const fix = value['fix'];
  if (typeof fix !== 'string') return `${code} carries no fix line`;
  return fixProblem(fix);
}

/** Only what a finding may carry, so a guard cannot smuggle fields the renderers never show. */
function findingOf(value: Record<string, unknown>, at: string): Finding {
  const docs = value['docs'];
  const located = value['at'];
  return {
    code: value['code'] as string,
    cause: value['cause'] as string,
    fix: value['fix'] as string,
    ...(typeof docs === 'string' ? { docs } : {}),
    at: typeof located === 'string' && located !== '' ? located : at,
  };
}

/**
 * Every guard file, app-root-relative and sorted, so two machines report the same findings in the
 * same order. A `*.test.ts` beside a guard is its test, never a second guard — the generator emits
 * one, and importing it would run the suite inside the gate.
 */
export async function guardPaths(root: string): Promise<readonly string[]> {
  const dir = join(root, GUARD_DIR);
  if (!existsSync(dir)) return [];
  const paths: string[] = [];
  for await (const entry of new Bun.Glob('*.{ts,tsx}').scan({ cwd: dir, absolute: false })) {
    const path = entry.split('\\').join('/');
    if (/\.(?:test|d)\.tsx?$/.test(path)) continue;
    paths.push(`${GUARD_DIR}/${path}`);
  }
  return paths.sort();
}

const failed = (path: string, cause: string): Finding => ({
  code: 'X_GUARD_FAILED',
  cause,
  fix: `return a finding from ${path} instead of throwing, then: x verify`,
  docs: ERROR_DOCS_URL,
  at: path,
});

const invalid = (path: string, cause: string): Finding => ({
  code: 'X_GUARD_INVALID',
  cause,
  fix: `export a \`guard\` object — { summary, check } — from ${path}, then: x verify`,
  docs: ERROR_DOCS_URL,
  at: path,
});

const findingInvalid = (path: string, cause: string): Finding => ({
  code: 'X_GUARD_FINDING_INVALID',
  cause: `${path} returned a finding that is not one: ${cause}`,
  fix: `rewrite what ${path} returns as a code, a cause and a fix naming a command or a file, then: x verify`,
  docs: ERROR_DOCS_URL,
  at: path,
});

/** Same reason as `shown`: an app's guard may throw a value that fights every way of reading it. */
const messageOf = (error: unknown): string => renderThrowable(error);

/** One guard: import it, run it, and hold what it returns to the contract. Never throws. */
async function runGuard(root: string, path: string): Promise<readonly Finding[]> {
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(join(root, path)).href);
  } catch (error) {
    return [failed(path, `${path} could not be imported: ${messageOf(error)}`)];
  }
  const exported = isRecord(loaded) ? loaded['guard'] : undefined;
  if (!isGuard(exported)) {
    return [
      invalid(
        path,
        exported === undefined
          ? `${path} exports no \`guard\`, so a file in ${GUARD_DIR}/ enforces nothing`
          : `${path} exports a \`guard\` with no summary and no check()`,
      ),
    ];
  }
  let returned: unknown;
  try {
    returned = await exported.check(root);
  } catch (error) {
    return [failed(path, `${path} ("${exported.summary}") threw: ${messageOf(error)}`)];
  }
  if (!Array.isArray(returned)) {
    return [findingInvalid(path, `check() answered ${typeof returned}, not a list of findings`)];
  }
  const findings: Finding[] = [];
  for (const candidate of returned as readonly unknown[]) {
    // Reading a candidate can throw on its own — a getter that raises, a proxy that refuses — and
    // `findingProblem` is total only for values it can read. Per candidate, so one unreadable
    // entry costs its own line and not the readable findings beside it.
    try {
      const problem = findingProblem(candidate);
      if (problem !== undefined) findings.push(findingInvalid(path, problem));
      else findings.push(findingOf(candidate as Record<string, unknown>, path));
    } catch (error) {
      findings.push(findingInvalid(path, `it could not be read: ${messageOf(error)}`));
    }
  }
  return findings;
}

/**
 * Every guard this app declares, as findings the step it rides on adds to its own. Typed as a
 * `HostCheck` because that is exactly the seam's shape — a rule the repo enforces on itself,
 * contributed to a step that already exists. A guard can never add, remove, reorder or skip a
 * step, which is what keeps "green" meaning one thing (axiom 5) while the app still gets to make
 * its own convention a build error.
 */
export const guardFindings: HostCheck = async (root) => {
  const findings: Finding[] = [];
  for (const path of await guardPaths(root)) findings.push(...(await runGuard(root, path)));
  return findings;
};
