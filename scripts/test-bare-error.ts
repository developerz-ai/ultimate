#!/usr/bin/env bun
// Enforce, as a gate step, that a test does not report ITS OWN verdict by throwing a bare `Error`.
//
// `CLAUDE.md` says never throw a bare `Error`, and `checkErrorFixes` opens with
// `if (isTest(path) || isGenerated(path)) continue` — so in test files the rule was prose only,
// which axiom 3 says is no rule at all. 422 `new Error(` sites were sitting under a green gate;
// the issue that opened this (#132) counted 295, and the growth is its own argument.
//
//   bun run scripts/test-bare-error.ts [--json]
//   bun run scripts/test-bare-error.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import { stripComments } from '@ultimat3/cli';
import { flagList, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { insideString, sourceStrings } from './lib/source-strings';
import {
  applyBareErrorUnpin,
  BARE_ERROR_PINS,
  bareErrorPinnedFor,
  PINS_FILE,
} from './lib/test-bare-error-pins';
import { packageOf, readTestSources } from './test-fix-citations';

const SCRIPT = 'test-bare-error';

/**
 * `throw` is the whole rule, and it is what makes the two populations separable — which #132 said
 * grep could not do. It is right that `new Error` alone cannot be judged: the difference is whether
 * the error is the test's INPUT or its VERDICT, and `throw` is exactly where that shows.
 *
 * An input is a foreign error handed to the code under test, and is **not reported at all** —
 * `Promise.reject(new Error('redis is down'))`, `render(new Error('the driver went away'))`,
 * `Object.assign(new Error('denied'), { code, cause, fix })`. 159 such sites, and
 * `packages/realtime/CLAUDE.md` already states the carve-out as settled: *"A test fixture standing
 * in for a FOREIGN error extends `Error` on purpose… The rule governs what this package throws,
 * never what a test hands it."* Rebuilding those as `UltimateError` would change what the
 * surrounding tests prove.
 *
 * A verdict is the test itself saying the subject misbehaved — `throw new Error('expected a
 * refusal, and nothing was thrown')` — and `expect.unreachable` is this repo's idiom for it
 * (10+ uses in `packages/realtime/src/`): it reports at the assertion with the value that actually
 * arrived, and its `never` return narrows the variable so no cast is needed.
 */
const THROWN = /\bthrow\s+new\s+Error\s*\(/g;

/** The honest limit, stated rather than guessed at — see `bareErrorFindingFor`'s cause. */
export interface BareErrorSite {
  readonly path: string;
  readonly line: number;
}

export function scanBareErrorThrows(path: string, source: string): readonly BareErrorSite[] {
  // A COMMENT quoting the shape is prose ABOUT a throw, never one — and reading it as a throw is
  // this rule punishing the only sentence that can explain it. It fired: a `packages/db` test
  // whose header read "reads a literal `throw new Error(…)` as a verdict wherever it appears" took
  // that package 24 -> 25 with no throw in the file, and the comment was reworded to clear a gate.
  // `dead-docs-host.ts` already carries the same carve-out in the same words — a comment naming
  // the banned thing as the thing that was removed cannot commit it. `stripComments` blanks a
  // comment to spaces and preserves every offset, so the string exemption below still lines up.
  const code = stripComments(source);
  const literals = sourceStrings(source);
  const out: BareErrorSite[] = [];
  for (const match of code.matchAll(THROWN)) {
    const at = match.index ?? 0;
    // A rule's own test spells the bad shape as a STRING and feeds it to the pure function below.
    // Same exemption `to-throw-returns.ts` and `test-fix-citations.ts` rest on, same tokenizer.
    if (insideString(literals, at)) continue;
    out.push({ path, line: source.slice(0, at).split('\n').length });
  }
  return out;
}

export type BareErrorGapKind = 'over' | 'stale' | 'unscanned';

export interface BareErrorGap {
  readonly kind: BareErrorGapKind;
  readonly pkg: string;
  readonly found: number;
  readonly pinned: number;
  readonly first?: BareErrorSite;
}

export interface BareErrorInput {
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly pins: Readonly<Record<string, number>>;
}

export function checkBareErrors(input: BareErrorInput): readonly BareErrorGap[] {
  if (input.files.length === 0) {
    return [{ kind: 'unscanned', pkg: '', found: 0, pinned: 0 }];
  }
  const found = new Map<string, BareErrorSite[]>();
  for (const file of input.files) {
    for (const site of scanBareErrorThrows(file.path, file.text)) {
      const pkg = packageOf(site.path);
      const list = found.get(pkg) ?? [];
      list.push(site);
      found.set(pkg, list);
    }
  }
  const gaps: BareErrorGap[] = [];
  for (const pkg of new Set([...found.keys(), ...Object.keys(input.pins)])) {
    const hits = found.get(pkg) ?? [];
    const pinned = bareErrorPinnedFor(pkg, input.pins);
    if (hits.length > pinned) {
      gaps.push({
        kind: 'over',
        pkg,
        found: hits.length,
        pinned,
        ...(hits[0] === undefined ? {} : { first: hits[0] }),
      });
      continue;
    }
    if (hits.length < pinned) gaps.push({ kind: 'stale', pkg, found: hits.length, pinned });
  }
  return gaps.sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0));
}

const at = (site: BareErrorSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)}`;

const overFinding = (gap: BareErrorGap): Finding => ({
  code: 'X_TEST_BARE_ERROR',
  cause: `${gap.pkg} has ${String(gap.found)} test(s) reporting a verdict with a bare Error and is pinned at ${String(gap.pinned)} — ${at(gap.first)} throws one, which carries no code, no cause and no fix, and reports at the throw rather than at the assertion`,
  fix: `replace the throw at ${at(gap.first)} with expect.unreachable('<what was expected>') — its never return also narrows the variable, so the cast below it goes away`,
  at: at(gap.first),
});

const staleFinding = (gap: BareErrorGap): Finding => ({
  code: 'X_TEST_BARE_ERROR_PIN_STALE',
  cause: `${gap.pkg} is pinned at ${String(gap.pinned)} bare-Error throw(s) and has ${String(gap.found)} — the pin is above what this tree contains, so it would let ${String(gap.pinned - gap.found)} back in`,
  fix: `bun run scripts/test-bare-error.ts --unpin ${gap.pkg}`,
  at: PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_TEST_BARE_ERROR_UNSCANNED',
  cause:
    'no test file was read, so every package reports zero and the ratchet enforces nothing — a glob that matches nothing reads exactly like a clean tree',
  fix: "edit TEST_GLOBS in scripts/test-fix-citations.ts so it matches this repo's test layout",
  at: 'scripts/test-bare-error.ts',
});

const FINDINGS: Readonly<Record<BareErrorGapKind, (gap: BareErrorGap) => Finding>> = {
  over: overFinding,
  stale: staleFinding,
  unscanned: unscannedFinding,
};

export const bareErrorFindingFor = (gap: BareErrorGap): Finding => FINDINGS[gap.kind](gap);

export const bareErrorGaps = async (root: string): Promise<readonly BareErrorGap[]> =>
  checkBareErrors({ files: await readTestSources(root), pins: BARE_ERROR_PINS });

/** What this repo contributes to `x verify`'s `errors` step. */
export const bareErrorFindings = async (root: string): Promise<readonly Finding[]> =>
  (await bareErrorGaps(root)).map(bareErrorFindingFor);

/** Every site, for `--unpin` and for the count a maintainer wants when lowering a pin. */
export async function bareErrorCounts(root: string): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const file of await readTestSources(root)) {
    for (const site of scanBareErrorThrows(file.path, file.text)) {
      const pkg = packageOf(site.path);
      counts[pkg] = (counts[pkg] ?? 0) + 1;
    }
  }
  return counts;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const unpin = flagList(args, 'unpin');
  if (unpin.length > 0) {
    const lowered = await applyBareErrorUnpin(root, unpin, await bareErrorCounts(root));
    report(
      {
        ok: true,
        script: SCRIPT,
        summary:
          lowered.length === 0
            ? 'nothing to lower — every named package is already at what this tree measures'
            : `lowered ${String(lowered.length)} pin(s): ${lowered.join(', ')}`,
        findings: [],
      },
      args.json,
    );
  } else {
    const gaps = await bareErrorGaps(root);
    report(
      {
        ok: gaps.length === 0,
        script: SCRIPT,
        summary:
          gaps.length === 0
            ? 'no package reports a test verdict with a bare Error above its pin'
            : `${String(gaps.length)} package(s) off the bare-Error ratchet`,
        findings: gaps.map(bareErrorFindingFor),
      },
      args.json,
    );
  }
}
