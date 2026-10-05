#!/usr/bin/env bun

// Enforce, as a ratchet, that every leaf key of `AppConfig` has at least one READER in
// `packages/*/src`. A key that is declared, defaulted, merged and read by nothing is worse than no
// key: an operator sets it, redeploys, and nothing changes.
//
// It is the framework's most repeated defect, and every instance so far was found by hand, in a
// major. `jobs.driver` accepted `'postgres' | 'redis' | 'nats'`, had no reader, and boot always
// built `createPgDriver` — 5.0.0. `realtime.heartbeatMs`, `database.urlEnv`, `database.poolSize`,
// `database.schema` — 4.0.0. `pwa.installPrompt`, `auth.afterSignInPath`, `ai.modelEnv` — 2026-08.
// Twelve keys, four releases, one rule that existed only as a sentence.
//
// WHAT COUNTS AS A READ: the key as a property access (`config.cache.driver`, `cfg.driver`) or as a
// destructured binding (`const { driver } = cache`), in any shipped file of any package except the
// declaration itself. Deliberately loose about WHOSE property it is — a package takes `CacheConfig`
// as a parameter and reads `cfg.driver`, so demanding the fully qualified path would report
// nineteen of the twenty-eight leaf keys as dead. Measured, not guessed at.
//
// AND THAT LOOSENESS IS THE THIRTEENTH INSTANCE OF THE DEFECT ABOVE. This header used to argue the
// looseness was safe because it "only ever HIDES a dead key whose name collides with an unrelated
// property" — which is the whole defect, conceded in a comment. `realtime.tier` is read by nothing
// (a type, a field, a default and a scaffold template, and no reader anywhere) and NINETEEN files
// matched the bare `tier`, `packages/policy/src/surfaces.ts` on the words `tier,` in its own file
// header. So the rule built to catch a dead key reported `✓` over one. `ambiguityOf` is the answer:
// when the bare name matches more than `AMBIGUOUS_LIMIT` files, none of them inside the section's
// own package and none spelling the qualified `<section>.<key>`, the reader set is not evidence and
// says so — `X_CONFIG_KEY_READER_AMBIGUOUS`. Nineteen readers should always have been the alarm.
//
// WHERE THE CLI'S READS COME FROM, `As of 2026-10-03`: one loader.
// `packages/cli/src/app-config-load.ts` is the only importer of an app's `app.config.ts`
// (`scripts/lib/config-import.ts`, `X_CONFIG_IMPORT_OUTSIDE_LOADER`) and hands back a typed
// `AppConfig`, so every boot reader spells `config.<section>.<key>` — the qualified form
// `qualifiedPattern` counts — where seventeen structural walks spelled `config['jobs']`, which no
// pattern here reads as a read at all.
//
// A key whose only legitimate reader is APP code (`config.defaultCurrency` in a price view) is pinned
// with the sentence saying so — and that sentence is CHECKED against both tracked apps
// (`lib/config-app-readers.ts`), because a claim nobody reads is a waiver, not a decision.
//
//   bun run scripts/config-readers.ts [--json]
//   bun run scripts/config-readers.ts --unpin <leaf>[,<leaf>]   # shrink either ratchet

import { flagList, parseScriptArgs } from './lib/args';
import type { AppSource } from './lib/config-app-readers';
import { appClaimGaps, configAppSources } from './lib/config-app-readers';
import {
  CONFIG_FILE,
  CONFIG_FILES,
  configDeclaration,
  configLeaves,
  ROOT_INTERFACE,
} from './lib/config-leaves';
import type { ConfigSource } from './lib/config-read-evidence';
import { ambiguityOf, owningPackage, readPattern } from './lib/config-read-evidence';
import {
  applyConfigReaderUnpin,
  CONFIG_AMBIGUOUS_PINS,
  CONFIG_PINS_FILE,
  CONFIG_READER_PINS,
  configAmbiguityPinnedFor,
  configReaderPinnedFor,
} from './lib/config-reader-pins';
import { CORPUS_PATTERNS, corpus } from './lib/corpus';
import { GATED_APPS } from './lib/gated-apps';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

// The declaration walk (`lib/config-leaves.ts`) and the read evidence (`lib/config-read-evidence.ts`)
// are modules of their own; every name stays importable from here, where its callers reach it.
export {
  CONFIG_FILE,
  CONFIG_FILES,
  configDeclaration,
  configLeaves,
  ROOT_INTERFACE,
} from './lib/config-leaves';
export type { ConfigSource } from './lib/config-read-evidence';
export {
  AMBIGUOUS_LIMIT,
  ambiguityOf,
  owningPackage,
  qualifiedPattern,
  readPattern,
  SECTION_PACKAGE,
} from './lib/config-read-evidence';

const SCRIPT = 'config-readers';

/** Shipped source of every package. The declaring file is excluded by the caller, not by a glob. */
const SOURCE_GLOB = CORPUS_PATTERNS.shipped.join(', ');

export type ConfigReaderGapKind =
  | 'unread'
  | 'ambiguous'
  | 'stale'
  | 'unscanned'
  | 'unexplained'
  | 'app-unread';

/**
 * The two ways a pin stops holding. One kind and one code, because the repair is the same edit
 * either way (`--unpin <leaf>`) — but the CAUSE has to say which, or the finding for a key that no
 * longer exists reads as a key that gained a reader.
 */
export type StaleCause = 'now-read' | 'key-deleted' | 'now-qualified';

export interface ConfigReaderGap {
  readonly kind: ConfigReaderGapKind;
  readonly leaf: string;
  readonly reason?: string;
  /** Set on `stale` only. */
  readonly stale?: StaleCause;
  /** Set on `ambiguous` only: how many files matched the bare leaf, and two that plainly do not read it. */
  readonly readers?: number;
  readonly colliding?: readonly string[];
}

export interface ConfigReaderInput {
  readonly leaves: readonly string[];
  readonly files: readonly ConfigSource[];
  readonly pins: Readonly<Record<string, string>>;
  /** The second table: leaves whose bare-name evidence is known to be worthless, each with why. */
  readonly ambiguousPins?: Readonly<Record<string, string>>;
  /** Both tracked apps' source — what a pin naming APP code as the reader is held to. */
  readonly appFiles?: readonly AppSource[];
}

/** The ratchet: an unread leaf must be pinned with a reason, and a pin that gained a reader must go. */
export function checkConfigReaders(input: ConfigReaderInput): readonly ConfigReaderGap[] {
  if (input.leaves.length === 0 || input.files.length === 0) {
    return [
      {
        kind: 'unscanned',
        leaf: input.leaves.length === 0 ? ROOT_INTERFACE : SOURCE_GLOB,
      },
    ];
  }
  const gaps: ConfigReaderGap[] = [];
  const ambiguousPins = input.ambiguousPins ?? {};
  const read = new Set<string>();
  const ambiguous = new Map<
    string,
    { readonly readers: number; readonly colliding: readonly string[] }
  >();
  for (const leaf of input.leaves) {
    const pattern = readPattern(leaf);
    if (input.files.some((file) => pattern.test(file.text))) read.add(leaf);
    const doubt = ambiguityOf(leaf, input.files);
    if (doubt !== undefined) ambiguous.set(leaf, doubt);
  }
  // `configReaderPinnedFor` / `configAmbiguityPinnedFor`, never a bare `Object.hasOwn`: a row whose
  // reason is BLANK waives nothing. `Object.hasOwn` asks whether a row exists and never whether it
  // says anything, so `'jobs.driver': ''` silenced this rule outright — the waiver axiom 3 refuses,
  // and the shape `declarationReaderPinnedFor` has guarded against since its first draft.
  // `configAmbiguityPinnedFor` was exported, documented and CALLED BY NOBODY until 2026-09-06.
  for (const leaf of input.leaves) {
    if (read.has(leaf) || configReaderPinnedFor(leaf, input.pins) !== undefined) continue;
    gaps.push({ kind: 'unread', leaf });
  }
  for (const [leaf, doubt] of ambiguous) {
    if (
      configAmbiguityPinnedFor(leaf, ambiguousPins) !== undefined ||
      configReaderPinnedFor(leaf, input.pins) !== undefined
    ) {
      continue;
    }
    gaps.push({ kind: 'ambiguous', leaf, readers: doubt.readers, colliding: doubt.colliding });
  }
  for (const [table, pins] of [
    [CONFIG_PINS_FILE, input.pins],
    [`${CONFIG_PINS_FILE} (CONFIG_AMBIGUOUS_PINS)`, ambiguousPins],
  ] as const) {
    for (const [leaf, reason] of Object.entries(pins)) {
      if (reason.trim() !== '') continue;
      gaps.push({ kind: 'unexplained', leaf, reason: table });
    }
  }
  // The ambiguity table ratchets in both directions too: a leaf that gained a qualified reader, or
  // one `AppConfig` no longer declares, leaves a row that would excuse the next collision for free.
  const declaredLeaves = new Set(input.leaves);
  for (const [leaf, reason] of Object.entries(ambiguousPins)) {
    if (ambiguous.has(leaf)) continue;
    gaps.push({
      kind: 'stale',
      leaf,
      reason,
      stale: declaredLeaves.has(leaf) ? 'now-qualified' : 'key-deleted',
    });
  }
  // A pin outlives its key as easily as it outlives its reader: `read` only ever holds current
  // leaves, so a pin whose `AppConfig` member was DELETED matched nothing here and stayed green
  // forever — the exact shape of waiver this ratchet exists to refuse, one level up.
  const declared = new Set(input.leaves);
  for (const [leaf, reason] of Object.entries(input.pins)) {
    if (read.has(leaf)) gaps.push({ kind: 'stale', leaf, reason, stale: 'now-read' });
    else if (!declared.has(leaf)) gaps.push({ kind: 'stale', leaf, reason, stale: 'key-deleted' });
  }
  if (input.appFiles !== undefined)
    gaps.push(...appClaimGaps(input.pins, input.appFiles, readPattern));
  return gaps;
}

const unreadFinding = (gap: ConfigReaderGap): Finding => ({
  code: 'X_CONFIG_KEY_UNREAD',
  cause: `${CONFIG_FILE} declares ${gap.leaf} and no file in packages/*/src reads it — an app that sets it is setting a switch with no wire, exactly as jobs.driver, realtime.heartbeatMs and database.urlEnv were`,
  fix: `delete ${gap.leaf} from ${CONFIG_FILE} and from defaults(), or wire it and prove the read; to keep it deliberately, add it to CONFIG_READER_PINS in ${CONFIG_PINS_FILE} with the sentence saying who reads it`,
  at: CONFIG_FILE,
});

/**
 * The alarm the old rule could not raise: nineteen files "read" `realtime.tier` and nothing did.
 * It is deliberately NOT `X_CONFIG_KEY_UNREAD` — this rule does not know the key is dead, it knows
 * the evidence that it is alive is worthless, and a finding that overstates what it measured is a
 * finding an agent learns to argue with.
 */
const ambiguousFinding = (gap: ConfigReaderGap): Finding => ({
  code: 'X_CONFIG_KEY_READER_AMBIGUOUS',
  cause: `${String(gap.readers ?? 0)} files in packages/*/src match the bare name "${gap.leaf.split('.').at(-1) ?? ''}" and none of them is in packages/${owningPackage(gap.leaf) ?? '?'}/, and no file spells the qualified ${gap.leaf} — ${(gap.colliding ?? []).join(', ')} match on unrelated properties, so this key has no evidence of a reader at all`,
  fix: `read ${gap.leaf} through its section in packages/${owningPackage(gap.leaf) ?? '?'}/src so the qualified path appears in source, or delete it from ${CONFIG_FILE} and from defaults(); to keep it deliberately, add it to CONFIG_AMBIGUOUS_PINS in ${CONFIG_PINS_FILE} with the sentence naming the reader`,
  at: CONFIG_FILE,
});

const STALE_CAUSE: Readonly<Record<StaleCause, (gap: ConfigReaderGap) => string>> = {
  'key-deleted': (gap) =>
    `${gap.leaf} is pinned as read by nobody in packages/*/src ("${gap.reason ?? ''}") and ${CONFIG_FILE} no longer declares it — the pin outlived its key, so it records a debt that cannot come due`,
  'now-read': (gap) =>
    `${gap.leaf} is pinned as read by nobody in packages/*/src ("${gap.reason ?? ''}") and now has a reader — the pin would let the next dead key in beside it`,
  'now-qualified': (gap) =>
    `${gap.leaf} is pinned as a key whose bare-name readers are not evidence ("${gap.reason ?? ''}") and a file now spells the qualified ${gap.leaf}, or one of its own package's files reads it — the doubt is settled and the row would excuse the next collision for free`,
};

const staleFinding = (gap: ConfigReaderGap): Finding => ({
  code: 'X_CONFIG_READER_PIN_STALE',
  cause: STALE_CAUSE[gap.stale ?? 'now-read'](gap),
  fix: `bun run scripts/config-readers.ts --unpin ${gap.leaf}`,
  at: CONFIG_PINS_FILE,
});

const unexplainedFinding = (gap: ConfigReaderGap): Finding => ({
  code: 'X_CONFIG_READER_PIN_UNEXPLAINED',
  cause: `${gap.leaf} is pinned in ${gap.reason ?? CONFIG_PINS_FILE} with a blank reason, so nothing records who reads it — and the pin holds nothing, which is what a row with no sentence has always been worth`,
  fix: `write who reads ${gap.leaf} — a file under packages/, or a surface outside this repo — in ${CONFIG_PINS_FILE}; or delete ${gap.leaf} from ${CONFIG_FILE} and from defaults()`,
  at: CONFIG_PINS_FILE,
});

const appUnreadFinding = (gap: ConfigReaderGap): Finding => ({
  code: 'X_CONFIG_READER_APP_UNREAD',
  cause: `${CONFIG_PINS_FILE} pins ${gap.leaf} as read by app code ("${gap.reason ?? ''}") and no file of either tracked app (${GATED_APPS.map((app) => app.dir).join(', ')}) reads it outside app.config.ts — the reader the pin names does not exist. Delete it from ${CONFIG_FILE} and defaults(), read it from an app module, or rewrite its row so it names no app reader`,
  fix: 'bun run scripts/config-readers.ts --json',
  at: CONFIG_PINS_FILE,
});

const unscannedFinding = (gap: ConfigReaderGap): Finding => ({
  code: 'X_CONFIG_READERS_UNSCANNED',
  cause: `nothing was read for ${gap.leaf}, so every key reports a reader and the ratchet enforces nothing — a glob or an interface name that matches nothing reads exactly like a wired config`,
  fix: `check that ${CONFIG_FILE} still declares ${ROOT_INTERFACE}, then bun run scripts/config-readers.ts --json`,
  at: CONFIG_FILE,
});

const FINDINGS: Readonly<Record<ConfigReaderGapKind, (gap: ConfigReaderGap) => Finding>> = {
  unread: unreadFinding,
  ambiguous: ambiguousFinding,
  stale: staleFinding,
  unscanned: unscannedFinding,
  unexplained: unexplainedFinding,
  'app-unread': appUnreadFinding,
};

export const configReaderFindingFor = (gap: ConfigReaderGap): Finding => FINDINGS[gap.kind](gap);

/** The tree's own answer: the declaration parsed, every shipped file but the declaration read. */
export async function configReaderInput(root: string): Promise<ConfigReaderInput> {
  // `shipped` FIRST, so a tree it cannot read is `X_CORPUS_UNSCANNED` and not the first file's
  // `EACCES`. A test reading a key is not the key being wired — `config.test.ts` reads all thirty.
  const shipped = await corpus(root, 'shipped');
  const declaration = await configDeclaration(root);
  const files: ConfigSource[] = shipped
    .filter((file) => !CONFIG_FILES.some((one) => one === file.path))
    .map((file) => ({ path: file.path, text: file.source }));
  return {
    leaves: configLeaves(declaration),
    files,
    pins: CONFIG_READER_PINS,
    ambiguousPins: CONFIG_AMBIGUOUS_PINS,
    appFiles: await configAppSources(root),
  };
}

export const configReaderGaps = async (root: string): Promise<readonly ConfigReaderGap[]> =>
  checkConfigReaders(await configReaderInput(root));

/** What this rule contributes to `x verify`'s `unit` step, through `config-readers.test.ts`. */
export const configReaderFindings = async (root: string): Promise<readonly Finding[]> =>
  (await configReaderGaps(root)).map(configReaderFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const unpin = flagList(args, 'unpin');
  const input = await configReaderInput(root);
  if (unpin.length > 0) {
    const lowered = await applyConfigReaderUnpin(root, unpin, checkConfigReaders(input));
    report(
      {
        ok: true,
        script: SCRIPT,
        summary:
          lowered.length === 0
            ? 'nothing to drop — every named key is still read by nobody, so its pin still holds'
            : `dropped ${String(lowered.length)} pin(s): ${lowered.join(', ')}`,
        findings: [],
      },
      args.json,
    );
  } else {
    const gaps = checkConfigReaders(input);
    report(
      {
        ok: gaps.length === 0,
        script: SCRIPT,
        summary:
          gaps.length === 0
            ? `${String(input.leaves.length)} AppConfig leaf keys, every one read by shipped code or pinned with a reason`
            : `${String(gaps.length)} of ${String(input.leaves.length)} AppConfig leaf keys are off the ratchet`,
        findings: gaps.map(configReaderFindingFor),
        data: { leaves: input.leaves, files: input.files.length },
      },
      args.json,
    );
  }
}
