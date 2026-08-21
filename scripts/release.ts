#!/usr/bin/env bun
// Lockstep versioning: every published package moves to the same version in one commit. Packages
// in this repo import each other by tier, so a mixed-version release means a user can install a
// combination we never tested. One version, one changelog entry, one tag.
//
//   bun run scripts/release.ts --bump minor [--dry-run] [--json]

import { join } from 'node:path';
import { checkPackageShape, SEMVER } from '@ultimat3/cli';
import { parseChangelog } from './changelog-check';
import { CHART_FILE, setChartVersions } from './chart-version';
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

/**
 * The flags this script accepts. Anything else is refused before a manifest is touched — see
 * `readReleaseVersion` for why an unrecognised token must never reach the rewrite.
 */
export const RELEASE_FLAGS = ['version', 'bump', 'check', 'dry-run', 'json'] as const;

/** Every `--flag` the caller passed that this script does not declare. */
export const unknownReleaseFlags = (flags: Iterable<string>): readonly string[] =>
  [...flags].filter((name) => !(RELEASE_FLAGS as readonly string[]).includes(name)).sort();

/**
 * Both flags, refused before a single manifest is rewritten.
 *
 * The absent case is a REFUSAL, not a patch bump. It defaulted to `patch`, so any invocation the
 * parser did not recognise — `--help` most obviously, since this script has never had one — fell
 * through to "no explicit, no bump" and rewrote 47 manifests plus the chart. A release is the most
 * expensive thing in this repo to undo, and it was the one script that acted on a typo. The
 * version to publish is always somebody's decision, so it is always stated.
 */
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
  if (input.explicit === undefined && input.bump === undefined) {
    findings.push({
      code: 'X_RELEASE_VERSION_UNSTATED',
      cause: `neither --version nor --bump was given, and this repo is at ${input.current}`,
      fix: `bun run scripts/release.ts --bump patch --dry-run --json   # or --version ${input.current}`,
      at: 'scripts/release.ts',
    });
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

export const UNRELEASED_HEADING = '## [Unreleased]';
/** What a fresh `[Unreleased]` says once the release has taken its body. */
export const UNRELEASED_PLACEHOLDER = 'Nothing yet.';

/**
 * The commit subjects go INSIDE the promoted section, under a heading no hand-written section uses.
 * Generating `### Added` / `### Fixed` / `### Changed` was how a release ended up with two
 * `### Fixed` blocks in one section — the generated one below the hand-written one, saying the same
 * thing in worse words.
 */
export const commitBlock = (subjects: readonly string[]): readonly string[] =>
  subjects.length === 0
    ? []
    : ['### Commits', '', ...subjects.map((subject) => `- ${subject}`), ''];

/**
 * PROMOTE, never append. `[Unreleased]` IS the release notes — hand-written as each change lands,
 * migration and all — so a release renames that heading to the version and opens a fresh empty
 * `[Unreleased]` above it.
 *
 * What appending produced is commit 8fe7c56d — `git show 8fe7c56d:CHANGELOG.md`, this script's own
 * output for `release: 6.0.0`: seven `BREAKING —` entries still under `## [Unreleased]`, a
 * `## 6.0.0` holding six merge subjects and nothing else, and two `## 5.0.1` plus two `## 5.0.0`
 * headings left by the two runs before it — an auto section above a hand-written one, same version.
 * `wiki/Upgrading.md` pointed at the `6.0.0` section throughout.
 *
 * `git show v6.0.0:CHANGELOG.md` does NOT show this: the tag points at 93443aeb, a human repairing
 * 8fe7c56d by hand. Read the tag and the bug is invisible; read 8fe7c56d and it is the whole diff.
 *
 * Promotion cannot produce either shape ON ITS OWN: one heading is renamed rather than duplicated.
 * It can still be ASKED for a version the page already holds — `--version 6.0.0` re-run after a
 * botched release, or run against 93443aeb, where a human had already written that section by hand
 * — and renaming `[Unreleased]` to a heading that exists puts a second one directly above it. That
 * is refused, not written: `checkChangelog` would red on the result, and it would red after 47
 * manifests, the chart and CHANGELOG.md had already moved.
 *
 * Keep a Changelog stays newest-first for free — `[Unreleased]` is the top section, so the version
 * it becomes lands above every previous one.
 */
export function promoteUnreleased(input: {
  readonly changelog: string;
  readonly version: string;
  readonly date: string;
  readonly subjects: readonly string[];
}): { readonly changelog: string } | { readonly findings: readonly Finding[] } {
  // `parseChangelog`, not a regex of this file's own: what counts as "the 6.0.0 section" is the
  // gate's question, and two answers to it is how a release passes here and reds there.
  const held = parseChangelog(input.changelog).find((section) => section.version === input.version);
  if (held !== undefined) {
    return {
      findings: [
        {
          code: 'X_DOC_CHANGELOG_SECTION_INVALID',
          cause: `CHANGELOG.md:${held.line} already holds \`## ${held.heading}\`, so promoting [Unreleased] to ${input.version} would write a second section for one version`,
          fix: `release a version CHANGELOG.md does not already hold: bun run scripts/release.ts --bump patch --dry-run --json, or delete the \`## ${held.heading}\` section if that release never shipped`,
          at: `CHANGELOG.md:${held.line}`,
        },
      ],
    };
  }
  const lines = input.changelog.split('\n');
  const at = lines.findIndex((line) => /^## \[Unreleased\]/i.test(line));
  if (at === -1) {
    return {
      findings: [
        {
          code: 'X_RELEASE_UNRELEASED_MISSING',
          cause: 'CHANGELOG.md has no `## [Unreleased]` heading, so there is nothing to promote',
          fix: 'add `## [Unreleased]` under the preamble of CHANGELOG.md, above the newest version',
          at: 'CHANGELOG.md',
        },
      ],
    };
  }
  let end = lines.length;
  for (let index = at + 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').startsWith('## ')) {
      end = index;
      break;
    }
  }
  const body = lines
    .slice(at + 1, end)
    .filter((line) => line.trim() !== UNRELEASED_PLACEHOLDER)
    .join('\n')
    .trim();
  const commits = commitBlock(input.subjects);
  if (body.length === 0 && commits.length === 0) {
    return {
      findings: [
        {
          code: 'X_DOC_CHANGELOG_SECTION_INVALID',
          cause: `[Unreleased] is empty and no commit landed since the previous tag, so ${input.version} would ship a section that says nothing`,
          fix: 'write the release notes under `## [Unreleased]` in CHANGELOG.md, then run this again',
          at: 'CHANGELOG.md',
        },
      ],
    };
  }
  const section = [`## ${input.version} - ${input.date}`, ''];
  if (body.length > 0) section.push(...body.split('\n'), '');
  section.push(...commits);
  return {
    changelog: [
      ...lines.slice(0, at),
      UNRELEASED_HEADING,
      '',
      UNRELEASED_PLACEHOLDER,
      '',
      ...section,
      ...lines.slice(end),
    ].join('\n'),
  };
}

/**
 * `en-CA` is ISO-8601 by locale, and the zone is stated because nothing here may format a date
 * without one. UTC, so a release cut at 23:00 in one timezone is not dated a day apart from the tag.
 */
export const releaseDate = (at: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);

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

  // Before anything is decided, let alone written: a flag this script does not declare is a
  // mistake, and the mistake this guard exists for wrote 47 manifests.
  const unknown = unknownReleaseFlags(args.flags.keys());
  if (unknown.length > 0) {
    report(
      {
        ok: false,
        script: 'release',
        summary: `refusing to release: ${unknown.length} unknown flag(s)`,
        findings: unknown.map((name) => ({
          code: 'X_RELEASE_FLAG_UNKNOWN',
          cause: `--${name} is not a flag scripts/release.ts declares (known: ${RELEASE_FLAGS.join(', ')})`,
          fix: 'bun run scripts/release.ts --bump patch --dry-run --json',
          at: 'scripts/release.ts',
        })),
        data: { unknown, current },
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
  // Bounded by the PREVIOUS tag, so a subject that shipped in an earlier release cannot appear
  // under this one. A clone without that tag answers nothing rather than everything — the report
  // says so on its own line, because a silent empty list reads exactly like a quiet release.
  const log = await run(['git', 'log', '--pretty=format:%s', `v${current}..HEAD`], { cwd: root });
  const subjects = log.ok ? log.output.split('\n').filter((line) => line.trim().length > 0) : [];

  // Own version for the packages that publish; `@ultimat3/*` pins in every workspace, the private
  // reference app included, because they all resolve out of one lockfile.
  const published = new Set(publishable.map((workspace) => join(workspace.path, 'package.json')));
  const manifests = await workspaceManifests(root);

  // Computed before a single manifest is rewritten, and under `--dry-run` too: a changelog that
  // cannot be promoted is a release that must not start, and finding that out after 47 files have
  // moved is the expensive order to find it out in.
  const changelogPath = join(root, 'CHANGELOG.md');
  const date = releaseDate(new Date());
  const promoted = promoteUnreleased({
    changelog: await Bun.file(changelogPath)
      .text()
      .catch(() => ''),
    version,
    date,
    subjects,
  });
  if ('findings' in promoted) {
    report(
      {
        ok: false,
        script: 'release',
        summary: 'refusing to release: CHANGELOG.md cannot be promoted',
        findings: promoted.findings,
        data: { version, current, dryRun },
      },
      args.json,
    );
  }

  if (!dryRun) {
    for (const path of manifests) {
      const raw = await Bun.file(path).text();
      const own = published.has(path) ? setOwnVersion(raw, version) : raw;
      await Bun.write(path, repinFrameworkDeps(own, version));
    }
    // The Helm chart moves with them. It is not a workspace, so the loop above cannot reach it —
    // and `appVersion` is the default `image.tag`, so a chart left behind names an image tag this
    // release never pushes. It sat at 0.0.1 through every 1.x release for exactly that reason.
    const chartPath = join(root, CHART_FILE);
    const chart = Bun.file(chartPath);
    if (await chart.exists()) {
      await Bun.write(chartPath, setChartVersions(await chart.text(), version));
    }
    await Bun.write(changelogPath, promoted.changelog);
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
        `  chart     ${CHART_FILE} version + appVersion -> ${version}`,
        `  changelog [Unreleased] promoted to "## ${version} - ${date}", a fresh [Unreleased] above it`,
        log.ok
          ? `  commits   ${subjects.length} since v${current}, appended under ### Commits`
          : `  commits   none listed — this clone has no v${current} tag to bound the range`,
        `  next      bun install, commit, tag v${version}, then publish a GitHub Release`,
      ],
      data: {
        version,
        previous: current,
        packages: publishable.map((workspace) => workspace.name),
        manifests: manifests.length,
        commits: subjects.length,
        previousTagFound: log.ok,
        changelogDate: date,
        dryRun,
      },
    },
    args.json,
  );
}
