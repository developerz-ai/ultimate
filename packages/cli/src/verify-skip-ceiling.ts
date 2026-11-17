// `skipCeiling` in `x.verify.json`: how many tests a step may skip before the gate stops calling it
// a run. The floor refuses a step that ran NOTHING; a step that ran 8 of 17 behind
// `skipIf(!process.env.TYPO)` was green. Judged where the verdict is (CI, and `x verify merge`),
// never on a laptop without services, which stays a dev loop.

import { ERROR_DOCS_URL, renderFixShellArg } from '@ultimat3/core';
import type { Finding } from './output';
import type { TestCounts } from './test-counts';

/** The floor's skip-ceiling key. Named once: the problem quotes it and the fix repairs it. */
export const SKIP_CEILING_FIELD = 'skipCeiling';

/** Step name → the most tests it may skip. */
export type SkipCeiling = Readonly<Record<string, number>>;

/** `{ "<step>": n }`, a whole number at or above zero per step the gate runs, or the problems. */
export function readSkipCeiling(
  payload: Record<string, unknown> | undefined,
  declared: readonly string[],
): { ceiling?: SkipCeiling; problems: readonly string[] } {
  const raw = payload?.[SKIP_CEILING_FIELD];
  if (raw === undefined) return { problems: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { problems: [`"${SKIP_CEILING_FIELD}" is not an object of { "<step>": tests }`] };
  }
  const problems: string[] = [];
  const ceiling = new Map<string, number>();
  for (const [step, n] of Object.entries(raw)) {
    if (!declared.includes(step)) {
      problems.push(`"${SKIP_CEILING_FIELD}" names ${step}, which x verify does not run`);
    } else if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
      problems.push(
        `"${SKIP_CEILING_FIELD}" gives ${step} ${JSON.stringify(n)}, which is not a whole number of tests`,
      );
    } else ceiling.set(step, n);
  }
  return {
    ...(ceiling.size === 0 ? {} : { ceiling: Object.fromEntries(ceiling) }),
    problems,
  };
}

/** `CI` as GitHub, GitLab and most runners set it; `false`/`0`/empty is a laptop that said so. */
export const inCi = (env: Readonly<Record<string, string | undefined>>): boolean => {
  const value = env['CI'];
  return value !== undefined && value !== '' && value !== 'false' && value !== '0';
};

const ceilingOf = (ceiling: SkipCeiling | undefined, step: string): number | undefined =>
  ceiling !== undefined && Object.hasOwn(ceiling, step) ? ceiling[step] : undefined;

/**
 * The verdict on one step's counts — the whole run's, or the merged shards'. Over the ceiling is a
 * finding; under it nothing; no ceiling and something skipped is a WARNING naming the number to
 * write, since a new app holds nothing yet and a gate must not invent the bar.
 */
export function judgeSkips(
  step: string,
  tests: TestCounts | undefined,
  ceiling: SkipCeiling | undefined,
): { readonly findings: readonly Finding[]; readonly warnings: readonly string[] } {
  if (tests === undefined || tests.ran === 0) return { findings: [], warnings: [] };
  const allowed = ceilingOf(ceiling, step);
  if (allowed === undefined) {
    return tests.skipped === 0
      ? { findings: [], warnings: [] }
      : {
          findings: [],
          warnings: [
            `${step} skipped ${String(tests.skipped)} of ${String(tests.ran + tests.skipped)} test(s): hold it with "${SKIP_CEILING_FIELD}": { "${step}": ${String(tests.skipped)} } in x.verify.json`,
          ],
        };
  }
  if (tests.skipped <= allowed) return { findings: [], warnings: [] };
  return {
    findings: [
      {
        code: 'X_VERIFY_SKIPS_OVER_CEILING',
        cause: `the ${step} step skipped ${String(tests.skipped)} test(s) and ran ${String(tests.ran)}; x.verify.json "${SKIP_CEILING_FIELD}" allows ${String(allowed)}`,
        fix: `x test ${renderFixShellArg(step, '<step>')} --json   # then set what the skipped tests need, or raise "${SKIP_CEILING_FIELD}" for ${step} in x.verify.json with the reason in the diff`,
        docs: ERROR_DOCS_URL,
        at: 'x.verify.json',
      },
    ],
    warnings: [],
  };
}
