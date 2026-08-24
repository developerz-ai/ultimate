#!/usr/bin/env bun
// Enforce that every leaf key of every DECLARATION an app writes — the type each primitive and
// each `define*` factory takes — is read by something in `packages/*/src`. `config-readers.ts` asks
// this of `AppConfig` alone; this is the same question over the other twenty declaration surfaces,
// which had no rule at all.
//
// WHY IT EXISTS. `packages/render/src/route.ts` declared `budget.css`, `budget.cls` and
// `budget.tbt` on the route contract; `registerRoute` flattens a budget to `budgetJs` + `budgetLcp`
// and every reader downstream (`app-manifest.ts`, `budgets.ts`, `cmd-routes.ts`, admin's dev data)
// reads only those two. So an author writing `budget: { cls: 0.1 }` was ignored in silence while
// `x verify`'s own `budgets` step reported green — the same defect `jobs.driver` and
// `realtime.tier` were, one declaration surface over, and the rule that catches those could not see
// it.
//
// WHAT COUNTS AS A READ: the key as a property access (`entry.config.budget.js`) or a destructured
// binding (`const { disks } = config`), in any shipped file of any package — INCLUDING the file
// that declares it, because a factory sits beside its own type (`defineStorage` reads
// `config.disks` two lines under `StorageConfig`). Counting only OTHER files reported nine live
// keys as dead.
//
// WHAT IT CANNOT SEE, measured rather than guessed: a key whose bare name is an ordinary word in
// its own package. `budget.css` is read by nothing and this rule calls it read, because
// `packages/render/` says `css` about stylesheets in two files. Two tightenings were measured and
// REJECTED: requiring the qualified `<parent>.<key>` spelling reports 33 of 57 nested leaves and 31
// of those are live (a reader names the parameter, not the property), and requiring a bare hit in a
// file that also mentions the parent reports 11 with 4 provably false — `deprecation.since` is read
// in `packages/action/src/deprecation.ts:56` under a parameter called `deprecation`. A guard with
// false positives no edit can clear is worse than no guard.
//
// THE MIRROR QUESTION — "can this key be WRITTEN by an app at all?" — is NOT here, and that is a
// measurement rather than an omission. Across all 30 packages there are exactly three `<X>` /
// `<X>Input` config pairs — `HttpConfig` (19 keys / 19), `AppConfig` (14 / 14) and `AiConfig`
// (1 / 1) — and every one is complete; the other four name pairs the same match finds
// (`IslandVerdict`, `IslandCollector`, `Chunk`, `Brand`) are not config pairs at all, so a rule
// built on the name would be 4/7 false on its first run. A per-package type pin is the right
// enforcement at that scale and costs six lines: `packages/http/src/type-pins.ts` carries the one
// this tree needed (`_EveryHttpConfigKeyIsSettable`), and it is a BUILD error rather than a scan.
//
//   bun run scripts/declaration-readers.ts [--json]
//   bun run scripts/declaration-readers.ts --unpin <leaf>[,<leaf>]   # drop a stale waiver

import { maskLiterals } from '@ultimat3/cli';
import { readPattern } from './config-readers';
import { flagList, parseScriptArgs } from './lib/args';
import {
  applyDeclarationReaderUnpin,
  DECLARATION_PINS_FILE,
  DECLARATION_READER_PINS,
  type DeclarationReaderPin,
  declarationReaderPinIsBlank,
  declarationReaderPinnedFor,
} from './lib/declaration-reader-pins';
import type { DeclarationSource, DeclaredLeaf } from './lib/declaration-scan';
import { declarationLeaves } from './lib/declaration-scan';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'declaration-readers';

/** Shipped source of every package — the same corpus `config-readers.ts` reads, for one answer. */
const SOURCE_GLOB = 'packages/*/src/**/*.{ts,tsx}';

export type DeclarationReaderGapKind = 'unread' | 'stale' | 'unscanned';

/** Why a pin stopped holding. One code, two causes — the repair differs and the reader must know. */
export type DeclarationStaleCause = 'now-read' | 'key-deleted';

export interface DeclarationReaderGap {
  readonly kind: DeclarationReaderGapKind;
  readonly leaf: string;
  /** Where the key is declared, for the finding to point at. */
  readonly at?: string;
  readonly reason?: string;
  readonly stale?: DeclarationStaleCause;
  /** Set when a row exists and its sentence is blank. */
  readonly blank?: boolean;
}

export interface DeclarationReaderInput {
  readonly leaves: readonly DeclaredLeaf[];
  readonly files: readonly DeclarationSource[];
  readonly pins: Readonly<Record<string, DeclarationReaderPin>>;
}

/** The ratchet: an unread key must be pinned WITH a reason, and a pin that stopped holding must go. */
export function checkDeclarationReaders(
  input: DeclarationReaderInput,
): readonly DeclarationReaderGap[] {
  if (input.files.length === 0 || input.leaves.length === 0) {
    return [
      { kind: 'unscanned', leaf: input.files.length === 0 ? SOURCE_GLOB : 'declaration root' },
    ];
  }
  const gaps: DeclarationReaderGap[] = [];
  const read = new Set<string>();
  for (const leaf of input.leaves) {
    const pattern = readPattern(leaf.key);
    if (input.files.some((file) => pattern.test(file.text))) read.add(leaf.leaf);
  }
  const seen = new Set<string>();
  for (const leaf of input.leaves) {
    if (read.has(leaf.leaf) || seen.has(leaf.leaf)) continue;
    if (declarationReaderPinnedFor(leaf.leaf, input.pins)) continue;
    seen.add(leaf.leaf);
    gaps.push({
      kind: 'unread',
      leaf: leaf.leaf,
      at: leaf.path,
      ...(declarationReaderPinIsBlank(leaf.leaf, input.pins) ? { blank: true } : {}),
    });
  }
  const declared = new Set(input.leaves.map((leaf) => leaf.leaf));
  for (const [leaf, pin] of Object.entries(input.pins)) {
    if (read.has(leaf)) gaps.push({ kind: 'stale', leaf, reason: pin.reason, stale: 'now-read' });
    else if (!declared.has(leaf)) {
      gaps.push({ kind: 'stale', leaf, reason: pin.reason, stale: 'key-deleted' });
    }
  }
  return gaps;
}

const unreadFinding = (gap: DeclarationReaderGap): Finding => ({
  code: 'X_DECLARED_KEY_UNREAD',
  cause:
    gap.blank === true
      ? `${gap.leaf} is declared in ${gap.at ?? ''} and no file in packages/*/src reads it, and its row in ${DECLARATION_PINS_FILE} carries no reason — a waiver that says nothing waives nothing`
      : `${gap.leaf} is declared in ${gap.at ?? ''} and no file in packages/*/src reads it — an app that sets it is setting a switch with no wire, exactly as route budget.cls and budget.tbt were`,
  fix: `delete ${gap.leaf} from ${gap.at ?? 'its declaration'}, or wire it and prove the read; to keep it deliberately, add it to DECLARATION_READER_PINS in ${DECLARATION_PINS_FILE} with the sentence naming who reads it`,
  at: gap.at ?? DECLARATION_PINS_FILE,
});

const STALE_CAUSE: Readonly<Record<DeclarationStaleCause, (gap: DeclarationReaderGap) => string>> =
  {
    'now-read': (gap) =>
      `${gap.leaf} is pinned as read by nobody in packages/*/src ("${gap.reason ?? ''}") and now has a reader — the pin would let the next dead key in beside it`,
    'key-deleted': (gap) =>
      `${gap.leaf} is pinned as read by nobody in packages/*/src ("${gap.reason ?? ''}") and no declaration declares it any more — the pin outlived its key, so it records a debt that cannot come due`,
  };

const staleCauseOf = (gap: DeclarationReaderGap): string => {
  const cause = gap.stale ?? 'now-read';
  // `Object.hasOwn`, never a bare `STALE_CAUSE[cause]`: the table is an object literal, so it holds
  // every name on `Object.prototype` and a key that is data answers with a FUNCTION. The union
  // makes that unreachable today and `scripts/proto-index.ts` is right to refuse it anyway — this
  // is the read that made `useService('constructor')` answer with `Object`.
  return Object.hasOwn(STALE_CAUSE, cause) ? STALE_CAUSE[cause](gap) : STALE_CAUSE['now-read'](gap);
};

const staleFinding = (gap: DeclarationReaderGap): Finding => ({
  code: 'X_DECLARATION_READER_PIN_STALE',
  cause: staleCauseOf(gap),
  fix: `bun run scripts/declaration-readers.ts --unpin ${gap.leaf}`,
  at: DECLARATION_PINS_FILE,
});

const unscannedFinding = (gap: DeclarationReaderGap): Finding => ({
  code: 'X_DECLARATION_READERS_UNSCANNED',
  cause: `nothing was walked for ${gap.leaf}, so every declaration key reports a reader and the rule enforces nothing — a glob that matches no file, and a factory signature this scan no longer recognises, both read exactly like a tree with no dead key in it`,
  fix: `check that ${SOURCE_GLOB} still matches this repo layout and that a primitive factory still takes a named interface, then bun run scripts/declaration-readers.ts --json`,
  at: 'scripts/lib/declaration-scan.ts',
});

const FINDINGS: Readonly<Record<DeclarationReaderGapKind, (gap: DeclarationReaderGap) => Finding>> =
  {
    unread: unreadFinding,
    stale: staleFinding,
    unscanned: unscannedFinding,
  };

export const declarationReaderFindingFor = (gap: DeclarationReaderGap): Finding =>
  // Guarded for `staleCauseOf`'s reason. The `Record<Kind, …>` annotation is what makes forgetting
  // a kind a build error; `Object.hasOwn` is what makes reading one safe.
  Object.hasOwn(FINDINGS, gap.kind) ? FINDINGS[gap.kind](gap) : unscannedFinding(gap);

/**
 * The tree's own answer. Every file is read through `maskLiterals` — a string's contents blanked,
 * offsets preserved — because `packages/cli/src/templates/*` EMITS app source inside template
 * literals, and a template that writes `budget: { js: '40kb' }` is a writer of the key, never a
 * reader of it.
 */
export async function declarationReaderInput(root: string): Promise<DeclarationReaderInput> {
  const files: DeclarationSource[] = [];
  for (const found of new Bun.Glob(SOURCE_GLOB).scanSync({ cwd: root })) {
    const path = found.split('\\').join('/');
    // A test reading a key is not the key being wired — the rule `config-readers.ts` states.
    if (path.includes('.test.')) continue;
    files.push({ path, text: maskLiterals(await Bun.file(`${root}/${path}`).text()) });
  }
  return { leaves: declarationLeaves(files), files, pins: DECLARATION_READER_PINS };
}

export const declarationReaderGaps = async (
  root: string,
): Promise<readonly DeclarationReaderGap[]> =>
  checkDeclarationReaders(await declarationReaderInput(root));

/** What this rule contributes to `x verify`'s `unit` step, through `declaration-readers.test.ts`. */
export const declarationReaderFindings = async (root: string): Promise<readonly Finding[]> =>
  (await declarationReaderGaps(root)).map(declarationReaderFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const unpin = flagList(args, 'unpin');
  const input = await declarationReaderInput(root);
  const gaps = checkDeclarationReaders(input);
  if (unpin.length > 0) {
    const stale = gaps.filter((gap) => gap.kind === 'stale').map((gap) => gap.leaf);
    const dropped = await applyDeclarationReaderUnpin(root, unpin, stale);
    report(
      {
        ok: true,
        script: SCRIPT,
        summary:
          dropped.length === 0
            ? 'nothing to drop — every named key is still read by nobody, so its pin still holds'
            : `dropped ${String(dropped.length)} pin(s): ${dropped.join(', ')}`,
        findings: [],
      },
      args.json,
    );
  } else {
    const roots = new Set(input.leaves.map((leaf) => leaf.root));
    report(
      {
        ok: gaps.length === 0,
        script: SCRIPT,
        summary:
          gaps.length === 0
            ? `${String(input.leaves.length)} declaration leaf keys across ${String(roots.size)} declaration roots, every one read by shipped code or pinned with a reason`
            : `${String(gaps.length)} of ${String(input.leaves.length)} declaration leaf keys are off the ratchet`,
        findings: gaps.map(declarationReaderFindingFor),
        data: { roots: [...roots].sort(), leaves: input.leaves.length, files: input.files.length },
      },
      args.json,
    );
  }
}
