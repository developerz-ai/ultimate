#!/usr/bin/env bun
// Enforce, as a ratchet, that no shipped source builds a URL on `ultimate.dev`.
//
// `https://ultimate.dev/errors/<code>` answered HTTP 404 — host included — on every error the
// framework ever threw, and it shipped as the `docs:` line of roughly ninety error declarations
// plus a `docsFor(code)` helper in four packages. `ERROR_DOCS_URL` in `@ultimat3/core` is the one
// answer now, and `UltimateError`'s constructor resolves it from the registered descriptor, so a
// declaration needs no `docs:` line at all.
//
// WHY A GATE AND NOT A SWEEP. The sweep is done and nothing stopped it regrowing:
// `scripts/new-package.ts` wrote the dead URL into EVERY future package's `errors.ts` template, and
// two gate scripts — `scripts/verify.ts` and `scripts/roadmap.ts` — still emitted it at the exact
// moment an agent's build failed. Both are fixed; this is what keeps them fixed.
//
// A COMMENT IS NOT A LINK. Twelve files name the host in prose as the thing that was REMOVED
// (`packages/core/src/error-codes.ts:26` and `packages/ai/src/errors.ts:71` set the precedent), and
// a comment cannot 404. Only an occurrence inside a STRING LITERAL — a value the process hands to
// an operator — is reported.
//
//   bun run dead-docs-host  ·  bun run scripts/dead-docs-host.ts [--json]
//   bun run scripts/dead-docs-host.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import { collectSourceFiles, type SourceFile } from './boundaries';
import { flagList, parseScriptArgs } from './lib/args';
import {
  applyDeadHostUnpin,
  DEAD_HOST_PINS,
  DEAD_HOST_PINS_FILE,
  deadHostPinnedFor,
} from './lib/dead-docs-host-pins';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { isTestPath, lineOf } from './lib/source-scan';
import { insideString, sourceStrings } from './lib/source-strings';
import { packageOf } from './test-fix-citations';

const SCRIPT = 'dead-docs-host';

/**
 * The host, SPELT IN PIECES — because this file is shipped source and the rule reads shipped source,
 * so writing the literal here would make the rule its own first finding. Three occurrences in the
 * strings below did exactly that on the first run.
 */
export const HOST = ['ultimate', 'dev'].join('.');

/**
 * The dot is ESCAPED, and that is the whole reason this is a built pattern rather than a
 * `.includes`: an unescaped `.` matches `ultimate-dev-signing-secret`, a fixture value in this
 * tree, and a rule whose first finding is a false one is a rule nobody runs twice.
 */
export const DEAD_HOST = new RegExp(HOST.replace('.', '\\.'), 'g');

/** What replaces it, so the `fix:` names a symbol that exists rather than a URL to paste. */
export const REPLACEMENT = 'ERROR_DOCS_URL';

export interface DeadHostSite {
  readonly path: string;
  readonly line: number;
}

/** Every occurrence the process could actually emit — a string literal, never a comment. */
export function scanDeadHost(path: string, source: string): readonly DeadHostSite[] {
  const literals = sourceStrings(source);
  const out: DeadHostSite[] = [];
  for (const match of source.matchAll(DEAD_HOST)) {
    if (!insideString(literals, match.index)) continue;
    out.push({ path, line: lineOf(source, match.index) });
  }
  return out;
}

export type DeadHostGapKind = 'over' | 'stale' | 'unscanned';

export interface DeadHostGap {
  readonly kind: DeadHostGapKind;
  readonly pkg: string;
  readonly found: number;
  readonly pinned: number;
  readonly first?: DeadHostSite;
}

export interface DeadHostInput {
  readonly files: readonly SourceFile[];
  readonly pins: Readonly<Record<string, number>>;
}

/** The ratchet: a package may hold what it is pinned at, may fall, may never rise. */
export function checkDeadHost(input: DeadHostInput): readonly DeadHostGap[] {
  if (input.files.length === 0) {
    return [{ kind: 'unscanned', pkg: '', found: 0, pinned: 0 }];
  }
  const found = new Map<string, DeadHostSite[]>();
  for (const file of input.files) {
    if (isTestPath(file.path)) continue;
    for (const site of scanDeadHost(file.path, file.source)) {
      const pkg = packageOf(site.path);
      const list = found.get(pkg) ?? [];
      list.push(site);
      found.set(pkg, list);
    }
  }
  const gaps: DeadHostGap[] = [];
  for (const pkg of new Set([...found.keys(), ...Object.keys(input.pins)])) {
    const hits = found.get(pkg) ?? [];
    const pinned = deadHostPinnedFor(pkg, input.pins);
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

const at = (site: DeadHostSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)}`;

const overFinding = (gap: DeadHostGap): Finding => ({
  code: 'X_DEAD_DOCS_HOST',
  cause: `${gap.pkg} builds ${String(gap.found)} URL(s) on ${HOST} and is pinned at ${String(gap.pinned)} — ${at(gap.first)} emits one, and that host answers HTTP 404 on every path, so the link an operator is handed at the moment of a failure goes nowhere`,
  fix: `delete the docs: line at ${at(gap.first)} — UltimateError resolves the registered descriptor, whose default is ${REPLACEMENT} from @ultimat3/core; if this is not an error link, import ${REPLACEMENT} rather than writing a second host`,
  at: at(gap.first),
});

const staleFinding = (gap: DeadHostGap): Finding => ({
  code: 'X_DEAD_DOCS_HOST_PIN_STALE',
  cause: `${gap.pkg} is pinned at ${String(gap.pinned)} ${HOST} URL(s) and has ${String(gap.found)} — the pin is above what this tree contains, so it would let ${String(gap.pinned - gap.found)} back in`,
  fix: `bun run scripts/dead-docs-host.ts --unpin ${gap.pkg}`,
  at: DEAD_HOST_PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_DEAD_DOCS_HOST_UNSCANNED',
  cause:
    'no source file was read, so every package reports zero and the ratchet enforces nothing — a glob that matches nothing reads exactly like a tree with no dead link in it',
  fix: 'edit SOURCE_PATTERNS in scripts/boundaries.ts so it matches this repo layout, then bun run scripts/dead-docs-host.ts',
  at: 'scripts/boundaries.ts',
});

const FINDINGS: Readonly<Record<DeadHostGapKind, (gap: DeadHostGap) => Finding>> = {
  over: overFinding,
  stale: staleFinding,
  unscanned: unscannedFinding,
};

export const deadHostFindingFor = (gap: DeadHostGap): Finding => FINDINGS[gap.kind](gap);

export const deadHostGaps = async (root: string): Promise<readonly DeadHostGap[]> =>
  checkDeadHost({ files: await collectSourceFiles(root), pins: DEAD_HOST_PINS });

/** What this rule contributes to `x verify`'s `unit` step, through `dead-docs-host.test.ts`. */
export const deadHostFindings = async (root: string): Promise<readonly Finding[]> =>
  (await deadHostGaps(root)).map(deadHostFindingFor);

/** Every site per package, for `--unpin` and for the number a maintainer wants when lowering one. */
export async function deadHostCounts(root: string): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const file of await collectSourceFiles(root)) {
    if (isTestPath(file.path)) continue;
    for (const site of scanDeadHost(file.path, file.source)) {
      counts[packageOf(site.path)] = (counts[packageOf(site.path)] ?? 0) + 1;
    }
  }
  return counts;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const unpin = flagList(args, 'unpin');
  if (unpin.length > 0) {
    const lowered = await applyDeadHostUnpin(root, unpin, await deadHostCounts(root));
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
    const gaps = await deadHostGaps(root);
    report(
      {
        ok: gaps.length === 0,
        script: SCRIPT,
        summary:
          gaps.length === 0
            ? `no shipped source builds a URL on ${HOST}`
            : `${String(gaps.length)} package(s) off the dead-docs-host ratchet`,
        findings: gaps.map(deadHostFindingFor),
        data: { counts: await deadHostCounts(root) },
      },
      args.json,
    );
  }
}
