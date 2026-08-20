#!/usr/bin/env bun
// Enforce, as a gate step, that `expect(fn).toThrow(...)` is given a function that THROWS.
//
// The hazard, verified rather than assumed (`to-throw-returns.test.ts` runs the case): bun's
// synchronous `toThrow` PASSES when `fn` returns an Error instead of throwing one —
// `expect(() => new Boom('x')).toThrow(Boom)` is green, and so are the bare and string-matcher
// forms. Returning a NON-error is correctly reported, and `rejects.toThrow` is unaffected: a
// promise that resolves to an Error is a resolved promise, and `rejects` catches that.
//
// So the defect is narrow and total: a sync `toThrow` whose callback's value IS an error. This
// repo has 196 exported functions that RETURN one — `sendFailed()`, `routeNotFound()`,
// `fixtureUnknown()` — beside a matching set that throws, and one `expect(() => sendFailed(…))`
// is a test that can never fail. Zero today; the surface is 196 wide and nothing guarded it.
//
// Only the shapes that are CERTAIN are reported: the callback's body is an error construction, or
// a call to a function this repo declares as returning an error. A callback that calls something
// else may or may not throw, and a rule that guessed would report findings on tests that are right.
//
//   bun run scripts/to-throw-returns.ts [--json]

import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { insideString, sourceStrings } from './lib/source-strings';
import { readTestSources } from './test-fix-citations';

const SCRIPT = 'to-throw-returns';

export const SOURCE_GLOBS: readonly string[] = ['packages/*/src/**/*.ts', 'scripts/**/*.ts'];

/**
 * A function this repo declares as RETURNING an error — `export function sendFailed(…): MailError`.
 * Derived, never listed: an error package adds one of these most weeks, and a hand-kept list would
 * be the convention this file exists to stop relying on.
 */
const RETURNS_ERROR = [
  /export (?:function|const) (\w+)[^\n=]*?[):]\s*[A-Z]\w*(?:Error|Fault)\b/g,
  /export const (\w+)\s*=\s*\([^)]*\):\s*[A-Z]\w*(?:Error|Fault)\b/g,
];

export function errorFactoriesIn(source: string): readonly string[] {
  return RETURNS_ERROR.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1] ?? ''),
  ).filter((name) => name !== '');
}

/**
 * `expect(() => <body>).toThrow…(` — synchronous only. `rejects.toThrow` is excluded because it is
 * not vulnerable, and including it would report a finding on a correct assertion.
 */
const SYNC_TO_THROW = /expect\(\s*(?:async\s*)?\(\s*\)\s*=>\s*([^\n]*?)\)\s*\.(toThrow\w*)\(/g;
const CONSTRUCTS_ERROR = /^\s*new\s+[A-Z]\w*(?:Error|Fault)\w*\s*\(/;
const CALLS = /^\s*([A-Za-z_$][\w$]*)\s*\(/;

export interface ThrowGap {
  readonly at: string;
  readonly body: string;
  /** What makes the value certainly an error: a construction, or a named factory. */
  readonly reason: string;
}

export interface ThrowGapInput {
  readonly tests: readonly { readonly path: string; readonly text: string }[];
  readonly factories: ReadonlySet<string>;
}

export function checkToThrowReturns(input: ThrowGapInput): readonly ThrowGap[] {
  const gaps: ThrowGap[] = [];
  for (const file of input.tests) {
    // A checker's own unit test spells the bad shape as a STRING and feeds it to the pure function
    // below. That is a fixture, not an assertion this file makes — the same exemption
    // `test-fix-citations.ts` rests on, and the same tokenizer.
    const literals = sourceStrings(file.text);
    for (const match of file.text.matchAll(SYNC_TO_THROW)) {
      if (insideString(literals, match.index ?? 0)) continue;
      const body = (match[1] ?? '').trim();
      const called = CALLS.exec(body)?.[1];
      const reason = CONSTRUCTS_ERROR.test(body)
        ? 'constructs an error and hands it back'
        : called !== undefined && input.factories.has(called)
          ? `calls ${called}(), which this repo declares as returning an error`
          : undefined;
      if (reason === undefined) continue;
      gaps.push({
        at: `${file.path}:${String(file.text.slice(0, match.index).split('\n').length)}`,
        body,
        reason,
      });
    }
  }
  return gaps;
}

export const throwFindingFor = (gap: ThrowGap): Finding => ({
  code: 'X_TEST_THROW_NOT_THROWN',
  cause: `${gap.at} asserts a throw over \`${gap.body}\`, which ${gap.reason} — bun's synchronous toThrow PASSES on a returned Error, so this assertion cannot fail`,
  fix: `wrap the value in a throw at ${gap.at}: \`expect(() => { throw ${gap.body}; }).toThrow(…)\`, or assert the value directly with \`expect(${gap.body}).toBeInstanceOf(…)\``,
  at: gap.at,
});

export async function throwGaps(root: string): Promise<readonly ThrowGap[]> {
  const factories = new Set<string>();
  for (const glob of SOURCE_GLOBS) {
    for await (const path of new Bun.Glob(glob).scan({ cwd: root, absolute: false })) {
      if (/\.test\.tsx?$/.test(path)) continue;
      for (const name of errorFactoriesIn(await Bun.file(`${root}/${path}`).text())) {
        factories.add(name);
      }
    }
  }
  return checkToThrowReturns({ tests: await readTestSources(root), factories });
}

/** What this repo contributes to `x verify`'s `errors` step. */
export const throwFindings = async (root: string): Promise<readonly Finding[]> =>
  (await throwGaps(root)).map(throwFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const gaps = await throwGaps(repoRoot());
  report(
    {
      ok: gaps.length === 0,
      script: SCRIPT,
      summary:
        gaps.length === 0
          ? 'every sync toThrow is given a function that throws, not one that returns an error'
          : `${gaps.length} toThrow assertion(s) cannot fail`,
      findings: gaps.map(throwFindingFor),
    },
    args.json,
  );
}
