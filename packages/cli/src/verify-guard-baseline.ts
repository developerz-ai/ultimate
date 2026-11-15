// `guardBaseline` in `x.verify.json`: how many findings one guard may still report while the tree
// is brought under it. Up to the count they are notices; above it red. The count only falls: one
// above what the tree has is red too, naming the lower number, so slack is never banked.

import { ERROR_DOCS_URL, renderFixShellArg } from '@ultimat3/core';
import type { Finding } from './output';

/** The floor's per-guard baseline key. Named once: the problem quotes it and the fix repairs it. */
export const GUARD_BASELINE_FIELD = 'guardBaseline';

/** Over the baseline. A string here until the coordinator registers it in `error-codes.ts`. */
export const GUARD_OVER_BASELINE_CODE = 'X_GUARD_OVER_BASELINE';

/** Under the baseline. A string here until the coordinator registers it in `error-codes.ts`. */
export const GUARD_BASELINE_STALE_CODE = 'X_GUARD_BASELINE_STALE';

/** Guard name (its file in `guards/`, no extension) → the findings it may still report. */
export type GuardBaseline = Readonly<Record<string, number>>;

/** A guard's file stem: what `x g guard <name>` writes as `guards/<name>.ts`. */
const GUARD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `{ "<guard>": n }`, a file stem and a whole number at or above zero each, or the problems. */
export function readGuardBaseline(payload: Record<string, unknown> | undefined): {
  baseline?: GuardBaseline;
  problems: readonly string[];
} {
  const raw = payload?.[GUARD_BASELINE_FIELD];
  if (raw === undefined) return { problems: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { problems: [`"${GUARD_BASELINE_FIELD}" is not an object of { "<guard>": findings }`] };
  }
  const problems: string[] = [];
  const baseline = new Map<string, number>();
  for (const [name, n] of Object.entries(raw)) {
    if (!GUARD_NAME.test(name)) {
      problems.push(
        `"${GUARD_BASELINE_FIELD}" names ${JSON.stringify(name)}, not a guard file name`,
      );
    } else if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
      problems.push(
        `"${GUARD_BASELINE_FIELD}" gives ${name} ${JSON.stringify(n)}, which is not a whole number of findings`,
      );
    } else baseline.set(name, n);
  }
  return { ...(baseline.size === 0 ? {} : { baseline: Object.fromEntries(baseline) }), problems };
}

/** `guards/no-eval.ts` → `no-eval`: the key a baseline is written under. */
export const guardNameOf = (path: string): string =>
  (path.split('/').pop() ?? path).replace(/\.tsx?$/, '');

const allowedFor = (baseline: GuardBaseline | undefined, name: string): number | undefined =>
  baseline !== undefined && Object.hasOwn(baseline, name) ? baseline[name] : undefined;

const stale = (path: string, name: string, count: number, allowed: number): Finding => ({
  code: GUARD_BASELINE_STALE_CODE,
  cause: `${path} reports ${String(count)} finding(s) and x.verify.json "${GUARD_BASELINE_FIELD}" still allows ${String(allowed)}: the baseline only falls`,
  fix:
    count === 0
      ? `x verify --only boundaries --json   # then drop "${name}" from "${GUARD_BASELINE_FIELD}" in x.verify.json`
      : `x verify --only boundaries --json   # then lower your baseline to ${String(count)}: "${GUARD_BASELINE_FIELD}": { "${name}": ${String(count)} } in x.verify.json`,
  docs: ERROR_DOCS_URL,
  at: 'x.verify.json',
});

const over = (path: string, count: number, allowed: number): Finding => ({
  code: GUARD_OVER_BASELINE_CODE,
  cause: `${path} reports ${String(count)} finding(s) and x.verify.json "${GUARD_BASELINE_FIELD}" allows ${String(allowed)}`,
  fix: `x verify --only boundaries --json   # fix what ${renderFixShellArg(path, '<guard>')} lists until at most ${String(allowed)} remain — the baseline never rises`,
  docs: ERROR_DOCS_URL,
  at: path,
});

/**
 * One gating guard's findings against its baseline. No entry: every finding fails, as before.
 * At or under: they ride as notices, and under is the stale finding naming the number to write.
 * Over: they fail, with the finding that says by how much.
 */
export function judgeGuardBaseline(
  path: string,
  held: readonly Finding[],
  baseline: GuardBaseline | undefined,
): { readonly findings: readonly Finding[]; readonly notices: readonly Finding[] } {
  const name = guardNameOf(path);
  const allowed = allowedFor(baseline, name);
  if (allowed === undefined) return { findings: held, notices: [] };
  if (held.length > allowed) {
    return { findings: [...held, over(path, held.length, allowed)], notices: [] };
  }
  return {
    findings: held.length < allowed ? [stale(path, name, held.length, allowed)] : [],
    notices: held,
  };
}

/**
 * A baseline naming a guard this app no longer has holds slack for nothing: stale, at zero.
 * Judged over the run's own guard list, so a deleted guard cannot leave its count behind.
 */
export const orphanedBaselineFindings = (
  paths: readonly string[],
  baseline: GuardBaseline | undefined,
): readonly Finding[] => {
  const present = new Set(paths.map(guardNameOf));
  return Object.entries(baseline ?? {})
    .filter(([name]) => !present.has(name))
    .map(([name, allowed]) => stale(`guards/${name}.ts`, name, 0, allowed));
};
