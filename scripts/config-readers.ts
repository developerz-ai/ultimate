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
// WHAT IT CANNOT SEE: a key whose only legitimate reader is APP code (`config.defaultCurrency` in a
// price view). Those are pinned with the sentence saying so, which is the difference between a
// waiver and a decision.
//
//   bun run scripts/config-readers.ts [--json]
//   bun run scripts/config-readers.ts --unpin <leaf>[,<leaf>]   # shrink either ratchet

import { flagList, parseScriptArgs } from './lib/args';
import {
  applyConfigReaderUnpin,
  CONFIG_AMBIGUOUS_PINS,
  CONFIG_PINS_FILE,
  CONFIG_READER_PINS,
} from './lib/config-reader-pins';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'config-readers';

/**
 * The declaration, and the interface the walk starts from.
 *
 * A LIST, not one file, `As of 2026-08-27`. It was one path, and `config.ts` then reached its
 * 500-line ceiling and the `pwa` block moved to `config-pwa.ts` — at which point the walk stopped
 * finding `PwaConfig`, the derived leaf set silently LOST five keys, and this rule reported green
 * over every one of them. That is the rule's own defect class, wearing the shape of a file split:
 * a derivation whose source is a single hardcoded path is a hand list with extra steps. Text is
 * concatenated before the walk, so a section declared anywhere in the list resolves.
 *
 * The FIRST entry is what a finding cites — the file that declares `AppConfig` itself, and the one
 * an author edits to delete a section.
 */
export const CONFIG_FILES = [
  'packages/core/src/config.ts',
  'packages/core/src/config-pwa.ts',
] as const;
export const CONFIG_FILE = CONFIG_FILES[0];
export const ROOT_INTERFACE = 'AppConfig';

/** Every declaring file's text, joined — what `configLeaves` walks. */
export const configDeclaration = async (root: string): Promise<string> =>
  (await Promise.all(CONFIG_FILES.map((path) => Bun.file(`${root}/${path}`).text()))).join('\n');

/** Shipped source of every package. The declaring file is excluded by the caller, not by a glob. */
const SOURCE_GLOB = 'packages/*/src/**/*.{ts,tsx}';

const INTERFACE = /export interface (\w+)\s*\{([\s\S]*?)\n\}/g;
/** A member at one indent level: `readonly queues: readonly string[];`. */
const MEMBER = /^ {2}readonly\s+([A-Za-z_$][\w$]*)\??\s*:\s*([^;]+);/gm;
/** A member whose type is a single named interface — the one shape the walk descends into. */
const NAMED_TYPE = /^([A-Z]\w*)$/;

/**
 * Every leaf key of `AppConfig`, dotted. Derived from the declaration's own text rather than typed
 * out here: a hand list is the defect this check exists to catch, one level up.
 */
export function configLeaves(source: string, root = ROOT_INTERFACE): readonly string[] {
  const bodies = new Map<string, string>();
  for (const match of source.matchAll(INTERFACE))
    bodies.set(match[1] as string, match[2] as string);
  const leaves: string[] = [];
  const walk = (name: string, prefix: string, seen: readonly string[]): void => {
    const body = bodies.get(name);
    // A cycle would recurse forever, and a self-referential config is not a thing this repo has —
    // but a check that hangs is worse than one that reports nothing, so the guard is cheap.
    if (body === undefined || seen.includes(name)) return;
    for (const member of body.matchAll(MEMBER)) {
      const key = member[1] as string;
      const type = (member[2] as string).trim();
      const target = NAMED_TYPE.test(type) ? type : undefined;
      if (target !== undefined && bodies.has(target))
        walk(target, `${prefix}${key}.`, [...seen, name]);
      else leaves.push(`${prefix}${key}`);
    }
  };
  walk(root, '', []);
  return leaves;
}

/**
 * `.key` or `{ …, key }` / `{ key, … }`. A declaration (`readonly key: T;`) and a literal
 * (`key: 'UTC',`) both fail it, which is what keeps a scaffold template that WRITES the key out of
 * the reader set — `packages/cli/src/templates/` emits `defaultTimeZone: 'UTC'` and reads nothing.
 */
export const readPattern = (leaf: string): RegExp => {
  const key = leaf.split('.').at(-1) as string;
  return new RegExp(`\\.${key}\\b|(?<![\\w$.])${key}\\s*[,}]`);
};

/**
 * The QUALIFIED form — `realtime.tier`, `config.realtime.tier`, `cfg . realtime . tier` — which is
 * the only conclusive evidence text can offer. Undefined for a top-level leaf, which has no section
 * to qualify it with.
 *
 * Measured 2026-08-23 across all 28 leaves: this pattern matches in ZERO files for 19 of them,
 * `database.driver` and `jobs.concurrency` included — a package takes `CacheConfig` as a parameter
 * and reads `cfg.driver`, so demanding this form would report nineteen live keys as dead. It is
 * therefore a POSITIVE signal only: a match silences the ambiguity rule below, and a miss says
 * nothing on its own.
 */
export const qualifiedPattern = (leaf: string): RegExp | undefined => {
  const parts = leaf.split('.');
  if (parts.length < 2) return undefined;
  const [section, key] = parts.slice(-2) as [string, string];
  return new RegExp(`(?<![\\w$])${section}\\s*\\.\\s*${key}(?![\\w$])`);
};

/**
 * The package a section's keys belong to, where the two names differ. Two rows, and both are
 * asserted against the real package list by this rule's own test — a rename that made a row resolve
 * to nothing would silently switch the ambiguity check off for every key in that section, which is
 * the failure mode this whole rule exists to remove one level up.
 */
export const SECTION_PACKAGE: Readonly<Record<string, string>> = { database: 'db', theme: 'ui' };

/** `realtime.tier` -> `realtime`; `ai.mcp.path` -> `mcp`; a top-level leaf -> undefined. */
export const owningPackage = (leaf: string): string | undefined => {
  const parts = leaf.split('.');
  if (parts.length < 2) return undefined;
  const section = parts.at(-2) as string;
  return Object.hasOwn(SECTION_PACKAGE, section) ? SECTION_PACKAGE[section] : section;
};

/**
 * How many unrelated files may match a bare leaf name before the match stops being evidence.
 *
 * Eight, measured. `realtime.tier` had NINETEEN matching files and not one of them in
 * `packages/realtime/` — `@ultimat3/cache`'s `CacheTier` and `@ultimat3/query`'s read-tier
 * vocabulary account for most, and `packages/policy/src/surfaces.ts` matched on the words `tier,`
 * in its FILE-HEADER PROSE while importing only `./errors`, `./evaluate` and `./policy`. The key
 * was read by nothing and this rule printed `✓`. The header above called the looseness safe because
 * it "only ever HIDES a dead key whose name collides with an unrelated property"; hiding a dead key
 * is the entire defect this rule exists for, so the sentence conceded the check away.
 *
 * Eight is where the four suspects separate from the twenty-four keys that have a hit inside their
 * own package: every leaf with a real reader has at least one, and the four that do not
 * (`realtime.tier` 19, `theme.tokens` 24, `pwa.enabled` 10, `realtime.enabled` 10) are the ones a
 * human should look at. Lowering it is a pin table with more rows, never a weaker rule.
 */
export const AMBIGUOUS_LIMIT = 8;

export interface ConfigSource {
  readonly path: string;
  readonly text: string;
}

export type ConfigReaderGapKind = 'unread' | 'ambiguous' | 'stale' | 'unscanned';

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
}

/**
 * Whether a leaf's "reader" set is evidence at all. Three conditions, all of them necessary:
 * no qualified `<section>.<key>` anywhere, no bare match inside the section's OWN package, and
 * more than `AMBIGUOUS_LIMIT` bare matches outside it. A top-level leaf has no owning package and
 * is never asked — stated rather than silently skipped, and the honest limit of this rule.
 */
export function ambiguityOf(
  leaf: string,
  files: readonly ConfigSource[],
): { readonly readers: number; readonly colliding: readonly string[] } | undefined {
  const owner = owningPackage(leaf);
  if (owner === undefined) return undefined;
  const qualified = qualifiedPattern(leaf);
  if (qualified !== undefined && files.some((file) => qualified.test(file.text))) return undefined;
  const bare = readPattern(leaf);
  const hits = files.filter((file) => bare.test(file.text));
  if (hits.some((file) => file.path.startsWith(`packages/${owner}/`))) return undefined;
  if (hits.length <= AMBIGUOUS_LIMIT) return undefined;
  return { readers: hits.length, colliding: hits.slice(0, 2).map((file) => file.path) };
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
  for (const leaf of input.leaves) {
    if (read.has(leaf) || Object.hasOwn(input.pins, leaf)) continue;
    gaps.push({ kind: 'unread', leaf });
  }
  for (const [leaf, doubt] of ambiguous) {
    if (Object.hasOwn(ambiguousPins, leaf) || Object.hasOwn(input.pins, leaf)) continue;
    gaps.push({ kind: 'ambiguous', leaf, readers: doubt.readers, colliding: doubt.colliding });
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
};

export const configReaderFindingFor = (gap: ConfigReaderGap): Finding => FINDINGS[gap.kind](gap);

/** The tree's own answer: the declaration parsed, every shipped file but the declaration read. */
export async function configReaderInput(root: string): Promise<ConfigReaderInput> {
  const declaration = await configDeclaration(root);
  const files: ConfigSource[] = [];
  for (const found of new Bun.Glob(SOURCE_GLOB).scanSync({ cwd: root })) {
    const path = found.split('\\').join('/');
    // A test reading a key is not the key being wired — `config.test.ts` reads all thirty.
    if (path.includes('.test.') || CONFIG_FILES.some((one) => one === path)) continue;
    files.push({ path, text: await Bun.file(`${root}/${path}`).text() });
  }
  return {
    leaves: configLeaves(declaration),
    files,
    pins: CONFIG_READER_PINS,
    ambiguousPins: CONFIG_AMBIGUOUS_PINS,
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
