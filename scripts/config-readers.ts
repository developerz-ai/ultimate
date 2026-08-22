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
// as a parameter and reads `cfg.driver`, so demanding the fully qualified path would report every
// key in the file. The looseness only ever HIDES a dead key whose name collides with an unrelated
// property; it never invents one, which is the direction a check may be wrong in.
//
// WHAT IT CANNOT SEE: a key whose only legitimate reader is APP code (`config.defaultCurrency` in a
// price view). Those are pinned with the sentence saying so, which is the difference between a
// waiver and a decision.
//
//   bun run scripts/config-readers.ts [--json]
//   bun run scripts/config-readers.ts --unpin <leaf>[,<leaf>]   # shrink the ratchet

import { flagList, parseScriptArgs } from './lib/args';
import {
  applyConfigReaderUnpin,
  CONFIG_PINS_FILE,
  CONFIG_READER_PINS,
} from './lib/config-reader-pins';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'config-readers';

/** The declaration, and the interface the walk starts from. One file, by design — see `AppConfig`. */
export const CONFIG_FILE = 'packages/core/src/config.ts';
export const ROOT_INTERFACE = 'AppConfig';

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

export interface ConfigSource {
  readonly path: string;
  readonly text: string;
}

export type ConfigReaderGapKind = 'unread' | 'stale' | 'unscanned';

export interface ConfigReaderGap {
  readonly kind: ConfigReaderGapKind;
  readonly leaf: string;
  readonly reason?: string;
}

export interface ConfigReaderInput {
  readonly leaves: readonly string[];
  readonly files: readonly ConfigSource[];
  readonly pins: Readonly<Record<string, string>>;
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
  const read = new Set<string>();
  for (const leaf of input.leaves) {
    const pattern = readPattern(leaf);
    if (input.files.some((file) => pattern.test(file.text))) read.add(leaf);
  }
  for (const leaf of input.leaves) {
    if (read.has(leaf) || leaf in input.pins) continue;
    gaps.push({ kind: 'unread', leaf });
  }
  for (const [leaf, reason] of Object.entries(input.pins)) {
    if (read.has(leaf)) gaps.push({ kind: 'stale', leaf, reason });
  }
  return gaps;
}

const unreadFinding = (gap: ConfigReaderGap): Finding => ({
  code: 'X_CONFIG_KEY_UNREAD',
  cause: `${CONFIG_FILE} declares ${gap.leaf} and no file in packages/*/src reads it — an app that sets it is setting a switch with no wire, exactly as jobs.driver, realtime.heartbeatMs and database.urlEnv were`,
  fix: `delete ${gap.leaf} from ${CONFIG_FILE} and from defaults(), or wire it and prove the read; to keep it deliberately, add it to CONFIG_READER_PINS in ${CONFIG_PINS_FILE} with the sentence saying who reads it`,
  at: CONFIG_FILE,
});

const staleFinding = (gap: ConfigReaderGap): Finding => ({
  code: 'X_CONFIG_READER_PIN_STALE',
  cause: `${gap.leaf} is pinned as read by nobody in packages/*/src ("${gap.reason ?? ''}") and now has a reader — the pin would let the next dead key in beside it`,
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
  stale: staleFinding,
  unscanned: unscannedFinding,
};

export const configReaderFindingFor = (gap: ConfigReaderGap): Finding => FINDINGS[gap.kind](gap);

/** The tree's own answer: the declaration parsed, every shipped file but the declaration read. */
export async function configReaderInput(root: string): Promise<ConfigReaderInput> {
  const declaration = await Bun.file(`${root}/${CONFIG_FILE}`).text();
  const files: ConfigSource[] = [];
  for (const found of new Bun.Glob(SOURCE_GLOB).scanSync({ cwd: root })) {
    const path = found.split('\\').join('/');
    // A test reading a key is not the key being wired — `config.test.ts` reads all thirty.
    if (path.includes('.test.') || path === CONFIG_FILE) continue;
    files.push({ path, text: await Bun.file(`${root}/${path}`).text() });
  }
  return { leaves: configLeaves(declaration), files, pins: CONFIG_READER_PINS };
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
