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

import { maskLiterals } from '../packages/core/src/source-mask';
import { parseScriptArgs } from './lib/args';
import { balancedClose, topLevelArguments } from './lib/balanced-paren';
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
  /export (?:function|const) (\w+)[^\n=]*?[):]\s*(?:[A-Z]\w*)?(?:Error|Fault)\b/g,
  /export const (\w+)\s*=\s*\([^)]*\):\s*(?:[A-Z]\w*)?(?:Error|Fault)\b/g,
];

/**
 * The opening `(` of an exported function's parameter list, however long the list runs. Both
 * patterns above stop at a `\n`, and past 100 columns Biome puts one parameter per line — so
 * `notImplementedDriver`, `insufficientContrastError`, `explainActionPathMiss` and more were never
 * in the set until 2026-10. The list's close comes from `balancedClose`, so a parameter TYPED as
 * an error (`error: MailError,`) or an arrow-typed one (`(x: number) => Error`) is never read as
 * the return type.
 */
const PARAMETERS_OPEN =
  /export (?:function (\w+)\s*(?:<[^>(]*>)?|const (\w+)\s*=\s*(?:async\s*)?)\(/g;
const RETURN_TYPE = /^\s*:\s*(?:[A-Z]\w*)?(?:Error|Fault)\b/;

function wrappedFactories(source: string): readonly string[] {
  const names: string[] = [];
  for (const match of source.matchAll(PARAMETERS_OPEN)) {
    const close = balancedClose(source, match.index + match[0].length - 1);
    if (close < 0 || !RETURN_TYPE.test(source.slice(close + 1, close + 200))) continue;
    names.push(match[1] ?? match[2] ?? '');
  }
  return names;
}

export function errorFactoriesIn(source: string): readonly string[] {
  const names = [
    ...RETURNS_ERROR.flatMap((pattern) =>
      [...source.matchAll(pattern)].map((match) => match[1] ?? ''),
    ),
    ...wrappedFactories(source),
  ];
  return [...new Set(names)].filter((name) => name !== '');
}

const EXPECT = /\bexpect\(/g;
/** Directly after `expect(…)`: synchronous only — `rejects.toThrow` is not vulnerable. */
const SYNC_TO_THROW = /^\s*\.toThrow\w*\(/;
const ARROW = /^(?:async\s*)?\(\s*\)\s*=>\s*([\s\S]*)$/;
/**
 * `{ return <value>; }` — the one block whose value text can be certain about. Matched on the
 * MASKED body (string and template text blanked, offsets kept), so a `;` inside the returned
 * message — `new Error('first; second')` — is not read as the statement's end.
 */
const RETURN_ONLY = /^\{\s*return\s+([^;]*?);?\s*\}$/d;
/**
 * `new Error(…)`, `new MailError(…)`, and the `new`-less `Error(…)` / `TypeError(…)`, which construct
 * one too. The name prefix is optional: `[A-Z]\w*Error` alone missed the plain `Error`. The name
 * ENDS at `Error`/`Fault` — `new ErrorCount()` is not an error type.
 */
const CONSTRUCTS_ERROR = /^\s*(?:new\s+)?(?:[A-Z]\w*)?(?:Error|Fault)\s*\(/;
const CALLS = /^\s*([A-Za-z_$][\w$]*)\s*\(/;

/**
 * The value an `expect(() => …)` callback hands back, or `undefined` when its argument is not a
 * zero-argument arrow or its body is a block doing more than one `return`. Read through
 * `balancedClose`, never a one-line regex: Biome wraps a long callback onto its own line, and a
 * pattern stopping at `\n` saw none of those.
 */
function callbackValue(text: string, open: number): string | undefined {
  const close = balancedClose(text, open);
  if (close < 0 || !SYNC_TO_THROW.test(text.slice(close + 1))) return undefined;
  const args = topLevelArguments(text.slice(open + 1, close)).filter((arg) => arg !== '');
  const body = args.length === 1 ? ARROW.exec(args[0] as string)?.[1]?.trim() : undefined;
  if (body === undefined || !body.startsWith('{')) return body;
  const span = RETURN_ONLY.exec(maskLiterals(body))?.indices?.[1];
  return span === undefined ? undefined : body.slice(span[0], span[1]).trim();
}

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
    for (const match of file.text.matchAll(EXPECT)) {
      if (insideString(literals, match.index)) continue;
      const body = callbackValue(file.text, match.index + match[0].length - 1);
      if (body === undefined) continue;
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
