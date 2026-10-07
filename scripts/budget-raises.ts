#!/usr/bin/env bun
// Enforce, as a build error, the half of axiom 9 that is a diff: a route's `budget:` may be RAISED,
// and the raise carries its measured number and its reason in the same change. A budget that only
// goes up silently is a budget nobody reads; one that never goes up is an axiom 6 argument in the
// wrong place. So every `budget.js` literal in a route file that is larger than in
// `origin/main`'s TIP needs a comment DIRECTLY above the budget line carrying
// `measured: <N> B` and `why:` — greppable tokens, the shape `node-imports`'
// `why:` takes. The comment must be NEW (not the one the base already had above the budget, which
// measured the old number) and the measurement must fit the new budget. No raise buys an axiom 6
// exception: `site/` importing `app/` stays a `boundaries` error whatever the number says.
//
// The tip, not the merge-base: CI then needs one commit (`FETCH_MAIN`, `--depth=1`) instead of the
// whole history a merge-base walks. A branch behind main compares against main's CURRENT budget,
// which is the number the merge will actually change.
//
// A checkout with no `origin/main` (a tag checkout in `release.yml`, a fresh clone of a fork) FETCHES
// it — one commit — and, if the fetch fails, refuses `X_BUDGET_BASE_MISSING`. It used to pass with
// "NO budget was compared" in the summary, which is a green step that checked nothing. A budget
// written in a file that is not `page.tsx` / `route.ts` is not one this rule reads. A js budget the
// base had and the route no longer has as a literal (`budget: {}`, no js, no `budget:` key, a
// constant) is an UNLIMITED raise: stated like any other (`measured:` + `why:` above the budget
// line), and with no `budget:` key left to sit a comment above, never stated.
//
//   bun run scripts/budget-raises.ts [--json]

import { maskLiterals, stripComments } from '../packages/core/src/source-mask';
import { parseByteBudget } from '../packages/render/src/islands';
import { APP_ROOTS } from './boundaries';
import { parseScriptArgs } from './lib/args';
import { balancedClose } from './lib/balanced-paren';
import { BASE_REF, baseRef, FETCH_MAIN } from './lib/base-ref';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot, run } from './lib/run';
import { lineOf } from './lib/source-scan';

const SCRIPT = 'budget-raises';

export interface RouteBudget {
  /** 1-based line of the `budget:` key — the line the stating comment must sit directly above. */
  readonly line: number;
  readonly js?: { readonly written: string; readonly bytes: number };
}

/** The first `budget: { … }` in CODE — never one a string or a comment quotes. */
export function readBudget(source: string): RouteBudget | undefined {
  const masked = maskLiterals(source);
  const text = stripComments(source);
  const found = /\bbudget\s*:\s*\{/.exec(masked);
  if (found === null) return undefined;
  const open = found.index + found[0].length - 1;
  const close = balancedClose(masked.replace(/\{/g, '(').replace(/\}/g, ')'), open);
  const body = text.slice(open, close < 0 ? undefined : close + 1);
  // A backtick literal is a literal; one that interpolates (`${N}kb`) is not one this rule can weigh.
  const js = /\bjs\s*:\s*(['"`])([^'"`$]+)\1/.exec(body)?.[2];
  const bytes = parseByteBudget(js);
  return {
    line: lineOf(masked, found.index),
    ...(js === undefined || bytes === null ? {} : { js: { written: js, bytes } }),
  };
}

/** The comment lines directly above `line`, joined — a blank line ends the block. */
export function statedAbove(source: string, line: number): string {
  const lines = source.split('\n');
  const block: string[] = [];
  for (let index = line - 2; index >= 0; index -= 1) {
    const trimmed = (lines[index] ?? '').trim();
    if (!/^(?:\/\/|\/\*|\*)/.test(trimmed)) break;
    block.unshift(trimmed);
  }
  return block.join(' ');
}

export type BudgetKey = 'js';

export interface BudgetRaise {
  readonly file: string;
  readonly line: number;
  readonly key: BudgetKey;
  readonly was: string;
  readonly now: string;
}

export interface RouteVersions {
  readonly path: string;
  readonly now: string;
  /** The file at origin/main's tip, or `undefined` when it does not exist there — a new route. */
  readonly base: string | undefined;
}

/**
 * Whether the comment above states this raise: a number of bytes that FITS the new budget
 * (`ceiling`), and a reason. A measurement above the budget it justifies is a number
 * the budget step would already refuse, so it states nothing.
 */
export const states = (comment: string, ceiling: number): boolean => {
  const measured = /\bmeasured:\s*(\d[\d,_]*)\s*B\b/.exec(comment);
  if (measured === null || !/\bwhy:/.test(comment)) return false;
  return Number((measured[1] as string).replace(/[,_]/g, '')) <= ceiling;
};

/** What a route with no js literal (none, `{}`, a constant) is written as in a finding. */
export const UNBUDGETED = 'none';

function raiseOf(route: RouteVersions): BudgetRaise | undefined {
  const was = route.base === undefined ? undefined : readBudget(route.base);
  if (route.base === undefined || was?.js === undefined) return undefined;
  const now = readBudget(route.now);
  // No `budget:` key left at all: nothing to sit a comment above, so the removal is never stated.
  if (now === undefined) {
    return { file: route.path, line: 1, key: 'js', was: was.js.written, now: UNBUDGETED };
  }
  // A js budget deleted (`{}`, no js, a non-literal) is the largest raise there is: unlimited.
  const ceiling = now.js?.bytes ?? Number.POSITIVE_INFINITY;
  if (ceiling <= was.js.bytes) return undefined;
  const comment = statedAbove(route.now, now.line);
  // The sentence the base already carried measured the OLD number, so it states no raise.
  const inherited = comment !== '' && comment === statedAbove(route.base, was.line);
  if (!inherited && states(comment, ceiling)) return undefined;
  const written = now.js?.written ?? UNBUDGETED;
  return { file: route.path, line: now.line, key: 'js', was: was.js.written, now: written };
}

export function checkBudgetRaises(routes: readonly RouteVersions[]): readonly BudgetRaise[] {
  return routes.flatMap((route) => raiseOf(route) ?? []);
}

export function raiseFinding(raise: BudgetRaise, base: string): Finding {
  return {
    code: 'X_BUDGET_RAISE_UNSTATED',
    at: `${raise.file}:${raise.line}`,
    cause: `${raise.file}:${raise.line} ${raise.now === UNBUDGETED ? `removes budget.${raise.key} (${raise.was}) — an unlimited raise —` : `raises budget.${raise.key} from ${raise.was} to ${raise.now}`} since ${base} and the comment above it states no new measured number within ${raise.now} and no reason — a comment ${base} already had measured the old budget`,
    fix: `edit ${raise.file}:${raise.line} — add // measured: <N> B (bun run x -- build --json) — why: <the function it buys> directly above the budget line, or restore ${raise.key}: ${raise.was}`,
  };
}

const ROUTES = `${APP_ROOTS}/*/**/{page.tsx,route.ts}`;
const NOT_SOURCE = /(?:^|\/)(?:node_modules|dist|\.x)\//;

export { BASE_REF, baseRef, FETCH_MAIN };

export async function readRouteVersions(
  root: string,
  base: string,
): Promise<readonly RouteVersions[]> {
  const routes: RouteVersions[] = [];
  for await (const path of new Bun.Glob(ROUTES).scan({ cwd: root })) {
    const posix = path.split('\\').join('/');
    if (NOT_SOURCE.test(posix)) continue;
    const now = await Bun.file(`${root}/${posix}`).text();
    // A route whose budget was DELETED has none now, so the base is read for every route.
    const then = await run(['git', 'show', `${base}:${posix}`], { cwd: root });
    if (!/\bbudget\s*:/.test(now) && !(then.ok && /\bbudget\s*:/.test(then.output))) continue;
    routes.push({ path: posix, now, base: then.ok ? then.output : undefined });
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path));
}

export function budgetResult(
  routes: readonly RouteVersions[],
  base: string | undefined,
): ScriptResult {
  if (base === undefined) {
    return {
      ok: false,
      script: SCRIPT,
      summary: `${BASE_REF} is not in this checkout and could not be fetched, so NO budget was compared`,
      findings: [
        {
          code: 'X_BUDGET_BASE_MISSING',
          cause: `${BASE_REF} is not in this checkout and \`${FETCH_MAIN}\` failed, so no route budget was compared against it`,
          fix: FETCH_MAIN,
        },
      ],
      data: { base: null },
    };
  }
  const raises = checkBudgetRaises(routes);
  const short = base;
  return {
    ok: raises.length === 0,
    script: SCRIPT,
    summary:
      raises.length === 0
        ? `${routes.length} budgeted route(s), every raise since ${short} states its measured number and reason`
        : `${raises.length} budget raise(s) since ${short} with no measured number and reason above them`,
    findings: raises.map((raise) => raiseFinding(raise, short)),
    data: { base, routes: routes.length, raises },
  };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const base = await baseRef(root);
  const routes = base === undefined ? [] : await readRouteVersions(root, base);
  report(budgetResult(routes, base), args.json);
}
