// The enforcement half of `scripts/budget-raises.ts`, run by the gate's `unit` step like every
// `scripts/**/*.test.ts`. Every case is a before/after pair of route source, so the rule is proved
// without a commit; the real tree is read once, against origin/main's tip, at the bottom.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  BASE_REF,
  baseRef,
  budgetResult,
  checkBudgetRaises,
  FETCH_MAIN,
  raiseFinding,
  readBudget,
  readRouteVersions,
} from './budget-raises';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree or spawns real processes, so it runs on the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const PATH = 'examples/app/apps/web/app/settings/page.tsx';
const route = (budget: string, above = ''): string =>
  `export const config = defineRoute({\n  render: 'csr',\n${above}  budget: ${budget},\n});\n`;
const raises = (base: string, now: string) =>
  checkBudgetRaises([{ path: PATH, base, now }]).map(
    (raise) => `${raise.key}:${raise.was}->${raise.now}`,
  );

describe('reading a route budget', () => {
  test('bytes through the one parser, lcp as a number, and the line of the key', () => {
    expect(readBudget(route("{ js: '20kb', lcp: 1800 }"))).toEqual({
      line: 3,
      js: { written: '20kb', bytes: 20480 },
      lcp: 1800,
    });
    expect(readBudget(route('{ lcp: 1500 }'))).toEqual({ line: 3, lcp: 1500 });
  });

  test('a budget quoted inside a string or a comment is not the route`s', () => {
    expect(readBudget(`const docs = [{ text: "  budget: { js: '0kb' }," }];\n`)).toBeUndefined();
    expect(readBudget("// budget: { js: '9kb' }\nexport const x = 1;\n")).toBeUndefined();
  });
});

describe('a raise must state its number and its reason', () => {
  test('a js raise with nothing above it is reported, with the edit and the old value', () => {
    expect(raises(route("{ js: '16kb' }"), route("{ js: '20kb' }"))).toEqual(['js:16kb->20kb']);
    const [raise] = checkBudgetRaises([
      { path: PATH, base: route("{ js: '16kb' }"), now: route("{ js: '20kb' }") },
    ]);
    const finding = raiseFinding(raise ?? expect.unreachable('no raise'), '98d16d84');
    expect(finding.code).toBe('X_BUDGET_RAISE_UNSTATED');
    expect(finding.at).toBe(`${PATH}:3`);
    expect(finding.fix).toContain('// measured: <N> B');
    expect(finding.fix).toContain('restore js: 16kb');
  });

  test('a comment directly above carrying measured: N B and why: states it', () => {
    const stated =
      "  // measured: 19,874 B (bun run x -- build --json) — why: the settings form's typed client\n";
    expect(raises(route("{ js: '16kb' }"), route("{ js: '20kb' }", stated))).toEqual([]);
  });

  test('a number with no reason, a reason with no number, or a blank line between, does not', () => {
    const blank = '  // measured: 19874 B — why: the form\n\n';
    expect(
      raises(route("{ js: '16kb' }"), route("{ js: '20kb' }", '  // measured: 19874 B\n')),
    ).toHaveLength(1);
    expect(
      raises(route("{ js: '16kb' }"), route("{ js: '20kb' }", '  // why: the form\n')),
    ).toHaveLength(1);
    expect(raises(route("{ js: '16kb' }"), route("{ js: '20kb' }", blank))).toHaveLength(1);
  });

  test('an lcp raise is stated in milliseconds, not bytes', () => {
    const inBytes = '  // measured: 2100 B — why: a hero image\n';
    const inMs = '  // measured: 2100 ms — why: a hero image\n';
    expect(raises(route('{ lcp: 1800 }'), route('{ lcp: 2200 }', inBytes))).toEqual([
      'lcp:1800->2200',
    ]);
    expect(raises(route('{ lcp: 1800 }'), route('{ lcp: 2200 }', inMs))).toEqual([]);
  });

  test('a lower, equal-in-bytes or brand-new budget is not a raise', () => {
    expect(raises(route("{ js: '20kb' }"), route("{ js: '16kb' }"))).toEqual([]);
    expect(raises(route("{ js: '20kb' }"), route("{ js: '20480b' }"))).toEqual([]);
    expect(
      checkBudgetRaises([{ path: PATH, base: undefined, now: route("{ js: '90kb' }") }]),
    ).toEqual([]);
  });
});

describe('the base the rule compares against', () => {
  test('is origin/main`s tip, and a checkout that cannot get it is REFUSED, never green', () => {
    const result = budgetResult([], undefined);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('NO budget was compared');
    expect(result.findings?.map((one) => one.code)).toEqual(['X_BUDGET_BASE_MISSING']);
    expect(result.findings?.[0]?.fix).toBe(FETCH_MAIN);
    expect(FETCH_MAIN).toContain('--depth=1');
    expect(BASE_REF).toBe('origin/main');
  });

  const fakeGit = (fetched: boolean, calls: string[]) => async (command: readonly string[]) => {
    calls.push(command.slice(0, 2).join(' '));
    const ok = command[1] === 'fetch' ? fetched : calls.includes('git fetch') && fetched;
    return { command, code: ok ? 0 : 1, ok, output: '', durationMs: 0 };
  };

  test('a checkout without origin/main fetches it, then compares against it', async () => {
    const calls: string[] = [];
    expect(await baseRef('/nowhere', fakeGit(true, calls))).toBe(BASE_REF);
    expect(calls).toEqual(['git rev-parse', 'git fetch', 'git rev-parse']);
  });

  test('a fetch that fails leaves no base, which budgetResult refuses', async () => {
    const calls: string[] = [];
    expect(await baseRef('/nowhere', fakeGit(false, calls))).toBeUndefined();
    expect(calls).toEqual(['git rev-parse', 'git fetch', 'git rev-parse']);
  });

  test('a raise is reported against the ref it was compared with', () => {
    const result = budgetResult(
      [{ path: PATH, base: route("{ js: '16kb' }"), now: route("{ js: '20kb' }") }],
      BASE_REF,
    );
    expect(result.ok).toBe(false);
    expect(result.findings?.[0]?.cause).toContain('since origin/main');
  });
});

describe('the real tree, against origin/main', () => {
  test('the command it names is a script this repo declares', async () => {
    const raw: unknown = await Bun.file(`${repoRoot()}/package.json`).json();
    const scripts = typeof raw === 'object' && raw !== null && 'scripts' in raw ? raw.scripts : {};
    expect(Object.keys(scripts ?? {})).toContain('budget-raises');
  });

  test('every raise since origin/main states its measured number and reason', async () => {
    const root = repoRoot();
    const base = await baseRef(root);
    const routes = base === undefined ? [] : await readRouteVersions(root, base);
    // Non-vacuity where a base exists: the tracked apps' budgeted routes were read at both ends.
    expect(base).toBe(BASE_REF);
    expect(routes.filter((one) => one.base !== undefined).length).toBeGreaterThan(10);
    expect(budgetResult(routes, base).findings ?? []).toEqual([]);
  }, 60_000);
});
