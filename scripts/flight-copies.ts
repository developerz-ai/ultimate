#!/usr/bin/env bun
// One rule, two halves: the framework computes a retry delay in ONE place, and it never rolls a
// die a test cannot control. Written because a sweep deleted three backoff curves and nothing
// stopped a fourth — the same hole `formatBytes` has, and axiom 3 says a rule that is not a build
// error does not exist.
//   bun run scripts/flight-copies.ts [--json]

import { maskLiterals, stripComments } from '@ultimat3/cli';
import { parseScriptArgs } from './lib/args';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { isTestPath, lineOf } from './lib/source-scan';

const SCRIPT = 'flight-copies';

/** The one module allowed to turn an attempt number into a delay. */
export const BACKOFF_MODULE = 'packages/core/src/backoff.ts';

export const SOURCE_GLOB = 'packages/*/src/**/*.{ts,tsx}';

export interface SourceFile {
  readonly at: string;
  readonly text: string;
}

/**
 * A CALL, never a reference. `random = Math.random` as a default parameter is the injectable seam
 * working correctly — `packages/core/src/backoff.ts` does exactly that. `Math.random()` invoked at
 * a call site is the defect: it was `packages/ai/src/gateway.ts:235`, and it made ai's backoff the
 * one engine of four with no test at all, because there was no way to pin a number.
 */
const RANDOM_CALL = /\bMath\s*\.\s*random\s*\(/g;

/**
 * The OTHER unpinnable die, and it is reported only in a file that already carries a curve.
 *
 * `crypto.getRandomValues(…)` is every bit as uncontrollable as `Math.random()`, so a curve that
 * jitters with it evades the rule entirely. Reporting it everywhere does not work and the
 * measurement says why: the five sites in this tree are `auth/tokens.ts:17`, `core/ids.ts:29`,
 * `core/secrets.ts:84,175` and `realtime/pg-auth.ts:146` — a token, an id, an encryption key and an
 * IV. For those the fix line this rule prints is not merely noise, it is WRONG: a
 * `random: () => number` seam on a key generator is a caller-supplied predictable CSPRNG, which is
 * the vulnerability. So the die is a defect where a CURVE is, and nowhere else.
 *
 * The RECEIVER is matched, exactly as `RANDOM_CALL` matches `Math`: only the AMBIENT `crypto` is
 * uncontrollable. `rng.getRandomValues(bytes)` and `options.crypto.getRandomValues(bytes)` are the
 * injectable seam this rule asks for — reporting them would print a fix line telling an author to
 * inject the seam they already injected, which is the false finding that gets a rule switched off.
 */
const CSPRNG_CALL = /(?<![.\w$])(?:globalThis\s*\.\s*)?crypto\s*\.\s*getRandomValues\s*\(/g;

/**
 * A second curve, recognised by SHAPE rather than by name — the copy that would do the damage will
 * not be called `backoffDelay`, exactly as the render-mode copy was not called `RenderMode`. Three
 * signals together, because any one alone is ordinary arithmetic: raising something to an attempt,
 * clamping the result, and multiplying it by a roll.
 */
/**
 * Raising something to an attempt, in BOTH spellings. `Math.pow(2, attempt)` is `2 ** attempt` with
 * a name in front, and a rule that read only the operator was the `PwaRenderMode` failure again —
 * this file's own header says the shape is what is matched, never the spelling.
 */
const EXPONENT = /\*\*|Math\s*\.\s*pow\s*\(/g;

/** `Math.min(…)` — the cap. `Math.max` is a FLOOR and is not one: see `ternaryClamp`. */
const CLAMP = /Math\s*\.\s*min\s*\(/;

/**
 * The clamp written out — `raw > max ? max : raw`, `raw < max ? raw : max` — which is `Math.min`
 * with the branches spelled, and which a rule demanding the call read straight past.
 *
 * The two BRANCHES must be the two OPERANDS, which is what makes it a min and not an ordinary
 * choice. Measured, and the reason it is not a looser pattern: `x <= 0.04045 ? x / 12.92 : …` in
 * `packages/ui/src/tokens/contrast.ts:36` is the sRGB gamma curve beside a `** 2.4`, and a rule
 * spelled "a comparison, a `?` and a `:`" reports it. `Math.max` is excluded for the same measured
 * reason: `packages/entity/src/aggregate.ts:150` takes a floor beside a `10n ** BigInt(…)`.
 */
const TERNARY_CLAMP =
  /([A-Za-z_$][\w$.]*)\s*[<>]=?\s*([A-Za-z_$][\w$.]*)\s*\?\s*([A-Za-z_$][\w$.]*)\s*:\s*([A-Za-z_$][\w$.]*)/g;

const ternaryClamp = (window: string): boolean =>
  [...window.matchAll(TERNARY_CLAMP)].some(
    (m) => new Set([m[1], m[2]]).size === 2 && new Set([m[1], m[2], m[3], m[4]]).size === 2,
  );

const clamped = (window: string): boolean => CLAMP.test(window) || ternaryClamp(window);

/**
 * How far either side of the `**` the clamp has to sit. A backoff curve clamps the exponent it
 * just raised, in one expression; two unrelated uses of `**` and `Math.min` in one 400-line file
 * are a coincidence. Deliberately NOT keyed on the roll's NAME: the first draft of this rule
 * looked for `random()`/`rng()`/`roll()` and read straight past a copy whose parameter was `r`,
 * which is the same way a rule spelled `RenderMode` read past `PwaRenderMode`.
 */
const CLAMP_WINDOW = 160;

const randomCallFindings = (file: SourceFile): readonly Finding[] => {
  const masked = maskLiterals(stripComments(file.text));
  const findings: Finding[] = [];
  const dice = hasCurve(masked, file.at)
    ? [...masked.matchAll(RANDOM_CALL), ...masked.matchAll(CSPRNG_CALL)]
    : [...masked.matchAll(RANDOM_CALL)];
  for (const match of dice.sort((a, b) => a.index - b.index)) {
    findings.push({
      code: 'X_FLIGHT_RANDOM_UNINJECTED',
      cause: `${file.at}:${lineOf(file.text, match.index)} rolls ${match[0].includes('getRandomValues') ? 'crypto.getRandomValues()' : 'Math.random()'} directly, so nothing that depends on it can be pinned by a test`,
      fix: `take a \`random: () => number\` parameter defaulting to \`Math.random\` and call that instead, the way ${BACKOFF_MODULE} does`,
      at: file.at,
    });
  }
  return findings;
};

/** Whether this file raises a factor to an attempt and clamps it in one expression. */
const hasCurve = (code: string, at: string): boolean =>
  at !== BACKOFF_MODULE &&
  [...code.matchAll(EXPONENT)].some((hit) =>
    clamped(code.slice(Math.max(0, hit.index - CLAMP_WINDOW), hit.index + CLAMP_WINDOW)),
  );

const secondCurveFinding = (file: SourceFile): Finding | undefined => {
  const code = maskLiterals(stripComments(file.text));
  if (!hasCurve(code, file.at)) return undefined;
  return {
    code: 'X_FLIGHT_SECOND_CURVE',
    cause: `${file.at} raises a factor to an attempt, clamps it and multiplies it by a roll — that is a backoff curve, and ${BACKOFF_MODULE} is the one that ships`,
    fix: `import { backoffDelay } from '@ultimat3/core' and delegate; pass \`curve\` and \`jitter\` rather than re-deriving them`,
    at: file.at,
  };
};

export function checkFlightCopies(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    findings.push(...randomCallFindings(file));
    const curve = secondCurveFinding(file);
    if (curve !== undefined) findings.push(curve);
  }
  return findings;
}

export async function readSources(root: string): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  for await (const path of new Bun.Glob(SOURCE_GLOB).scan({ cwd: root })) {
    if (isTestPath(path) || path.includes('/dist/')) continue;
    files.push({ at: path, text: await Bun.file(`${root}/${path}`).text() });
  }
  return files.sort((a, b) => a.at.localeCompare(b.at));
}

export const flightCopyFindings = async (root: string): Promise<readonly Finding[]> =>
  checkFlightCopies(await readSources(root));

/**
 * What the command prints, as a value — so a test can read the `--json` document this rule
 * publishes instead of trusting the `report()` call at the bottom of the file.
 *
 * `findings:` and not `lines:`, which is the whole reason this is a function: `render()` in `--json`
 * mode emits `result.findings ?? []` and drops `lines` entirely, so a rule that hand-rolled its own
 * three-line text published `findings: []` on a RED run and every reader of the document saw a
 * clean tree. Three rules did — this one, `render-modes.ts` and `frozen-records.ts`.
 */
export const flightCopyResult = (files: readonly SourceFile[]): ScriptResult => {
  const findings = checkFlightCopies(files);
  return {
    ok: findings.length === 0,
    script: SCRIPT,
    summary:
      findings.length === 0
        ? `${files.length} files, one backoff curve (${BACKOFF_MODULE}) and no uninjected roll`
        : `${findings.length} flight-control copy findings`,
    findings,
    data: { scanned: files.length },
  };
};

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  report(flightCopyResult(await readSources(repoRoot())), args.json);
}
