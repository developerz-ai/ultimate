#!/usr/bin/env bun
// Lockstep versioning: every published package moves to the same version in one commit. Packages
// in this repo import each other by tier, so a mixed-version release means a user can install a
// combination we never tested. One version, one changelog entry, one tag.
//
//   bun run scripts/release.ts --bump minor [--dry-run] [--json]

import { join } from 'node:path';
import { flagBool, flagString, parseScriptArgs } from './lib/args';
import { report } from './lib/log';
import { repoRoot, run } from './lib/run';
import { listWorkspaces, publishOrder, workspaceManifests } from './lib/workspaces';

export type Bump = 'patch' | 'minor' | 'major';

/** The only dependency range a lockstep release rewrites — a caret or a tag is somebody's intent. */
const EXACT_PIN = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)*$/;

export function nextVersion(current: string, bump: Bump): string {
  const [major = 0, minor = 0, patch = 0] =
    current
      .split('-')[0]
      ?.split('.')
      .map((part) => Number.parseInt(part, 10) || 0) ?? [];
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * The manifest's own `"version"`, which is the second key in every package.json here and so the
 * first match. Rewriting text rather than re-serialising JSON keeps key order, comments-by-blank-
 * line and the trailing newline exactly as committed — a release diff should be one line per file.
 */
export const setOwnVersion = (raw: string, version: string): string =>
  raw.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`);

/**
 * Every `@ultimat3/*` dependency pin, exact ones only. Lockstep means a published package names
 * the sibling version it was tested against; leaving these behind is how `@ultimat3/jobs@1.0.0`
 * ships depending on `@ultimat3/core@0.0.1`, which is not on the registry and never will be.
 */
export const repinFrameworkDeps = (raw: string, version: string): string =>
  // `[a-z0-9-]`, not `[a-z-]`: `@ultimat3/i18n` carries digits in its name, and a class that
  // missed it left four manifests pinning i18n at the previous version straight through a release.
  raw.replace(/"(@ultimat3\/[a-z0-9-]+)":\s*"([^"]+)"/g, (match, name: string, range: string) =>
    EXACT_PIN.test(range) ? `"${name}": "${version}"` : match,
  );

/**
 * Keep a Changelog is newest-first. Appending put the second release below the first and every
 * release below that, so the file read oldest-first from its third entry on. The new section goes
 * directly under the `## [Unreleased]` block — above every previous version, below the preamble.
 */
export function insertRelease(changelog: string, entry: string): string {
  const lines = changelog.split('\n');
  const at = lines.findIndex((line) => /^## /.test(line) && !line.includes('[Unreleased]'));
  if (at === -1) return `${changelog.trimEnd()}\n\n${entry}`;
  return [...lines.slice(0, at), ...`${entry}\n`.split('\n'), ...lines.slice(at)].join('\n');
}

/** Conventional-commit subjects since the last tag, grouped. Bodies are left to the git log. */
export function changelogEntry(version: string, subjects: readonly string[]): string {
  const groups: Readonly<Record<string, string>> = {
    feat: 'Added',
    fix: 'Fixed',
    perf: 'Fixed',
    refactor: 'Changed',
    docs: 'Changed',
  };
  const buckets = new Map<string, string[]>();
  for (const subject of subjects) {
    const match = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(subject);
    const heading = groups[match?.[1] ?? ''] ?? 'Changed';
    const text = match?.[2] ?? subject;
    const bucket = buckets.get(heading) ?? [];
    bucket.push(text);
    buckets.set(heading, bucket);
  }
  const lines = [`## ${version}`, ''];
  for (const heading of ['Added', 'Fixed', 'Changed']) {
    const items = buckets.get(heading);
    if (items === undefined || items.length === 0) continue;
    lines.push(`### ${heading}`, '');
    for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  }
  return lines.join('\n');
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const workspaces = await listWorkspaces(root);
  const publishable = publishOrder(workspaces);
  const current = publishable[0]?.version ?? '0.0.1';
  const explicit = flagString(args, 'version');
  const bump = (flagString(args, 'bump') ?? 'patch') as Bump;
  const version = explicit ?? nextVersion(current, bump);
  const dryRun = flagBool(args, 'dry-run');

  const mismatched = publishable.filter((workspace) => workspace.version !== current);
  const log = await run(['git', 'log', '--pretty=format:%s', `v${current}..HEAD`], { cwd: root });
  const subjects = log.ok ? log.output.split('\n').filter((line) => line.trim().length > 0) : [];

  // Own version for the packages that publish; `@ultimat3/*` pins in every workspace, the private
  // reference app included, because they all resolve out of one lockfile.
  const published = new Set(publishable.map((workspace) => join(workspace.path, 'package.json')));
  const manifests = await workspaceManifests(root);

  if (!dryRun) {
    for (const path of manifests) {
      const raw = await Bun.file(path).text();
      const own = published.has(path) ? setOwnVersion(raw, version) : raw;
      await Bun.write(path, repinFrameworkDeps(own, version));
    }
    const changelogPath = join(root, 'CHANGELOG.md');
    const existing = await Bun.file(changelogPath)
      .text()
      .catch(() => '# Changelog\n\n');
    await Bun.write(changelogPath, insertRelease(existing, changelogEntry(version, subjects)));
  }

  report(
    {
      ok: true,
      script: 'release',
      summary: dryRun
        ? `would release ${publishable.length} packages at ${version}`
        : `${publishable.length} packages set to ${version}`,
      findings: mismatched.map((workspace) => ({
        code: 'X_RELEASE_VERSION_SKEW',
        cause: `${workspace.name} was at ${workspace.version}, not ${current}`,
        fix: `git diff packages/${workspace.dir}/package.json — this release realigns it to ${version}`,
        at: `packages/${workspace.dir}/package.json`,
      })),
      lines: [
        `  version   ${current} -> ${version}`,
        `  packages  ${publishable.map((workspace) => workspace.name).join(', ')}`,
        `  manifests ${manifests.length} rewritten (${published.size} published, the rest repinned)`,
        `  commits   ${subjects.length}`,
        `  next      bun install, commit, tag v${version}, then publish a GitHub Release`,
      ],
      data: {
        version,
        previous: current,
        packages: publishable.map((workspace) => workspace.name),
        manifests: manifests.length,
        commits: subjects.length,
        dryRun,
      },
    },
    args.json,
  );
}
