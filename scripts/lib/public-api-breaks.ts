// The pure half of `scripts/public-api.ts`: the lock's shape, the diff between the lock and the
// tree, which changes a `BREAKING —` changelog entry declares, and the lock `--write` produces —
// additions and declared breaks only, so an undeclared break keeps reporting until it is declared.

import { BREAKING_ENTRY } from './changelog-format';
import type { Changelog } from './changelog-sections';
import { UNRELEASED } from './changelog-sections';

export const LOCK_PATH = 'scripts/lib/public-api.lock.json';

/** specifier → exported name → hash. */
export type ApiSnapshot = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface ApiLock {
  /** The tree's version when the lock was written. */
  readonly version: string;
  readonly entries: ApiSnapshot;
}

export interface ApiBreak {
  readonly kind: 'changed' | 'removed';
  readonly specifier: string;
  readonly name: string;
}

export interface ApiDiff {
  readonly breaks: readonly ApiBreak[];
  readonly added: readonly { readonly specifier: string; readonly name: string }[];
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The lock parsed from `unknown`, or the reason it is not one. */
export function parseLock(value: unknown): ApiLock | string {
  if (!isRecord(value) || typeof value['version'] !== 'string' || !isRecord(value['entries'])) {
    return 'is not an object with a string `version` and an `entries` object';
  }
  const entries: Record<string, Record<string, string>> = {};
  for (const [specifier, names] of Object.entries(value['entries'])) {
    if (!isRecord(names)) return `holds \`${specifier}\`, which is not an object of hashes`;
    const hashes: Record<string, string> = {};
    for (const [name, hash] of Object.entries(names)) {
      if (typeof hash !== 'string') return `holds \`${specifier}\` \`${name}\` with no string hash`;
      hashes[name] = hash;
    }
    entries[specifier] = hashes;
  }
  return { version: value['version'], entries };
}

const byKey = <T>(record: Readonly<Record<string, T>>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** The lock as committed: keys sorted at both levels, LF, a trailing newline — on every OS. */
export function renderLock(lock: ApiLock): string {
  const entries = Object.fromEntries(
    Object.entries(byKey(lock.entries)).map(([specifier, names]) => [specifier, byKey(names)]),
  );
  return `${JSON.stringify({ version: lock.version, entries }, null, 2)}\n`;
}

export function diffApi(lock: ApiSnapshot, tree: ApiSnapshot): ApiDiff {
  const breaks: ApiBreak[] = [];
  const added: { specifier: string; name: string }[] = [];
  for (const [specifier, names] of Object.entries(byKey(lock))) {
    const now = tree[specifier] ?? {};
    // `recorded` and `current` are digests of a PUBLIC declaration's text, never a credential.
    for (const [name, recorded] of Object.entries(byKey(names))) {
      const current = now[name];
      if (current === undefined) breaks.push({ kind: 'removed', specifier, name });
      else if (current !== recorded) breaks.push({ kind: 'changed', specifier, name });
    }
  }
  for (const [specifier, names] of Object.entries(byKey(tree))) {
    for (const name of Object.keys(byKey(names))) {
      if (lock[specifier]?.[name] === undefined) added.push({ specifier, name });
    }
  }
  return { breaks, added };
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

/** The lock `--write` writes: the tree, except an undeclared break keeps what the lock held. */
export function nextLock(
  lock: ApiLock | undefined,
  tree: ApiSnapshot,
  version: string,
  undeclared: readonly ApiBreak[],
): ApiLock {
  const entries = new Map<string, Record<string, string>>();
  for (const [specifier, names] of Object.entries(tree)) entries.set(specifier, { ...names });
  for (const one of undeclared) {
    const held = lock?.entries[one.specifier]?.[one.name];
    if (held === undefined) continue;
    entries.set(one.specifier, { ...(entries.get(one.specifier) ?? {}), [one.name]: held });
  }
  return { version, entries: Object.fromEntries(entries) };
}
