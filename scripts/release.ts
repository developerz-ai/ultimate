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
import { listWorkspaces, publishOrder } from './lib/workspaces';

export type Bump = 'patch' | 'minor' | 'major';

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

  if (!dryRun) {
    for (const workspace of publishable) {
      const path = join(workspace.path, 'package.json');
      const raw = await Bun.file(path).text();
      await Bun.write(path, raw.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`));
    }
    const changelogPath = join(root, 'CHANGELOG.md');
    const existing = await Bun.file(changelogPath)
      .text()
      .catch(() => '# Changelog\n\n');
    await Bun.write(changelogPath, `${existing.trimEnd()}\n\n${changelogEntry(version, subjects)}`);
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
        fix: 'lockstep versioning: this release realigns it — review the diff before committing',
        at: `packages/${workspace.dir}/package.json`,
      })),
      lines: [
        `  version   ${current} -> ${version}`,
        `  packages  ${publishable.map((workspace) => workspace.name).join(', ')}`,
        `  commits   ${subjects.length}`,
        `  next      commit, tag v${version}, then publish a GitHub Release`,
      ],
      data: {
        version,
        previous: current,
        packages: publishable.map((workspace) => workspace.name),
        commits: subjects.length,
        dryRun,
      },
    },
    args.json,
  );
}
