#!/usr/bin/env bun
// Enforce, as a build error, the half of axiom 9 that is a diff: a route's `budget:` may be RAISED,
// and the raise carries its measured number and its reason in the same change. A budget that only
// goes up silently is a budget nobody reads; one that never goes up is an axiom 6 argument in the
// wrong place. So every `budget.js` / `budget.lcp` literal in a route file that is larger than in
// `origin/main`'s TIP needs a comment DIRECTLY above the budget line carrying
// `measured: <N> B` (`<N> ms` for `lcp`) and `why:` — greppable tokens, the shape `node-imports`'
// `why:` takes. No raise buys an axiom 6 exception: `site/` importing `app/` stays a `boundaries`
// error whatever the number says.
//
// The tip, not the merge-base: CI then needs one commit (`FETCH_MAIN`, `--depth=1`) instead of the
// whole history a merge-base walks. A branch behind main compares against main's CURRENT budget,
// which is the number the merge will actually change.
//
// WHAT IT CANNOT SEE: a checkout with no `origin/main` compares nothing, and the summary says so and
// prints the fetch — never a silent ok. A budget built from a constant, or written in a file that is
// not `page.tsx` / `route.ts`, is not a literal this rule reads.
//
//   bun run scripts/budget-raises.ts [--json]

import { maskLiterals, stripComments } from '../packages/core/src/source-mask';
import { parseByteBudget } from '../packages/render/src/islands';
import { APP_ROOTS } from './boundaries';
import { parseScriptArgs } from './lib/args';
import { balancedClose } from './lib/balanced-paren';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot, run } from './lib/run';
import { lineOf } from './lib/source-scan';

const SCRIPT = 'budget-raises';

export interface RouteBudget {
  /** 1-based line of the `budget:` key — the line the stating comment must sit directly above. */
  readonly line: number;
  readonly js?: { readonly written: string; readonly bytes: number };
  readonly lcp?: number;
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
  const js = /\bjs\s*:\s*(['"])([^'"]+)\1/.exec(body)?.[2];
  const bytes = parseByteBudget(js);
  const lcp = /\blcp\s*:\s*(\d+)/.exec(body)?.[1];
  return {
    line: lineOf(masked, found.index),
    ...(js === undefined || bytes === null ? {} : { js: { written: js, bytes } }),
    ...(lcp === undefined ? {} : { lcp: Number.parseInt(lcp, 10) }),
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

export type BudgetKey = 'js' | 'lcp';

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

/** The unit a stated measurement is written in: bytes for `js`, milliseconds for `lcp`. */
const unitOf = (key: BudgetKey): string => (key === 'js' ? 'B' : 'ms');

/** Whether the comment above states this raise: a number in the key's unit, and a reason. */
export const states = (comment: string, key: BudgetKey): boolean =>
  new RegExp(String.raw`\bmeasured:\s*\d[\d,_]*\s*${unitOf(key)}\b`).test(comment) &&
  /\bwhy:/.test(comment);

export function checkBudgetRaises(routes: readonly RouteVersions[]): readonly BudgetRaise[] {
  const raises: BudgetRaise[] = [];
  for (const route of routes) {
    if (route.base === undefined) continue;
    const now = readBudget(route.now);
    const was = readBudget(route.base);
    if (now === undefined || was === undefined) continue;
    const comment = statedAbove(route.now, now.line);
    const found: BudgetRaise[] = [];
    if (now.js !== undefined && was.js !== undefined && now.js.bytes > was.js.bytes) {
      found.push({
        file: route.path,
        line: now.line,
        key: 'js',
        was: was.js.written,
        now: now.js.written,
      });
    }
    if (now.lcp !== undefined && was.lcp !== undefined && now.lcp > was.lcp) {
      found.push({
        file: route.path,
        line: now.line,
        key: 'lcp',
        was: `${was.lcp}`,
        now: `${now.lcp}`,
      });
    }
    raises.push(...found.filter((raise) => !states(comment, raise.key)));
  }
  return raises;
}

export function raiseFinding(raise: BudgetRaise, base: string): Finding {
  const unit = unitOf(raise.key);
  const measure = raise.key === 'js' ? 'bun run x -- build --json' : 'the route`s measured LCP';
  return {
    code: 'X_BUDGET_RAISE_UNSTATED',
    at: `${raise.file}:${raise.line}`,
    cause: `${raise.file}:${raise.line} raises budget.${raise.key} from ${raise.was} to ${raise.now} since ${base} and the comment above it states no measured number and no reason`,
    fix: `edit ${raise.file}:${raise.line} — add // measured: <N> ${unit} (${measure}) — why: <the function it buys> directly above the budget line, or restore ${raise.key}: ${raise.was}`,
  };
}

const ROUTES = `${APP_ROOTS}/*/**/{page.tsx,route.ts}`;
const NOT_SOURCE = /(?:^|\/)(?:node_modules|dist|\.x)\//;

/** The ref compared against: `origin/main`'s tip, one commit. */
export const BASE_REF = 'origin/main';

/** The one command that makes `BASE_REF` exist in a shallow checkout — what CI runs. */
export const FETCH_MAIN =
  'git fetch --no-tags --depth=1 origin +refs/heads/main:refs/remotes/origin/main';

/** `BASE_REF` when this checkout has it, or `undefined`. */
export async function baseRef(root: string): Promise<string | undefined> {
  const found = await run(['git', 'rev-parse', '--verify', '--quiet', `${BASE_REF}^{commit}`], {
    cwd: root,
  });
  return found.ok ? BASE_REF : undefined;
}

export async function readRouteVersions(
  root: string,
  base: string,
): Promise<readonly RouteVersions[]> {
  const routes: RouteVersions[] = [];
  for await (const path of new Bun.Glob(ROUTES).scan({ cwd: root })) {
    const posix = path.split('\\').join('/');
    if (NOT_SOURCE.test(posix)) continue;
    const now = await Bun.file(`${root}/${posix}`).text();
    if (!/\bbudget\s*:/.test(now)) continue;
    const then = await run(['git', 'show', `${base}:${posix}`], { cwd: root });
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
      ok: true,
      script: SCRIPT,
      summary: `${BASE_REF} is not in this checkout, so NO budget was compared — fetch it, then rerun: ${FETCH_MAIN}`,
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
