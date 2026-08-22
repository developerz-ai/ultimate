#!/usr/bin/env bun
// Enforce, as a gate step, the two version facts this repo states in prose and checked nowhere.
//
// ONE STAMP. `wiki/_Footer.md` renders under every wiki page and is the only page that names a
// version; 23 other pages carried `v1.1.0` hand-copied while the repo was at 1.2.0, because a fact
// written 24 times goes stale 23 times per release. The footer says this rule out loud — "This
// footer is the **only** page that stamps a version" — and saying it is not enforcing it.
//
// LOCKSTEP. Root `CLAUDE.md` and `CHANGELOG.md` both state that a release bumps every package to
// the same version in one commit under one tag, and nothing compared the manifests. Versioning is
// in lockstep; PUBLICATION is not (`@ultimat3/flags` has never reached npm) — this rule asserts the
// version invariant only, because the other one needs a network the gate does not have.
//
// Runs on `x verify`'s `manifest` step: does a committed file still describe this tree?
//
//   bun run scripts/version-stamps.ts [--json]

import { dirname, relative } from 'node:path';
import { parseScriptArgs } from './lib/args';
import type { MarkdownFile } from './lib/doc-citations';
import { readMarkdown } from './lib/doc-citations';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { listWorkspaces, rootWorkspacePatterns, workspaceManifests } from './lib/workspaces';

/** The one page allowed to name a version, and the one page required to. */
export const STAMP_PAGE = 'wiki/_Footer.md';

/**
 * One workspace block in `bun.lock`, declared here and imported by `scripts/lockfile-pins.ts` so
 * the rule that REPORTS the drift and the pass that REPAIRS it can never read different blocks.
 *
 * Anchored on four spaces at a line start, not on the literal `"packages/`: every workspace key in
 * the file sits at that indentation and only `workspaces` holds objects — the sibling `packages`
 * section maps each name to an ARRAY, so `:\s*\{` never reaches it. The old anchor read
 * `packages/*` alone and so judged 8 of the 48 blocks; the app workspaces, which resolve their
 * `@ultimat3/*` pins out of this same file, were invisible.
 */
export const LOCK_BLOCK = /^ {4}"([^"]*)":\s*\{(.*?)\n {4}\},/gms;

/**
 * `[a-z0-9-]+`, never `[a-z-]+`: the digit is what `@ultimat3/i18n` needs, and without it eight
 * stale `i18n` ranges read as no range at all. `scripts/release.ts` has carried the digit — and a
 * comment naming this exact bug — the whole time.
 */
export const LOCK_DEP = /"(@ultimat3\/[a-z0-9-]+)":\s*"([^"]+)"/g;

export const STAMP_GLOBS: readonly string[] = [
  '*.md',
  'wiki/**/*.md',
  'docs/**/*.md',
  'packages/*/*.md',
];

/**
 * A STAMP is `v1.2.0` followed by an `As of` date — never a bare `vX.Y.Z`.
 *
 * The anchor is what separates a claim about this build from an example of one, and both live in
 * the tree today: `PUBLISHING.md` writes `git tag v1.1.0` in a shell block and `v1.10.1` in a
 * worked example of the tag-versus-manifest mismatch, and `docs/idea/17-scale-ladder.md` names
 * Yugabyte's `v2025.2.3`. None of the three is a claim about `@ultimat3/*` and a rule that read
 * them as one would be a rule its readers learn to ignore.
 */
const STAMP = /\bv(\d+\.\d+\.\d+)[\s*_.]*`As of\b/g;

/** The file that names every workspace, and the one this rule cannot proceed without. */
export const ROOT_MANIFEST = 'package.json';

const partsOf = (version: string): readonly number[] =>
  version
    .split('-')[0]
    ?.split('.')
    .map((part) => Number.parseInt(part, 10)) ?? [];

/**
 * SEMVER order, never string order. `'10.0.0' < '9.0.0'` lexicographically, so `.sort()[0]` — how
 * this file picks the shipped version — answers 10.0.0 as the LOWEST the day this project cuts a
 * two-digit major, and every workspace still on 9.x then reads as the one out of lockstep. Silent
 * until it is not, which is the only kind of ordering bug there is.
 *
 * A prerelease suffix is dropped rather than ranked: `7.0.0-rc.1` and `7.0.0` compare equal here,
 * which is honest for a rule whose whole question is whether the numbers AGREE.
 */
export function compareVersions(a: string, b: string): number {
  const left = partsOf(a);
  const right = partsOf(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const one = left[index] ?? 0;
    const other = right[index] ?? 0;
    // A version this cannot parse falls back to string order rather than to a silent 0.
    if (Number.isNaN(one) || Number.isNaN(other)) return a < b ? -1 : a > b ? 1 : 0;
    if (one !== other) return one - other;
  }
  return 0;
}

/** `docs/plans/` is a dated record; `CHANGELOG.md` names every past version by design. */
export const skipStampPath = (path: string): boolean =>
  path.startsWith('docs/plans/') || path === 'CHANGELOG.md';

export interface VersionStamp {
  readonly path: string;
  readonly line: number;
  readonly version: string;
}

/** Every stamp on one page. Pure over the text. */
export function readStamps(file: MarkdownFile): readonly VersionStamp[] {
  const found: VersionStamp[] = [];
  const lines = file.text.split('\n');
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const match of line.matchAll(STAMP)) {
      found.push({ path: file.path, line: index + 1, version: match[1] as string });
    }
  }
  return found;
}

/**
 * `stale` and `lockstep` are the hazards. `duplicate` is the rule the footer states about itself.
 * `vacuous` is the false green: no footer, or a footer that stamps nothing, means this rule
 * compared the shipped version against no sentence at all.
 */
export type VersionGapKind =
  | 'stale'
  | 'duplicate'
  | 'lockstep'
  | 'dependency'
  | 'lockfile'
  | 'vacuous';

export interface VersionGap {
  readonly kind: VersionGapKind;
  readonly at: string;
  readonly detail: string;
}

export interface VersionInput {
  readonly files: readonly MarkdownFile[];
  /** Every workspace's declared version, keyed by package name — `listWorkspaces`' own answer. */
  readonly versions: Readonly<Record<string, string>>;
  /**
   * Each workspace's `@ultimat3/*` dependency ranges, keyed by the workspace DIRECTORY relative to
   * the repo root (`packages/i18n`, `examples/dummy/apps/web`) — the key `bun.lock` itself uses, so
   * the two maps join without either side reconstructing a path. Lockstep is a claim about what a
   * package DEPENDS on as much as what it declares itself: `@ultimat3/admin@3.0.0` depending on
   * `@ultimat3/core@1.2.0` is a mixed-version install, which `CHANGELOG.md` calls a combination
   * nobody tested.
   */
  readonly internalDeps?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * What `bun.lock` records for those same edges. A third committed file that has to agree, and
   * the one nothing checked: `bun install` only refreshes a workspace block whose `package.json`
   * changed, so 90 entries sat at 1.2.0 and 2.0.0 against manifests that all said 3.0.0, and
   * `--frozen-lockfile` accepted every one of them.
   *
   * It then RECURRED at 72 under a green check, because the reader below matched the workspace key
   * with `[a-z-]+` anchored on `packages/` — so `i18n` and every app workspace fell outside it.
   */
  readonly lockedDeps?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * Whether the root `package.json` — the file naming every workspace — could be read at all.
   * `false` is NOT the same fact as "no internal dependencies", and reading the two as one answer
   * is how a directory that is not a repo passes as a clean one.
   */
  readonly rootManifestRead?: boolean;
}

/** Pure, so the negative case is a fixture rather than a hand-edit to a published page. */
export function checkVersionStamps(input: VersionInput): readonly VersionGap[] {
  const gaps: VersionGap[] = [];
  // Before the early return below, not after it: a root this rule could not read is the CAUSE of
  // the empty corpus, and a finding that reports only the symptom sends the reader to the wrong
  // file.
  if (input.rootManifestRead === false) {
    gaps.push({
      kind: 'vacuous',
      at: ROOT_MANIFEST,
      detail: 'declares no workspaces this rule could read, so no dependency range was compared',
    });
  }
  const declared = [...new Set(Object.values(input.versions))].sort(compareVersions);
  const shipped = declared[0];
  if (shipped === undefined) {
    gaps.push({
      kind: 'vacuous',
      at: 'packages/*/package.json',
      detail: 'no workspace declares a version',
    });
    return gaps;
  }
  if (declared.length > 1) {
    const named = Object.entries(input.versions)
      .filter(([, version]) => version !== shipped)
      .map(([name, version]) => `${name}@${version}`)
      .sort();
    gaps.push({
      kind: 'lockstep',
      at: 'packages/*/package.json',
      detail: `${shipped} everywhere except ${named.join(', ')}`,
    });
  }
  for (const [dir, deps] of Object.entries(input.internalDeps ?? {})) {
    for (const [dep, range] of Object.entries(deps)) {
      if (range !== shipped) {
        gaps.push({
          kind: 'dependency',
          at: `${dir}/package.json`,
          detail: `it depends on ${dep}@${range} while the workspaces ship ${shipped}`,
        });
      }
    }
  }
  for (const [dir, deps] of Object.entries(input.lockedDeps ?? {})) {
    const declared = input.internalDeps?.[dir] ?? {};
    for (const [dep, locked] of Object.entries(deps)) {
      const want = declared[dep];
      if (want !== undefined && want !== locked) {
        gaps.push({
          kind: 'lockfile',
          at: 'bun.lock',
          detail: `it records ${dir} depending on ${dep}@${locked}, and that package.json says ${want}`,
        });
      }
    }
  }

  const stamps = input.files.flatMap((file) => [...readStamps(file)]);
  const onPage = stamps.filter((stamp) => stamp.path === STAMP_PAGE);
  if (onPage.length === 0) {
    gaps.push({ kind: 'vacuous', at: STAMP_PAGE, detail: 'stamps no version' });
  }
  for (const stamp of stamps) {
    if (stamp.path !== STAMP_PAGE) {
      gaps.push({
        kind: 'duplicate',
        at: `${stamp.path}:${stamp.line}`,
        detail: `v${stamp.version}`,
      });
      continue;
    }
    if (stamp.version === shipped) continue;
    gaps.push({
      kind: 'stale',
      at: `${stamp.path}:${stamp.line}`,
      detail: `v${stamp.version}`,
    });
  }
  return gaps;
}

const staleFinding = (gap: VersionGap, shipped: string): Finding => ({
  code: 'X_VERSION_STAMP_STALE',
  cause: `${gap.at} stamps ${gap.detail} and every package in this tree declares ${shipped}`,
  fix: `write v${shipped} where ${gap.at} says ${gap.detail}, then bun run scripts/version-stamps.ts --json`,
  at: gap.at,
});

const duplicateFinding = (gap: VersionGap): Finding => ({
  code: 'X_VERSION_STAMP_DUPLICATE',
  cause: `${gap.at} stamps ${gap.detail}, and ${STAMP_PAGE} is the only page that may — it renders under every wiki page, so a second stamp is one fact hand-copied and one more line to bump per release`,
  fix: `delete the ${gap.detail} stamp from ${gap.at}; the version reaches that page through ${STAMP_PAGE}`,
  at: gap.at,
});

const dependencyFinding = (gap: VersionGap, shipped: string): Finding => ({
  code: 'X_VERSION_LOCKSTEP_BROKEN',
  cause: `${gap.at} breaks lockstep — ${gap.detail}`,
  fix: `set that "@ultimat3/*" range to ${shipped} in ${gap.at}, then bun install`,
  at: gap.at,
});

/**
 * A third committed file in the agreement, and the one that had drifted. `bun install` refreshes
 * only a workspace block whose `package.json` changed, so a version bump leaves every untouched
 * block recording the old number — and `--frozen-lockfile` accepts it, because a workspace edge
 * resolves by name and never reads the range back.
 */
const lockfileFinding = (gap: VersionGap): Finding => ({
  code: 'X_LOCKFILE_STALE',
  cause: `bun.lock disagrees with a package.json it was generated from — ${gap.detail}`,
  fix: 'bun run scripts/lockfile-pins.ts --write, then bun install --frozen-lockfile to confirm',
  at: gap.at,
});

const lockstepFinding = (gap: VersionGap): Finding => ({
  code: 'X_VERSION_LOCKSTEP_BROKEN',
  cause: `the workspaces declare more than one version — ${gap.detail} — and a release is one version, one commit, one tag`,
  fix: `set every packages/*/package.json "version" to the same value, then bun run scripts/version-stamps.ts --json`,
  at: gap.at,
});

const vacuousFinding = (gap: VersionGap): Finding =>
  gap.at === ROOT_MANIFEST
    ? {
        code: 'X_VERSION_STAMP_UNSCANNED',
        cause: `${ROOT_MANIFEST} ${gap.detail}`,
        // A literal command, not an interpolation: the fix-line rule reads these statically.
        fix: 'run this from the repository root — the directory whose package.json declares "workspaces" — then bun run scripts/version-stamps.ts --json',
        at: gap.at,
      }
    : {
        code: 'X_VERSION_STAMP_UNSCANNED',
        cause: `${gap.at} ${gap.detail}, so this rule compared the shipped version against nothing`,
        fix: `restore the version stamp on ${STAMP_PAGE} in the form v<version> \`As of <YYYY-MM>\`, or point STAMP_PAGE in scripts/version-stamps.ts at the page that carries it`,
        at: gap.at,
      };

export function versionGapFindingFor(gap: VersionGap, shipped: string): Finding {
  if (gap.kind === 'stale') return staleFinding(gap, shipped);
  if (gap.kind === 'duplicate') return duplicateFinding(gap);
  if (gap.kind === 'lockstep') return lockstepFinding(gap);
  if (gap.kind === 'dependency') return dependencyFinding(gap, shipped);
  if (gap.kind === 'lockfile') return lockfileFinding(gap);
  return vacuousFinding(gap);
}

const readVersions = async (root: string): Promise<Readonly<Record<string, string>>> =>
  Object.fromEntries((await listWorkspaces(root)).map((one) => [one.name, one.version]));

/**
 * Every workspace's own `@ultimat3/*` ranges, keyed by DIRECTORY — the key `bun.lock` uses.
 *
 * Read from `workspaceManifests`, which expands the root `package.json`'s own `workspaces` list,
 * rather than from a `packages/*` glob: the two tracked apps and their nested workspaces resolve
 * their `@ultimat3/*` pins out of the SAME lockfile, and a glob that could not see them left 53 of
 * the 72 stale ranges this rule exists to report outside its reach.
 */
export async function readInternalDeps(
  root: string,
): Promise<Readonly<Record<string, Readonly<Record<string, string>>>>> {
  const out: Record<string, Record<string, string>> = {};
  for (const path of await workspaceManifests(root)) {
    const dir = relative(root, dirname(path));
    const json = (await Bun.file(path).json()) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const merged = { ...json.dependencies, ...json.devDependencies };
    const internal = Object.fromEntries(
      Object.entries(merged).filter(([name]) => name.startsWith('@ultimat3/')),
    );
    if (Object.keys(internal).length > 0) out[dir] = internal;
  }
  return out;
}

/**
 * What `bun.lock` records for the same edges. Read with a regex rather than parsed: the file is
 * JSONC with trailing commas, and this rule needs one field out of it — a parser dependency for
 * that is the trade `docs/idea/18-build-vs-wrap.md` refuses.
 */
export async function readLockedDeps(
  root: string,
): Promise<Readonly<Record<string, Readonly<Record<string, string>>>>> {
  const file = Bun.file(`${root}/bun.lock`);
  if (!(await file.exists())) return {};
  const text = await file.text();
  const out: Record<string, Record<string, string>> = {};
  for (const block of text.matchAll(LOCK_BLOCK)) {
    const dir = block[1] as string;
    const deps: Record<string, string> = {};
    for (const dep of (block[2] as string).matchAll(LOCK_DEP)) {
      deps[dep[1] as string] = dep[2] as string;
    }
    if (Object.keys(deps).length > 0) out[dir] = deps;
  }
  return out;
}

export const readStampPages = async (root: string): Promise<readonly MarkdownFile[]> => {
  const seen = new Map<string, MarkdownFile>();
  for (const glob of STAMP_GLOBS) {
    for (const file of await readMarkdown(root, glob, skipStampPath)) seen.set(file.path, file);
  }
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
};

/** What this repo contributes to `x verify`'s `manifest` step. */
export async function versionStampFindings(root: string): Promise<readonly Finding[]> {
  const versions = await readVersions(root);
  const shipped = [...new Set(Object.values(versions))].sort(compareVersions)[0] ?? '0.0.0';
  return checkVersionStamps({
    files: await readStampPages(root),
    versions,
    internalDeps: await readInternalDeps(root),
    lockedDeps: await readLockedDeps(root),
    rootManifestRead: (await rootWorkspacePatterns(root)) !== undefined,
  }).map((gap) => versionGapFindingFor(gap, shipped));
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const versions = await readVersions(root);
  const shipped = [...new Set(Object.values(versions))].sort(compareVersions)[0] ?? '0.0.0';
  const gaps = checkVersionStamps({
    files: await readStampPages(root),
    versions,
    internalDeps: await readInternalDeps(root),
    lockedDeps: await readLockedDeps(root),
    rootManifestRead: (await rootWorkspacePatterns(root)) !== undefined,
  });
  report(
    {
      ok: gaps.length === 0,
      script: 'version-stamps',
      summary:
        gaps.length === 0
          ? `${Object.keys(versions).length} workspaces at ${shipped}, and ${STAMP_PAGE} is the one page that says so`
          : `${gaps.length} version claim(s) this tree does not support`,
      findings: gaps.map((gap) => versionGapFindingFor(gap, shipped)),
    },
    args.json,
  );
}
