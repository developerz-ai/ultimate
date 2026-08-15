#!/usr/bin/env bun
// Lockstep versioning: every published package moves to the same version in one commit. Packages
// in this repo import each other by tier, so a mixed-version release means a user can install a
// combination we never tested. One version, one changelog entry, one tag.
//
//   bun run scripts/release.ts --bump minor [--dry-run] [--json]

import { join } from 'node:path';
import { checkPackageShape, SEMVER } from '@ultimat3/cli';
import { flagBool, flagString, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot, run } from './lib/run';
import { listWorkspaces, publishOrder, workspaceManifests } from './lib/workspaces';

export const BUMPS = ['patch', 'minor', 'major'] as const;

export type Bump = (typeof BUMPS)[number];

/**
 * `--bump` was cast to the union with no check, so `--bump majr` fell through both branches of
 * `nextVersion` and produced a PATCH — a breaking change shipped as 1.2.1 across all 29 manifests,
 * with an exit code of 0. `--version` was equally unvalidated: `--version 1.2` wrote `"1.2"` into
 * every package.json.
 */
export const isBump = (value: string): value is Bump =>
  (BUMPS as readonly string[]).includes(value);

const badFlagFinding = (flag: string, value: string, expected: string): Finding => ({
  code: 'X_CLI_BAD_FLAG',
  cause: `--${flag} ${value} is not ${expected}`,
  fix: `bun run scripts/release.ts --bump minor --dry-run --json`,
  at: 'scripts/release.ts',
});

/** Both flags, refused before a single manifest is rewritten. */
export function readReleaseVersion(input: {
  readonly explicit: string | undefined;
  readonly bump: string | undefined;
  readonly current: string;
}): { version: string } | { findings: readonly Finding[] } {
  const findings: Finding[] = [];
  if (input.bump !== undefined && !isBump(input.bump)) {
    findings.push(badFlagFinding('bump', input.bump, `one of ${BUMPS.join(', ')}`));
  }
  if (input.explicit !== undefined && !SEMVER.test(input.explicit)) {
    findings.push(badFlagFinding('version', input.explicit, 'a semver version (e.g. 1.3.0)'));
  }
  if (findings.length > 0) return { findings };
  return {
    version: input.explicit ?? nextVersion(input.current, (input.bump ?? 'patch') as Bump),
  };
}

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

  // `--check <version>` writes nothing and answers one question: is this repo actually stamped at
  // the version about to be published? The lockstep rule on its own compares packages only to each
  // other, so 29 packages all at 1.2.0 pass while the tag says v1.10.1 — and the publish then dies
  // `EPUBLISHCONFLICT` on all 29. The release workflow runs this before `npm publish`.
  const check = flagString(args, 'check');
  if (check !== undefined) {
    const findings = SEMVER.test(check)
      ? await checkPackageShape(root, { release: check })
      : [badFlagFinding('check', check, 'a semver version (e.g. 1.3.0)')];
    report(
      {
        ok: findings.length === 0,
        script: 'release',
        summary:
          findings.length === 0
            ? `${publishable.length} packages are stamped at ${check}`
            : `${findings.length} finding(s): this repo is not at ${check}`,
        findings,
        data: { check, packages: publishable.length },
      },
      args.json,
    );
  }

  const resolved = readReleaseVersion({
    explicit: flagString(args, 'version'),
    bump: flagString(args, 'bump'),
    current,
  });
  if ('findings' in resolved) {
    report(
      {
        ok: false,
        script: 'release',
        summary: 'refusing to release: the version to publish is not decidable',
        findings: resolved.findings,
        data: { current },
      },
      args.json,
    );
  }
  const version = resolved.version;
  const dryRun = flagBool(args, 'dry-run');

  const mismatched = publishable.filter((workspace) => workspace.version !== current);
  const skew: readonly Finding[] = mismatched.map((workspace) => ({
    code: 'X_RELEASE_VERSION_SKEW',
    cause: `${workspace.name} was at ${workspace.version}, not ${current}`,
    fix: `git diff packages/${workspace.dir}/package.json — this release realigns it to ${version}`,
    at: `packages/${workspace.dir}/package.json`,
  }));
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
      // Findings, not decoration: `ok: true` unconditionally meant a run that reported real
      // X_RELEASE_VERSION_SKEW still exited 0, so the one signal a release pipeline reads said the
      // repo was in a releasable state while the report below said it was not.
      ok: skew.length === 0,
      script: 'release',
      summary: dryRun
        ? `would release ${publishable.length} packages at ${version}`
        : `${publishable.length} packages set to ${version}`,
      findings: skew,
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
