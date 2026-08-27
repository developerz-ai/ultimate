#!/usr/bin/env bun
// Enforce, as a ratchet, that every `node:` import carries a `why:` comment on it or directly above.
//
// Root `CLAUDE.md`: "Bun only. No Node-specific APIs unless via `node:` and unavoidable, and then
// **with a comment saying why**." Nothing read that sentence, so per axiom 3 the second half of the
// rule did not exist: measured 2026-08-23, 238 of the 4,027 files under `packages/` and `scripts/`
// import a `node:` builtin and the gate had no opinion about any of them. Issue #280 counted 119 of
// 210 and the growth between the two counts is the argument for a rule over a sweep.
//
// WHY THE COMMENT IS THE RULE AND THE IMPORT IS NOT. `node:` is not banned — `writeSync` on fd 1 is
// the only synchronous stdout write Bun has, `mkdtemp` is the only temp-directory API, and
// `node:async_hooks` is the ALS seam every scope in the framework opens through. What is banned is
// reaching for one without saying which Bun native was missing, because that sentence is the only
// thing that lets the next agent delete the import when Bun ships the native.
//
// A TEST FILE IS SOURCE, `As of 2026-08-26`. `checkNodeImports` opened with
// `if (isTestPath(file.path)) continue` at both of its walks, so the SCANNER read every test file
// and the RATCHET dropped every finding: measured, 404 unexplained imports across 164 test files
// under a green `bun run node-imports`, and `storage` — flagged by review on #364 — had no row in
// the pin table at all. `CLAUDE.md`'s non-negotiable exempts nothing, and it records this exact
// mechanism happening once before: "`checkErrorFixes` skips test files, so the rule was prose there
// and 422 sites accumulated under a green gate". Issue #365.
//
// A LITERAL `why:`, not "a comment nearby". A token is greppable and a paragraph is not, and the
// rule has to be decidable from text: `scripts/lib/log.ts` already writes the sentence this asks
// for, in a doc comment ending "A node: API, and unavoidable — Bun has no synchronous stdout write
// of its own", and the token is what makes that a machine-checkable claim rather than good prose.
//
//   bun run node-imports  ·  bun run scripts/node-imports.ts [--json]
//   bun run scripts/node-imports.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import { maskLiterals } from '@ultimat3/cli';
import { collectSourceFiles, type SourceFile } from './boundaries';
import { flagList, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import {
  applyNodeImportUnpin,
  NODE_IMPORT_PINS,
  NODE_PINS_FILE,
  nodeImportPinnedFor,
} from './lib/node-import-pins';
import { repoRoot } from './lib/run';
import { isCode, lineOf } from './lib/source-scan';
import { packageOf } from './test-fix-citations';

const SCRIPT = 'node-imports';

/**
 * Every spelling that reaches a builtin: a static `from 'node:x'`, a side-effect `import 'node:x'`,
 * a dynamic `await import('node:x')` and a `require('node:x')`. The dynamic form is here because
 * `scripts/async-context-guard.ts`'s own header names it as the hole a static-only scan leaves.
 */
const NODE_IMPORT = /(?:from|import|require)\s*\(?\s*['"](node:[\w./-]+)['"]/g;

/** The token, anywhere in the comment. Case-insensitive so `WHY:` counts. */
const WHY = /(?:^|\/\/|\*)\s*.*\bwhy:/i;

export interface NodeImportSite {
  readonly path: string;
  readonly line: number;
  readonly specifier: string;
}

/**
 * Whether a `why:` sits on the import's own line or in the comment block directly above it.
 *
 * "Directly above" walks back over comment and blank lines only, so a `why:` written for the import
 * three lines up does not silently cover this one — and a doc comment spanning ten lines does count,
 * because that is where the framework already writes these sentences.
 */
export function hasWhy(lines: readonly string[], index: number): boolean {
  if (WHY.test(lines[index] ?? '')) return true;
  for (let above = index - 1; above >= 0; above -= 1) {
    const line = (lines[above] ?? '').trim();
    if (line === '') continue;
    if (!(line.startsWith('//') || line.startsWith('*') || line.startsWith('/*'))) return false;
    if (WHY.test(line)) return true;
  }
  return false;
}

/**
 * Every unexplained `node:` import in one file, in source order.
 *
 * INPUT vs IMPORT, and BOTH carriers are exempt. `maskLiterals` blanks comment text and string
 * contents alike while preserving every offset, so a match survives it exactly when the process
 * would really evaluate the import. A rule's own fixture spells the forbidden shape as DATA — this
 * file's own test does, `browser-barrel.test.ts` and `async-context-guard.test.ts` do, and
 * `packages/cli/src/templates/` emits app source inside template literals the CLI writes and never
 * runs. A COMMENT is the half a string-literal exemption misses, and missing it is not theoretical:
 * `async-context-guard.test.ts:106` explains the shape by quoting it. `dead-docs-host.ts` states
 * the same carve-out — "a comment naming the host as the thing that was removed cannot 404".
 * One mask closes both, and it is the one `render-modes`, `frozen-records`, `secret-compare` and
 * `proto-index` already read, so there is no second tokenizer here.
 */
export function scanNodeImports(path: string, source: string): readonly NodeImportSite[] {
  const lines = source.split('\n');
  const masked = maskLiterals(source);
  const out: NodeImportSite[] = [];
  for (const match of source.matchAll(NODE_IMPORT)) {
    if (!isCode(masked, match.index, match[0] as string)) continue;
    const line = lineOf(source, match.index);
    if (hasWhy(lines, line - 1)) continue;
    out.push({ path, line, specifier: match[1] as string });
  }
  return out;
}

export type NodeImportGapKind = 'over' | 'stale' | 'unscanned';

export interface NodeImportGap {
  readonly kind: NodeImportGapKind;
  readonly pkg: string;
  readonly found: number;
  readonly pinned: number;
  readonly first?: NodeImportSite;
}

export interface NodeImportInput {
  readonly files: readonly SourceFile[];
  readonly pins: Readonly<Record<string, number>>;
}

/** The ratchet: a package may hold what it is pinned at, may fall, may never rise. */
export function checkNodeImports(input: NodeImportInput): readonly NodeImportGap[] {
  if (input.files.length === 0) {
    return [{ kind: 'unscanned', pkg: '', found: 0, pinned: 0 }];
  }
  const found = new Map<string, NodeImportSite[]>();
  for (const file of input.files) {
    for (const site of scanNodeImports(file.path, file.source)) {
      const pkg = packageOf(site.path);
      const list = found.get(pkg) ?? [];
      list.push(site);
      found.set(pkg, list);
    }
  }
  const gaps: NodeImportGap[] = [];
  for (const pkg of new Set([...found.keys(), ...Object.keys(input.pins)])) {
    const hits = found.get(pkg) ?? [];
    const pinned = nodeImportPinnedFor(pkg, input.pins);
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

const at = (site: NodeImportSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)}`;

const overFinding = (gap: NodeImportGap): Finding => ({
  code: 'X_NODE_IMPORT_UNEXPLAINED',
  cause: `${gap.pkg} imports a node: builtin without saying why in ${String(gap.found)} place(s) and is pinned at ${String(gap.pinned)} — ${at(gap.first)} imports ${gap.first?.specifier ?? 'node:'} and no comment says which Bun native was missing, so nobody can tell whether it is still unavoidable`,
  fix: `add a comment above ${at(gap.first)} beginning "why:" and naming the Bun API that does not exist — e.g. // why: Bun has no synchronous stdout write, and process.stdout.write drops its queue on exit`,
  at: at(gap.first),
});

const staleFinding = (gap: NodeImportGap): Finding => ({
  code: 'X_NODE_IMPORT_PIN_STALE',
  cause: `${gap.pkg} is pinned at ${String(gap.pinned)} unexplained node: import(s) and has ${String(gap.found)} — the pin is above what this tree contains, so it would let ${String(gap.pinned - gap.found)} back in`,
  fix: `bun run scripts/node-imports.ts --unpin ${gap.pkg}`,
  at: NODE_PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_NODE_IMPORT_UNSCANNED',
  cause:
    'no source file was read, so every package reports zero and the ratchet enforces nothing — a glob that matches nothing reads exactly like a tree of pure Bun',
  fix: 'edit SOURCE_PATTERNS in scripts/boundaries.ts so it matches this repo layout, then bun run scripts/node-imports.ts',
  at: 'scripts/boundaries.ts',
});

const FINDINGS: Readonly<Record<NodeImportGapKind, (gap: NodeImportGap) => Finding>> = {
  over: overFinding,
  stale: staleFinding,
  unscanned: unscannedFinding,
};

export const nodeImportFindingFor = (gap: NodeImportGap): Finding => FINDINGS[gap.kind](gap);

export const nodeImportGaps = async (root: string): Promise<readonly NodeImportGap[]> =>
  checkNodeImports({ files: await collectSourceFiles(root), pins: NODE_IMPORT_PINS });

/** What this rule contributes to `x verify`'s `unit` step, through `node-imports.test.ts`. */
export const nodeImportFindings = async (root: string): Promise<readonly Finding[]> =>
  (await nodeImportGaps(root)).map(nodeImportFindingFor);

/** Every site per package, for `--unpin` and for the number a maintainer wants when lowering one. */
export async function nodeImportCounts(root: string): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const file of await collectSourceFiles(root)) {
    for (const site of scanNodeImports(file.path, file.source)) {
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
    const lowered = await applyNodeImportUnpin(root, unpin, await nodeImportCounts(root));
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
    const gaps = await nodeImportGaps(root);
    report(
      {
        ok: gaps.length === 0,
        script: SCRIPT,
        summary:
          gaps.length === 0
            ? 'every node: import above its pin says why it is unavoidable'
            : `${String(gaps.length)} package(s) off the node-import ratchet`,
        findings: gaps.map(nodeImportFindingFor),
        data: { counts: await nodeImportCounts(root) },
      },
      args.json,
    );
  }
}
