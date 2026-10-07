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
  test('bytes through the one parser, and the line of the key', () => {
    expect(readBudget(route("{ js: '20kb' }"))).toEqual({
      line: 3,
      js: { written: '20kb', bytes: 20480 },
    });
    expect(readBudget(route('{}'))).toEqual({ line: 3 });
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
    expect(finding.fix).toContain("restore js: '16kb'");
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

  test('a raise under the comment the base already had is unstated — it measured the old number', () => {
    const old = '  // measured: 20000 B — why: the settings form\n';
    // 30kb -> 900kb under the very sentence that justified 30kb.
    expect(raises(route("{ js: '30kb' }", old), route("{ js: '900kb' }", old))).toEqual([
      'js:30kb->900kb',
    ]);
    const restated = '  // measured: 880000 B — why: the chart library the dashboard now ships\n';
    expect(raises(route("{ js: '30kb' }", old), route("{ js: '900kb' }", restated))).toEqual([]);
  });

  test('a measured number above the new budget states nothing — the budget would already fail', () => {
    const over = '  // measured: 25000 B — why: the settings form\n';
    expect(raises(route("{ js: '16kb' }"), route("{ js: '20kb' }", over))).toEqual([
      'js:16kb->20kb',
    ]);
  });

  test('a lower, equal-in-bytes or brand-new budget is not a raise', () => {
    expect(raises(route("{ js: '20kb' }"), route("{ js: '16kb' }"))).toEqual([]);
    expect(raises(route("{ js: '20kb' }"), route("{ js: '20480b' }"))).toEqual([]);
    expect(
      checkBudgetRaises([{ path: PATH, base: undefined, now: route("{ js: '90kb' }") }]),
    ).toEqual([]);
  });
});

describe('deleting a js budget is an unlimited raise', () => {
  test('`budget: {}`, a budget with no js, or no budget key at all, is reported against the old value', () => {
    expect(raises(route("{ js: '16kb' }"), route('{}'))).toEqual(['js:16kb->none']);
    expect(raises(route("{ js: '16kb' }"), route("{ css: '4kb' }"))).toEqual(['js:16kb->none']);
    const unbudgeted = "export const config = defineRoute({\n  render: 'csr',\n});\n";
    const [gone] = checkBudgetRaises([
      { path: PATH, base: route("{ js: '16kb' }"), now: unbudgeted },
    ]);
    expect(gone).toEqual({
      file: PATH,
      line: 1,
      key: 'js',
      was: '16kb',
      now: 'none',
      keyRemoved: true,
    });
    // No budget line is left to sit a comment above: the fix restores the whole key, quoted, and
    // names the command that re-checks it.
    const fix = raiseFinding(gone ?? expect.unreachable('no raise'), BASE_REF).fix;
    expect(fix).toContain("budget: { js: '16kb' }");
    expect(fix).not.toContain('directly above the budget line');
    expect(fix).toContain('bun run budget-raises --json');
  });

  test('a js that is no longer a literal is unread, so it is an unlimited raise too', () => {
    expect(raises(route("{ js: '16kb' }"), route('{ js: LIMIT }'))).toEqual(['js:16kb->none']);
    // A whole budget that became a constant keeps its key line, so a statement above it counts.
    expect(raises(route("{ js: '16kb' }"), route('LIMIT'))).toEqual(['js:16kb->none']);
    expect(readBudget(route('LIMIT'))).toEqual({ line: 3 });
    const stated = '  // measured: 880000 B — why: the dashboard ships the chart library\n';
    expect(raises(route("{ js: '16kb' }"), route('LIMIT', stated))).toEqual([]);
  });

  test('a removal stated directly above the budget line (measured + why) is accepted', () => {
    const stated = '  // measured: 880000 B — why: the dashboard is admin-only and unbudgeted\n';
    expect(raises(route("{ js: '16kb' }"), route('{}', stated))).toEqual([]);
  });

  test('a backtick literal is read like a quoted one — it is not an absent budget', () => {
    expect(readBudget(route('{ js: `20kb` }'))).toEqual({
      line: 3,
      js: { written: '20kb', bytes: 20480 },
    });
    expect(raises(route("{ js: '30kb' }"), route('{ js: `900kb` }'))).toEqual(['js:30kb->900kb']);
    expect(raises(route('{ js: `30kb` }'), route("{ js: '20kb' }"))).toEqual([]);
    // An interpolated template is not a literal this rule can weigh.
    expect(readBudget(route(`{ js: \`${'$'}{N}kb\` }`))).toEqual({ line: 3 });
  });

  test('a route the base did not budget is not a raise when it still has none', () => {
    const bare = "export const config = defineRoute({ render: 'csr' });\n";
    expect(checkBudgetRaises([{ path: PATH, base: bare, now: bare }])).toEqual([]);
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
