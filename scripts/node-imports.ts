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

import { maskLiterals } from '../packages/core/src/source-mask';
import type { SourceFile } from './boundaries';
import { corpus } from './lib/corpus';
import type { Finding } from './lib/log';
import { NODE_IMPORT_PINS, NODE_PINS_FILE } from './lib/node-import-pins';
import type { PinTable, RatchetGap } from './lib/ratchet';
import { ratchetGaps, ratchetMain } from './lib/ratchet';
import type { SiteProbe } from './lib/ratchet-sites';
import { leadSite, newSitesFirst, siteList, siteTarget } from './lib/ratchet-sites';
import { isCode, lineOf } from './lib/source-scan';

const SCRIPT = 'node-imports';
const EXPLAIN = 'bun run scripts/node-imports.ts --explain --json lists every one';

/**
 * Node's own builtins, as a BARE specifier reaches them — `'fs'`, `require('child_process')`. Bun
 * resolves the bare name to the same builtin, so a scan for `node:` alone let the unprefixed
 * spelling skip the `why:` this rule asks for (K17). Biome's `useNodejsImportProtocol`, an error
 * in `biome.json`, then demands the prefix; this list is what keeps the sentence owed either way.
 * Written out, not read from `node:module`'s `builtinModules`: Bun's copy also lists `bun`, `ws`
 * and `undici`, which are not Node APIs, and a fact that moves with the runtime moves the ratchet.
 */
const BARE_BUILTINS = new Set(
  (
    'assert async_hooks buffer child_process cluster console constants crypto dgram ' +
    'diagnostics_channel dns domain events fs http http2 https inspector module net os path ' +
    'perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls ' +
    'trace_events tty url util v8 vm wasi worker_threads zlib'
  ).split(' '),
);

/**
 * Every spelling that reaches a builtin: a static `from 'node:x'`, a side-effect `import 'node:x'`,
 * a dynamic `await import('node:x')` — the specifier in any quote, a backtick included, so long as
 * it interpolates nothing — a `require('node:x')` and `process.getBuiltinModule('node:x')`, which
 * Bun implements and which takes no `import` keyword at all (sweep 11). Each with or without the
 * prefix.
 * The dynamic form is here because `scripts/async-context-guard.ts`'s own header names it as the
 * hole a static-only scan leaves. A bare candidate counts only when its root is in BARE_BUILTINS.
 * The keyword must stand alone: after `.`/`?.` it names a method (`loader.require('fs')`,
 * `Buffer.from('fs')`), after an identifier character it is part of one (`myrequire`). Neither
 * reaches a builtin, so a finding there would ask a `why:` of an import that never happens.
 */
const NODE_IMPORT =
  /(?:(?<![\w$]|\.\s*)(?:from|import|require)|\bgetBuiltinModule)\s*\(?\s*(['"`])((?:node:)?[\w./-]+)\1/g;

/** `node:fs`, `fs`, `fs/promises` — and not `fsevents`, `./fs` or `bun`. */
const isBuiltinSpecifier = (specifier: string): boolean =>
  specifier.startsWith('node:') || BARE_BUILTINS.has(specifier.split('/')[0] as string);

/** The token, anywhere in the comment. Case-insensitive so `WHY:` counts. */
const WHY = /(?:^|\/\/|\*)\s*.*\bwhy:/i;

export interface NodeImportSite {
  readonly path: string;
  readonly line: number;
  readonly specifier: string;
}

/** A line that ENDS a static `node:` import and carries nothing after it — no trailing comment. */
const NODE_IMPORT_END =
  /^(?:import\b.*|\}\s*)from\s*['"]((?:node:)?[\w./-]+)['"];?$|^import\s*['"]((?:node:)?[\w./-]+)['"];?$/;

/** A line ending a static import of a builtin, either spelling — one member of a `why:` block. */
const endsNodeImport = (line: string): boolean => {
  const match = NODE_IMPORT_END.exec(line);
  return match !== null && isBuiltinSpecifier((match[1] ?? match[2]) as string);
};

/** The line a wrapped import opens on: `} from 'node:x'` closes a statement begun by `import {`. */
const importStart = (lines: readonly string[], index: number): number => {
  if (!(lines[index] ?? '').trimStart().startsWith('}')) return index;
  for (let above = index - 1; above >= 0; above -= 1) {
    if (/^\s*import\b/.test(lines[above] ?? '')) return above;
  }
  return index;
};

/**
 * Whether a `why:` sits on the import's own line, in the comment block directly above it, or
 * above the contiguous block of `node:` imports it belongs to.
 *
 * ONE SENTENCE PER BLOCK. `mkdtemp` and `tmpdir` are reached for together and one `why:` above the
 * pair says so; the second import used to count as unexplained, which made authors repeat the
 * sentence. What ends a block is anything that is not a `node:` import: a blank line, a statement,
 * an import of anything else — so a `why:` three statements up still covers nothing. A `why:`
 * trailing one import is that import's alone. A doc comment spanning ten lines does count, because
 * that is where the framework already writes these sentences.
 */
export function hasWhy(lines: readonly string[], index: number): boolean {
  if (WHY.test(lines[index] ?? '')) return true;
  // A blank line may sit between a comment and the import it explains, never between two imports
  // of one block: seen on the way up, it ends the walk at the next import.
  let blank = false;
  for (let above = importStart(lines, index) - 1; above >= 0; above -= 1) {
    const line = (lines[above] ?? '').trim();
    if (line === '') {
      blank = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) {
      if (WHY.test(line)) return true;
      continue;
    }
    if (blank || !endsNodeImport(line)) return false;
    above = importStart(lines, above);
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
export function scanNodeImports(
  path: string,
  source: string,
  masked: string = maskLiterals(source),
): readonly NodeImportSite[] {
  const lines = source.split('\n');
  const out: NodeImportSite[] = [];
  for (const match of source.matchAll(NODE_IMPORT)) {
    const specifier = match[2] as string;
    if (!isBuiltinSpecifier(specifier)) continue;
    if (!isCode(masked, match.index, match[0] as string)) continue;
    const line = lineOf(source, match.index);
    if (hasWhy(lines, line - 1)) continue;
    out.push({ path, line, specifier });
  }
  return out;
}

export type NodeImportGap = RatchetGap<NodeImportSite>;

export interface NodeImportInput {
  readonly files: readonly SourceFile[];
  readonly pins: PinTable;
}

/** The ratchet over fixture files: a package may hold what it is pinned at, may fall, never rise. */
export const checkNodeImports = (input: NodeImportInput): readonly NodeImportGap[] =>
  ratchetGaps(
    input.files.flatMap((file) => scanNodeImports(file.path, file.source)),
    input.pins,
    input.files.length > 0,
  );

const at = (site: NodeImportSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)}`;

/** Every site, new ones first — the package's first is usually one its pin already allows. */
const overFinding = (gap: NodeImportGap): Finding => ({
  code: 'X_NODE_IMPORT_UNEXPLAINED',
  cause: `${gap.pkg} imports a node: builtin without saying why in ${String(gap.found)} place(s) and is pinned at ${String(gap.pinned)} — ${siteList(gap, (site) => `${at(site)} (${site.specifier})`, EXPLAIN)} — and no comment says which Bun native was missing, so nobody can tell whether it is still unavoidable`,
  fix: `add a comment above ${siteTarget(gap, at)} beginning "why:" and naming the Bun API that does not exist — e.g. // why: Bun has no synchronous stdout write, and process.stdout.write drops its queue on exit`,
  at: at(leadSite(gap)),
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
  fix: 'edit PATTERNS in scripts/lib/corpus.ts so it matches this repo layout, then bun run scripts/node-imports.ts',
  at: 'scripts/lib/corpus.ts',
});

/** Every unexplained import in the tree, read off the shared corpus and its cached mask. */
export const nodeImportSites = async (root: string): Promise<readonly NodeImportSite[]> =>
  (await corpus(root, 'source')).flatMap((file) =>
    scanNodeImports(file.path, file.source, file.masked),
  );

export const nodeImportFindingFor = (gap: NodeImportGap): Finding =>
  gap.kind === 'over'
    ? overFinding(gap)
    : gap.kind === 'stale'
      ? staleFinding(gap)
      : unscannedFinding();

const PROBE: SiteProbe<NodeImportSite> = {
  rescan: (path, source) => scanNodeImports(path, source),
  line: (site) => site.line,
};

export const nodeImportGaps = async (root: string): Promise<readonly NodeImportGap[]> =>
  newSitesFirst(root, ratchetGaps(await nodeImportSites(root), NODE_IMPORT_PINS, true), PROBE);

/** What this rule contributes to `x verify`'s `unit` step, through `node-imports.test.ts`. */
export const nodeImportFindings = async (root: string): Promise<readonly Finding[]> =>
  (await nodeImportGaps(root)).map(nodeImportFindingFor);

if (import.meta.main) {
  await ratchetMain({
    script: SCRIPT,
    pinsFile: NODE_PINS_FILE,
    pins: NODE_IMPORT_PINS,
    sites: nodeImportSites,
    findingFor: nodeImportFindingFor,
    probe: PROBE,
    clean: 'every node: import above its pin says why it is unavoidable',
  });
}
