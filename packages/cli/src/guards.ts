// An app's own convention, made into a build error (axiom 3). A file in `guards/` exports one
// `guard`; the gate discovers the directory and runs each one inside the `boundaries` step, beside
// every guard the framework ships (`guards-built-in.ts`). The framework decides what a guard IS —
// a function returning findings, held to the error contract — and nothing about what it checks.

// why: Bun ships no equivalent for either: `join` builds the host-separator path, and
// `pathToFileURL` is the only spelling of an absolute path `import()` accepts on every host.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ERROR_DOCS_URL, renderCauseValue, renderThrowable } from '@ultimat3/core';
import { fixProblem } from './error-contract';
import { type GuardSources, guardSources } from './guard-sources';
import {
  type BuiltInMode,
  planBuiltIns,
  readShippedConfig,
  shippedConfigFindings,
  vendoredPath,
} from './guards-built-in';
import { materializeGuard } from './guards-materialize';
import { GUARD_DIR, guardDirState, guardPaths } from './guards-paths';

/** The app's guard directory and its files, defined in the leaf the manifest projection reads. */
export { GUARD_DIR, guardPaths } from './guards-paths';

import { vendoredCopy, vendoredFinding } from './guards-vendored';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';
import { readVerifyFloor } from './verify-floor';
import type { GuardBaseline } from './verify-guard-baseline';
import { guardNameOf, judgeGuardBaseline, orphanedBaselineFindings } from './verify-guard-baseline';

const compareNames = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A built-in sorts where its copy in `guards/` would have: the order an app always saw. */
const sortKey = (run: GuardRun): string =>
  run.mode === undefined ? run.path : `${GUARD_DIR}/${guardNameOf(run.path)}.ts`;

export interface Guard {
  /** What this app refuses, in one line. It names the rule when the guard itself is the problem. */
  readonly summary: string;
  /**
   * The rule, over the app root. Returns findings — it never prints, never decides an exit code
   * and never throws for a normal result, because `--json`, the step table and the exit code are
   * all projections of what it returns (axiom 2).
   *
   * `sources` is the run's ONE read of the app (`guard-sources.ts`): a guard that asks it for
   * files or a compiled stylesheet shares the walk, the read and the compile with every other
   * guard in the directory. A guard that reads something else — a migration, a lockfile — still
   * may, from `root`.
   */
  check(root: string, sources: GuardSources): Promise<readonly Finding[]> | readonly Finding[];
  /**
   * `'warning'`: REPORT ONLY. The findings it returns ride the step as warnings — listed in
   * `--json` and on the step line, never a failure — so a rule can ship to every app before the
   * apps are clean of it. Absent: every finding fails the gate. A finding that breaks the contract
   * is a failure either way, because a guard that fails open is the defect this seam refuses.
   */
  readonly severity?: 'warning';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isGuard = (value: unknown): value is Guard =>
  isRecord(value) &&
  typeof value['summary'] === 'string' &&
  value['summary'].trim() !== '' &&
  typeof value['check'] === 'function' &&
  (value['severity'] === undefined || value['severity'] === 'warning');

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

const notAGuard = (path: string, exported: unknown): Finding => {
  if (exported === undefined) {
    return invalid(
      path,
      `${path} exports no \`guard\`, so a file in ${GUARD_DIR}/ enforces nothing`,
    );
  }
  const severity = isRecord(exported) ? exported['severity'] : undefined;
  return invalid(
    path,
    severity !== undefined && severity !== 'warning'
      ? `${path} exports a \`guard\` whose severity is ${shown(severity)} — 'warning' (report only) is the one, or none to fail the gate`
      : `${path} exports a \`guard\` with no summary and no check()`,
  );
};

/** A file where `guards/` belongs: no crash, and not silence — the app's own rules are not running. */
const notADirectory: Finding = {
  code: 'X_GUARD_INVALID',
  cause: `${GUARD_DIR} is not a directory, so none of this app's own guards can run beside the shipped ones`,
  fix: `mv ${quoteArg(GUARD_DIR)} ${quoteArg(GUARD_DIR)}.txt && mkdir ${quoteArg(GUARD_DIR)} && x verify --only boundaries --json   # ${GUARD_DIR}/ is the directory the gate discovers; a rule of yours goes in it as ${GUARD_DIR}/<name>.ts`,
  docs: ERROR_DOCS_URL,
  at: GUARD_DIR,
};

const findingInvalid = (path: string, cause: string): Finding => ({
  code: 'X_GUARD_FINDING_INVALID',
  cause: `${path} returned a finding that is not one: ${cause}`,
  fix: `rewrite what ${path} returns as a code, a cause and a fix naming a command or a file, then: x verify`,
  docs: ERROR_DOCS_URL,
  at: path,
});

/** Same reason as `shown`: an app's guard may throw a value that fights every way of reading it. */
const messageOf = (error: unknown): string => renderThrowable(error);

/** What the gate does with a guard's findings: fail on `findings`, list `warnings`. */
export interface GuardReport {
  readonly findings: readonly Finding[];
  /** A report-only guard's findings, each held to the same contract. Never a failure. */
  readonly warnings: readonly Finding[];
}

const refused = (finding: Finding): GuardReport => ({ findings: [finding], warnings: [] });

/** A guard to run: what findings name it by, and the module that holds it. */
interface GuardRun {
  /** App-root-relative for the app's own; `@ultimat3/cli/guards/<name>.ts` for a built-in. */
  readonly path: string;
  /** The absolute module path `import()` reads; for a built-in, under `.x/cache/guards/`. */
  readonly file: string;
  /** A built-in's mode (`guards-built-in.ts`); absent for the app's own guard. */
  readonly mode?: BuiltInMode;
}

/** One guard: import it, run it, and hold what it returns to the contract. Never throws. */
async function runGuard(
  root: string,
  run: GuardRun,
  sources: GuardSources,
  baseline: GuardBaseline | undefined,
): Promise<GuardReport> {
  const report = await runGuardModule(root, run, sources, baseline);
  // A legacy app never had this built-in gate it: everything it says is a warning on `main`.
  return run.mode === 'legacy'
    ? { findings: [], warnings: [...report.findings, ...report.warnings] }
    : report;
}

async function runGuardModule(
  root: string,
  { path, file, mode }: GuardRun,
  sources: GuardSources,
  baseline: GuardBaseline | undefined,
): Promise<GuardReport> {
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(file).href);
  } catch (error) {
    return refused(failed(path, `${path} could not be imported: ${messageOf(error)}`));
  }
  const exported = isRecord(loaded) ? loaded['guard'] : undefined;
  if (!isGuard(exported)) return refused(notAGuard(path, exported));
  let returned: unknown;
  try {
    returned = await exported.check(root, sources);
  } catch (error) {
    return refused(failed(path, `${path} ("${exported.summary}") threw: ${messageOf(error)}`));
  }
  if (!Array.isArray(returned)) {
    return refused(
      findingInvalid(path, `check() answered ${typeof returned}, not a list of findings`),
    );
  }
  const broken: Finding[] = [];
  const held: Finding[] = [];
  for (const candidate of returned as readonly unknown[]) {
    // Reading a candidate can throw on its own — a getter that raises, a proxy that refuses — and
    // `findingProblem` is total only for values it can read. Per candidate, so one unreadable
    // entry costs its own line and not the readable findings beside it.
    try {
      const problem = findingProblem(candidate);
      if (problem !== undefined) broken.push(findingInvalid(path, problem));
      else held.push(findingOf(candidate as Record<string, unknown>, path));
    } catch (error) {
      broken.push(findingInvalid(path, `it could not be read: ${messageOf(error)}`));
    }
  }
  // The app's row (`guards/shipped.json`) over a built-in's own severity, either way.
  const reportOnly = mode === 'warning' || (mode !== 'error' && exported.severity === 'warning');
  if (reportOnly) return { findings: broken, warnings: held };
  // A gating guard under its `guardBaseline` (`verify-guard-baseline.ts`): a broken finding is
  // never counted against it — the contract fails either way.
  const judged = judgeGuardBaseline(path, held, baseline);
  return { findings: [...broken, ...judged.findings], warnings: judged.notices };
}

/**
 * Every guard this app declares, as findings the step it rides on adds to its own. Shaped as a
 * `HostCheck` because that is exactly the seam's shape — a rule the repo enforces on itself,
 * contributed to a step that already exists. A guard can never add, remove, reorder or skip a
 * step, which is what keeps "green" meaning one thing (axiom 5) while the app still gets to make
 * its own convention a build error.
 */
export const guardReport = async (
  root: string,
  /** Files the step already read (`guardSources`' seed), so no guard reads one a second time. */
  seed: readonly { readonly path: string; readonly source: string }[] = [],
): Promise<GuardReport> => {
  const findings: Finding[] = [];
  const warnings: Finding[] = [];
  const sources = guardSources(root, seed);
  // Read here, not passed in: every caller of this seam — the step, `x upgrade`'s measuring run —
  // judges the same committed counts, and a floor problem is the `manifest` step's to report.
  const baseline = (await readVerifyFloor(root))?.guardBaseline;
  const paths = await guardPaths(root);
  const config = await readShippedConfig(root);
  const { builtIn, vendored } = planBuiltIns(paths, config.severity);
  const runs: GuardRun[] = paths.map((path) => ({ path, file: join(root, path) }));
  for (const guard of builtIn) {
    runs.push({
      path: guard.display,
      file: await materializeGuard(root, guard.name),
      mode: guard.mode,
    });
  }
  // By guard name, so an app holding every shipped copy reports in the order it always did.
  runs.sort((a, b) => compareNames(sortKey(a), sortKey(b)));
  for (const run of runs) {
    const report = await runGuard(root, run, sources, baseline);
    findings.push(...report.findings);
    warnings.push(...report.warnings);
  }
  findings.push(...shippedConfigFindings(config.problems));
  if (guardDirState(root) === 'other') findings.push(notADirectory);
  findings.push(
    ...orphanedBaselineFindings(
      runs.map((run) => run.path),
      baseline,
    ),
  );
  for (const name of vendored) {
    const path = vendoredPath(paths, name) ?? `${GUARD_DIR}/${name}.ts`;
    const source = await Bun.file(join(root, path)).text();
    warnings.push(vendoredFinding(vendoredCopy(name, path, source)));
  }
  return { findings, warnings };
};

/** The findings that fail the gate; a report-only guard's are `guardReport`'s `warnings`. */
export const guardFindings = async (
  root: string,
  seed: readonly { readonly path: string; readonly source: string }[] = [],
): Promise<readonly Finding[]> => (await guardReport(root, seed)).findings;

/** A report-only finding as the one line the step lists it on. */
export const guardWarningLine = (finding: Finding): string =>
  `${finding.at === undefined ? '' : `${finding.at}: `}${finding.code} ${finding.cause} — fix: ${finding.fix}`;
