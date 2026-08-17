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

import { parseScriptArgs } from './lib/args';
import type { MarkdownFile } from './lib/doc-citations';
import { readMarkdown } from './lib/doc-citations';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { listWorkspaces } from './lib/workspaces';

/** The one page allowed to name a version, and the one page required to. */
export const STAMP_PAGE = 'wiki/_Footer.md';

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
export type VersionGapKind = 'stale' | 'duplicate' | 'lockstep' | 'vacuous';

export interface VersionGap {
  readonly kind: VersionGapKind;
  readonly at: string;
  readonly detail: string;
}

export interface VersionInput {
  readonly files: readonly MarkdownFile[];
  /** Every workspace's declared version, keyed by package name — `listWorkspaces`' own answer. */
  readonly versions: Readonly<Record<string, string>>;
}

/** Pure, so the negative case is a fixture rather than a hand-edit to a published page. */
export function checkVersionStamps(input: VersionInput): readonly VersionGap[] {
  const gaps: VersionGap[] = [];
  const declared = [...new Set(Object.values(input.versions))].sort();
  const shipped = declared[0];
  if (shipped === undefined) {
    return [
      { kind: 'vacuous', at: 'packages/*/package.json', detail: 'no workspace declares a version' },
    ];
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

const lockstepFinding = (gap: VersionGap): Finding => ({
  code: 'X_VERSION_LOCKSTEP_BROKEN',
  cause: `the workspaces declare more than one version — ${gap.detail} — and a release is one version, one commit, one tag`,
  fix: `set every packages/*/package.json "version" to the same value, then bun run scripts/version-stamps.ts --json`,
  at: gap.at,
});

const vacuousFinding = (gap: VersionGap): Finding => ({
  code: 'X_VERSION_STAMP_UNSCANNED',
  cause: `${gap.at} ${gap.detail}, so this rule compared the shipped version against nothing`,
  fix: `restore the version stamp on ${STAMP_PAGE} in the form v<version> \`As of <YYYY-MM>\`, or point STAMP_PAGE in scripts/version-stamps.ts at the page that carries it`,
  at: gap.at,
});

export function versionGapFindingFor(gap: VersionGap, shipped: string): Finding {
  if (gap.kind === 'stale') return staleFinding(gap, shipped);
  if (gap.kind === 'duplicate') return duplicateFinding(gap);
  if (gap.kind === 'lockstep') return lockstepFinding(gap);
  return vacuousFinding(gap);
}

const readVersions = async (root: string): Promise<Readonly<Record<string, string>>> =>
  Object.fromEntries((await listWorkspaces(root)).map((one) => [one.name, one.version]));

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
  const shipped = [...new Set(Object.values(versions))].sort()[0] ?? '0.0.0';
  return checkVersionStamps({ files: await readStampPages(root), versions }).map((gap) =>
    versionGapFindingFor(gap, shipped),
  );
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const versions = await readVersions(root);
  const shipped = [...new Set(Object.values(versions))].sort()[0] ?? '0.0.0';
  const gaps = checkVersionStamps({ files: await readStampPages(root), versions });
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
