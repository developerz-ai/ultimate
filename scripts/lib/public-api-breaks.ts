// The pure half of `scripts/public-api.ts`: the diff between the lock and the tree — each change
// classified compatible or breaking — which breaks a `BREAKING —` changelog entry declares, and the
// lock `--write` produces: everything but an undeclared break, which keeps reporting until declared.

import { BREAKING_ENTRY } from './changelog-format';
import type { Changelog } from './changelog-sections';
import { UNRELEASED } from './changelog-sections';
import type { ApiSymbol } from './public-api-compat';
import { classify, own } from './public-api-compat';
import type { ApiLock, ApiSnapshot } from './public-api-lock';
import { LOCK_FORMAT } from './public-api-lock';

export interface ApiBreak {
  readonly kind: 'changed' | 'removed';
  readonly specifier: string;
  readonly name: string;
  /** What about it breaks a caller: `member \`x\` was removed`. */
  readonly why: string;
}

export interface ApiCompatible {
  readonly specifier: string;
  readonly name: string;
  /** What changed, and why no caller notices: `optional \`x\` added`. */
  readonly why: string;
}

export interface ApiDiff {
  readonly breaks: readonly ApiBreak[];
  /** Changed, and every caller of the recorded declaration still compiles. */
  readonly compatible: readonly ApiCompatible[];
  readonly added: readonly { readonly specifier: string; readonly name: string }[];
}

const sorted = <T>(record: Readonly<Record<string, T>>): [string, T][] =>
  Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

export function diffApi(lock: ApiSnapshot, tree: ApiSnapshot): ApiDiff {
  const breaks: ApiBreak[] = [];
  const compatible: ApiCompatible[] = [];
  const added: { specifier: string; name: string }[] = [];
  for (const [specifier, names] of sorted(lock)) {
    const now = own(tree, specifier) ?? {};
    for (const [name, recorded] of sorted(names)) {
      const current = own(now, name);
      if (current === undefined) {
        breaks.push({ kind: 'removed', specifier, name, why: 'it is no longer exported' });
        continue;
      }
      const change = classify(recorded, current);
      if (change.kind === 'break')
        breaks.push({ kind: 'changed', specifier, name, why: change.why });
      else if (change.kind === 'compatible') compatible.push({ specifier, name, why: change.why });
    }
  }
  for (const [specifier, names] of sorted(tree)) {
    for (const [name] of sorted(names)) {
      if (own(own(lock, specifier), name) === undefined) added.push({ specifier, name });
    }
  }
  return { breaks, compatible, added };
}

/**
 * Each `BREAKING —` entry's text: a `- **BREAKING —**` line and the lines under it up to the next
 * item or heading; a `### BREAKING —` heading and everything up to the next heading.
 */
function breakingEntries(lines: readonly string[]): readonly string[] {
  const entries: string[][] = [];
  let open: 'item' | 'heading' | undefined;
  let current: string[] = [];
  for (const line of lines) {
    if (BREAKING_ENTRY.test(line)) {
      current = [line];
      entries.push(current);
      open = line.startsWith('#') ? 'heading' : 'item';
    } else if (line.startsWith('#') || (open === 'item' && line.startsWith('- '))) {
      open = undefined;
    } else if (open !== undefined) current.push(line);
  }
  return entries.map((entry) => entry.join('\n'));
}

/** `name` as a pattern matching only itself: every RegExp metacharacter escaped, `\` included. */
const escapeName = (name: string): string => name.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

/**
 * Whether a `BREAKING —` entry names `name` (as a whole word), under [Unreleased] or in the
 * current version's own section — the two places a break on its way to a release is declared.
 */
export function declaredBreak(changelog: Changelog, version: string, name: string): boolean {
  const word = new RegExp(`(?:^|[^\\w$])${escapeName(name)}(?:[^\\w$]|$)`);
  return changelog
    .filter((section) => section.version === UNRELEASED || section.version === version)
    .some((section) => breakingEntries(section.lines).some((entry) => word.test(entry)));
}

/**
 * The lock `--write` writes: the tree — compatible changes and declared breaks recorded — except an
 * undeclared break, which keeps what the baseline held so it goes on reporting.
 */
export function nextLock(
  baseline: ApiSnapshot | undefined,
  tree: ApiSnapshot,
  version: string,
  undeclared: readonly ApiBreak[],
): ApiLock {
  const entries = new Map<string, Record<string, ApiSymbol>>();
  for (const [specifier, names] of Object.entries(tree)) entries.set(specifier, { ...names });
  for (const one of undeclared) {
    const held = own(own(baseline, one.specifier), one.name);
    if (held === undefined) continue;
    entries.set(one.specifier, { ...(entries.get(one.specifier) ?? {}), [one.name]: held });
  }
  return { format: LOCK_FORMAT, version, entries: Object.fromEntries(entries) };
}
