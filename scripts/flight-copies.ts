#!/usr/bin/env bun
// One rule, two halves: the framework computes a retry delay in ONE place, and it never rolls a
// die a test cannot control. Written because a sweep deleted three backoff curves and nothing
// stopped a fourth — the same hole `formatBytes` has, and axiom 3 says a rule that is not a build
// error does not exist.
//   bun run scripts/flight-copies.ts [--json]

import { maskLiterals, stripComments } from '@ultimat3/cli';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
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
 * A second curve, recognised by SHAPE rather than by name — the copy that would do the damage will
 * not be called `backoffDelay`, exactly as the render-mode copy was not called `RenderMode`. Three
 * signals together, because any one alone is ordinary arithmetic: raising something to an attempt,
 * clamping the result, and multiplying it by a roll.
 */
const EXPONENT = /\*\*/g;
const CLAMP = /Math\s*\.\s*min\s*\(/;

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
  for (const match of masked.matchAll(RANDOM_CALL)) {
    findings.push({
      code: 'X_FLIGHT_RANDOM_UNINJECTED',
      cause: `${file.at}:${lineOf(file.text, match.index)} calls Math.random() directly, so nothing that depends on it can be pinned by a test`,
      fix: `take a \`random: () => number\` parameter defaulting to \`Math.random\` and call that instead, the way ${BACKOFF_MODULE} does`,
      at: file.at,
    });
  }
  return findings;
};

const secondCurveFinding = (file: SourceFile): Finding | undefined => {
  if (file.at === BACKOFF_MODULE) return undefined;
  const code = maskLiterals(stripComments(file.text));
  const clamped = [...code.matchAll(EXPONENT)].some((hit) =>
    CLAMP.test(code.slice(Math.max(0, hit.index - CLAMP_WINDOW), hit.index + CLAMP_WINDOW)),
  );
  if (!clamped) return undefined;
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

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const files = await readSources(repoRoot());
  const findings = checkFlightCopies(files);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${files.length} files, one backoff curve (${BACKOFF_MODULE}) and no uninjected roll`
          : `${findings.length} flight-control copy findings`,
      lines: findings.map((one) => `  ${one.at}\n    cause: ${one.cause}\n    fix:   ${one.fix}`),
      data: { scanned: files.length, findings },
    },
    args.json,
  );
}
