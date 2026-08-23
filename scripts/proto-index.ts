#!/usr/bin/env bun
// Enforce, as a ratchet, that a plain object literal typed `Record<…>` is never READ with a
// computed key that is not a string literal. `TABLE[name]` where `name` is data answers an
// `Object.prototype` member instead of `undefined`.
//
// THIRTEEN INSTANCES ACROSS FOUR SWEEPS, six of them fixed BEFORE this one, and the repair written
// out verbatim at `packages/storage/src/storage.ts:45-50` — and it kept coming back, which is the
// whole argument for a rule over a sweep. This sweep alone found:
//
//   `core/context.ts:203`   `useService('constructor')` answered the `Object` function, out of the
//                           function whose entire job is throwing `X_SERVICE_MISSING`.
//   `schema/errors.ts:120`  a `TypeError` thrown from INSIDE an error constructor, replacing the
//                           caller's own failure with one about the failure.
//   `ai/vector-scope.ts:59` plus a `__proto__` WRITE that silently widened a security scope.
//   `ui/fake-dom.ts:79`     `querySelectorAll('[constructor]')` matched every element.
//   and `db/foreign-key.ts`, `cache/purge-fastly.ts`, `seo/images.ts`, `http/rate-limit.ts`,
//   three in `auth` and three in `admin/dev/`.
//
// `Object.hasOwn(TABLE, key)` and a `Map` are the two repairs, both with in-repo precedent.
//
// WHAT IS NOT REPORTED, recognised rather than pinned: a STRING LITERAL key (`TABLE['web']` cannot
// be `'constructor'` unless somebody typed it), a NULL-PROTOTYPE table (`packages/i18n/src/catalog.ts`
// is fully null-prototyped and says why), a read already guarded by `Object.hasOwn` or `in` on the
// same or the preceding line, and a WRITE — `out[key] = value` builds a table rather than reading
// one, and the prototype answer never reaches a caller.
//
//   bun run proto-index  ·  bun run scripts/proto-index.ts [--json]
//   bun run scripts/proto-index.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import { maskLiterals } from '@ultimat3/cli';
import { collectSourceFiles, type SourceFile } from './boundaries';
import { flagList, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import {
  applyProtoIndexUnpin,
  PROTO_INDEX_PINS,
  PROTO_PINS_FILE,
  protoIndexPinnedFor,
} from './lib/proto-index-pins';
import { repoRoot } from './lib/run';
import { isTestPath, lineOf } from './lib/source-scan';
import { packageOf } from './test-fix-citations';

const SCRIPT = 'proto-index';

/** `const X: Readonly<Record<K, V>> = {…}` — the annotation form, `Partial<>` and all. */
const ANNOTATED = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*:\s*(?:Readonly<)?(?:Partial<)?Record\s*</g;

/** `const X = Object.freeze<Record<K, V>>({…})` — the form `frozen-records.ts` requires. */
const FROZEN =
  /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*Object\.freeze\s*<\s*(?:Readonly<)?(?:Partial<)?Record\s*</g;

/**
 * A table with no prototype to walk into. `packages/i18n/src/catalog.ts` is built this way on
 * purpose and its header says why — so the rule RECOGNISES the repair rather than pinning the file,
 * which is the difference between a rule that teaches the fix and one that records a debt.
 */
const NULL_PROTO = /Object\.create\s*\(\s*null\s*\)|__proto__\s*:\s*null/;

/** Every `Record<…>` object literal this file declares, or nothing when it is null-prototyped. */
export function recordTables(code: string): ReadonlySet<string> {
  const names = new Set<string>();
  if (NULL_PROTO.test(code)) return names;
  for (const match of code.matchAll(ANNOTATED)) names.add(match[1] as string);
  for (const match of code.matchAll(FROZEN)) names.add(match[1] as string);
  return names;
}

export interface ProtoIndexSite {
  readonly path: string;
  readonly line: number;
  readonly table: string;
  /** The index expression, so the finding can quote it back. */
  readonly key: string;
}

/** The `]` closing the `[` at `open`, or the end of the file. */
const closingBracket = (code: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index] as string;
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return code.length;
};

/**
 * Whether what follows the `]` is an ASSIGNMENT — `=`, `+=`, `??=` — rather than a read. A write
 * builds the table; the prototype's answer is overwritten and never reaches a caller.
 * `===` and `==` are reads and stay reported.
 */
const isWrite = (tail: string): boolean =>
  /^(?:[+\-*/%|&^]|\*\*|<<|>>>?|\?\?|\|\||&&)?=[^=]/.test(tail);

/** The two repairs, recognised on the same line or the two above it. */
const guarded = (context: string, table: string): boolean =>
  context.includes(`Object.hasOwn(${table}`) ||
  new RegExp(`\\bin\\s+${table}(?![\\w$])`).test(context);

/**
 * Every prototype-reachable read in one file, in source order.
 *
 * Read from `maskLiterals`' output — a string's contents blanked, every offset preserved — so a
 * scaffold template emitting `TABLE[kind]` inside a template literal is not read as this file's own
 * index, and a literal key is recognisable by the quote that survived the mask.
 */
export function scanProtoIndex(path: string, source: string): readonly ProtoIndexSite[] {
  const code = maskLiterals(source);
  const tables = recordTables(code);
  const sites: ProtoIndexSite[] = [];
  for (const table of tables) {
    const use = new RegExp(`(?<![\\w$.])${RegExp.escape(table)}\\s*\\[`, 'g');
    for (const match of code.matchAll(use)) {
      const open = match.index + match[0].length - 1;
      const close = closingBracket(code, open);
      const key = code.slice(open + 1, close).trim();
      // A literal key cannot be `'constructor'` unless somebody typed it, and then it is a
      // deliberate read of a member that exists.
      if (/^['"`]/.test(key)) continue;
      if (isWrite(code.slice(close + 1).trimStart())) continue;
      const lineStart = code.lastIndexOf('\n', match.index) + 1;
      const twoAbove = Math.max(0, code.lastIndexOf('\n', Math.max(0, lineStart - 2)) - 160);
      if (guarded(code.slice(twoAbove, close), table)) continue;
      sites.push({ path, line: lineOf(code, match.index), table, key });
    }
  }
  return sites.sort((a, b) => a.line - b.line);
}

export type ProtoIndexGapKind = 'over' | 'stale' | 'unscanned';

export interface ProtoIndexGap {
  readonly kind: ProtoIndexGapKind;
  readonly pkg: string;
  readonly found: number;
  readonly pinned: number;
  readonly first?: ProtoIndexSite;
}

export interface ProtoIndexInput {
  readonly files: readonly SourceFile[];
  readonly pins: Readonly<Record<string, { readonly count: number; readonly reason: string }>>;
}

/** The ratchet: a package may hold what it is pinned at, may fall, may never rise. */
export function checkProtoIndex(input: ProtoIndexInput): readonly ProtoIndexGap[] {
  if (input.files.length === 0) {
    return [{ kind: 'unscanned', pkg: '', found: 0, pinned: 0 }];
  }
  const found = new Map<string, ProtoIndexSite[]>();
  for (const file of input.files) {
    if (isTestPath(file.path)) continue;
    for (const site of scanProtoIndex(file.path, file.source)) {
      const pkg = packageOf(site.path);
      const list = found.get(pkg) ?? [];
      list.push(site);
      found.set(pkg, list);
    }
  }
  const gaps: ProtoIndexGap[] = [];
  for (const pkg of new Set([...found.keys(), ...Object.keys(input.pins)])) {
    const hits = found.get(pkg) ?? [];
    const pinned = protoIndexPinnedFor(pkg, input.pins);
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

const at = (site: ProtoIndexSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)}`;

const overFinding = (gap: ProtoIndexGap): Finding => ({
  code: 'X_PROTO_CHAIN_INDEX',
  cause: `${gap.pkg} reads a Record object literal with a computed key in ${String(gap.found)} place(s) and is pinned at ${String(gap.pinned)} — ${at(gap.first)} evaluates ${gap.first?.table ?? ''}[${gap.first?.key ?? ''}], and when that key is the string "constructor", "toString" or "__proto__" the answer is an Object.prototype member rather than undefined`,
  fix: `guard the read at ${at(gap.first)} with Object.hasOwn(${gap.first?.table ?? ''}, ${gap.first?.key ?? ''}) before indexing, or make ${gap.first?.table ?? ''} a Map; if the table is deliberately prototype-free, build it with Object.create(null) and this rule stops reporting it`,
  at: at(gap.first),
});

const staleFinding = (gap: ProtoIndexGap): Finding => ({
  code: 'X_PROTO_CHAIN_INDEX_PIN_STALE',
  cause: `${gap.pkg} is pinned at ${String(gap.pinned)} prototype-reachable read(s) and has ${String(gap.found)} — the pin is above what this tree contains, so it would let ${String(gap.pinned - gap.found)} back in`,
  fix: `bun run scripts/proto-index.ts --unpin ${gap.pkg}`,
  at: PROTO_PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_PROTO_CHAIN_INDEX_UNSCANNED',
  cause:
    'no source file was read, so every package reports zero and the ratchet enforces nothing — a glob that matches nothing reads exactly like a tree with no unguarded index in it',
  fix: 'edit SOURCE_PATTERNS in scripts/boundaries.ts so it matches this repo layout, then bun run scripts/proto-index.ts',
  at: 'scripts/boundaries.ts',
});

const FINDINGS: Readonly<Record<ProtoIndexGapKind, (gap: ProtoIndexGap) => Finding>> = {
  over: overFinding,
  stale: staleFinding,
  unscanned: unscannedFinding,
};

export const protoIndexFindingFor = (gap: ProtoIndexGap): Finding => FINDINGS[gap.kind](gap);

export const protoIndexGaps = async (root: string): Promise<readonly ProtoIndexGap[]> =>
  checkProtoIndex({ files: await collectSourceFiles(root), pins: PROTO_INDEX_PINS });

/** What this rule contributes to `x verify`'s `unit` step, through `proto-index.test.ts`. */
export const protoIndexFindings = async (root: string): Promise<readonly Finding[]> =>
  (await protoIndexGaps(root)).map(protoIndexFindingFor);

/** Every site per package, for `--unpin` and for the number a maintainer wants when lowering one. */
export async function protoIndexCounts(root: string): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const file of await collectSourceFiles(root)) {
    if (isTestPath(file.path)) continue;
    for (const site of scanProtoIndex(file.path, file.source)) {
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
    const lowered = await applyProtoIndexUnpin(root, unpin, await protoIndexCounts(root));
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
    const gaps = await protoIndexGaps(root);
    report(
      {
        ok: gaps.length === 0,
        script: SCRIPT,
        summary:
          gaps.length === 0
            ? 'no package reads a Record object literal with an unguarded computed key above its pin'
            : `${String(gaps.length)} package(s) off the prototype-index ratchet`,
        findings: gaps.map(protoIndexFindingFor),
        data: { counts: await protoIndexCounts(root) },
      },
      args.json,
    );
  }
}
