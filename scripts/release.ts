#!/usr/bin/env bun
// Lockstep versioning: every published package moves to the same version in one commit. Packages
// in this repo import each other by tier, so a mixed-version release means a user can install a
// combination we never tested. One version, one changelog entry, one tag.
//
//   bun run scripts/release.ts --bump minor [--dry-run] [--json]
//   bun run scripts/release.ts --bump major --security GHSA-xxxx-xxxx-xxxx   (inside the window)

import { join } from 'node:path';
import { SEMVER } from '@ultimat3/cli';
import { CHART_FILE, setChartVersions } from './chart-version';
import { rewriteMainCells } from './doc-unreleased';
import { flagBool, flagString, parseScriptArgs } from './lib/args';
import { highlightFindings } from './lib/changelog-highlights';
import { parseChangelog } from './lib/changelog-sections';
import { assembleChangelog, readChangelogFiles } from './lib/changelog-store';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import {
  bumpWindowFindings,
  majorWindowFindings,
  refuseOutsideWindow,
  securityLines,
} from './lib/major-window';
import { promoteUnreleased, releaseDate } from './lib/release-changelog';
import { treeDirtyFindings } from './lib/release-preflight';
import { askIssueArgs, askLookupFailedLine, askTwin, parseAskIssues } from './lib/release-subject';
import {
  type Bump,
  badFlagFinding,
  isBump,
  RELEASE_FLAGS,
  readReleaseVersion,
} from './lib/release-version';
import {
  performedWriteLine,
  performReleaseWrites,
  plannedWriteLine,
  RELEASE_WRITES,
  releaseCheckFindings,
  stampReleaseFiles,
} from './lib/release-writes';
import { repoRoot, run } from './lib/run';
import { STABILITY_PATH, withNextWindowLine } from './lib/stability-findings';
import {
  listWorkspaces,
  publishFloorFindings,
  publishOrder,
  workspaceManifests,
} from './lib/workspaces';

export { bumpWindowFindings } from './lib/major-window';
// The ask query lives with the other release subjects (`lib/release-subject.ts`), one definition
// for one query; re-exported here so this script stays the one module its callers import it from.
export { askIssueArgs, askLookupFailedLine, parseAskIssues } from './lib/release-subject';
export type { Bump } from './lib/release-version';
export {
  BUMPS,
  isBump,
  nextVersion,
  RELEASE_FLAGS,
  readReleaseVersion,
  unknownReleaseFlags,
} from './lib/release-version';

/**
 * This run, re-stated from VALIDATED values only — never the raw argv — so a refusal's `fix:` can
 * repeat it with nothing a shell would read as syntax.
 */
export const releaseInvocation = (input: {
  readonly explicit: string | undefined;
  readonly bump: Bump | undefined;
  readonly dryRun: boolean;
  readonly json: boolean;
  /** Only after `bumpWindowFindings` held it to `ADVISORY_ID`: no shell syntax can reach here. */
  readonly security?: string | undefined;
}): string =>
  [
    'bun run scripts/release.ts',
    input.explicit === undefined
      ? `--bump ${input.bump ?? 'patch'}`
      : `--version ${input.explicit}`,
    ...(input.security === undefined ? [] : [`--security ${input.security}`]),
    ...(input.dryRun ? ['--dry-run'] : []),
    ...(input.json ? ['--json'] : []),
  ].join(' ');

/**
 * What a finished bump owes next. No tag: `.github/workflows/release-tag.yml` cuts the annotated
 * tag, the Release and the publish once ci.yml passes on the merged commit, and the hand tag this
 * line used to print was the step that kept going wrong.
 *
 * `fixes` is `Fixes #<n>` for a confirmed open ask: the PR body carries it, so the merge that is
 * the release closes the ask too. Without one the line is byte-identical to its old form — no
 * close promised that no ask answers.
 */
export const releaseNextLine = (version: string, fixes?: string): string =>
  fixes === undefined
    ? `  next      bun install, commit, open the \`chore: release ${version}\` PR; merging it is the release (release-tag.yml)`
    : `  next      bun install, commit, open the \`chore: release ${version}\` PR with \`${fixes}\` in the body; merging it is the release (release-tag.yml) and closes the ask`;

/** The only dependency range a lockstep release rewrites — a caret or a tag is somebody's intent. */
const EXACT_PIN = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)*$/;

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

if (import.meta.main) {
  // Before anything is decided, let alone written — `--check` included: a flag this script does not
  // declare is a mistake, and the mistake this guard exists for wrote 47 manifests.
  const args = parseScriptArgs(Bun.argv.slice(2), {
    names: RELEASE_FLAGS,
    refuse: (unknown, flags) =>
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
          data: { unknown },
        },
        flags.get('json') === true,
      ),
  });
  const root = repoRoot();
  const workspaces = await listWorkspaces(root);
  const publishable = publishOrder(workspaces);
  const current = publishable[0]?.version ?? '0.0.1';
  // Before `--check` and before any write: a tree that enumerates no publishable workspace is read
  // from the wrong place, and both answers below were `ok` over it ("0 packages are stamped").
  const floor = publishFloorFindings(workspaces);
  if (floor.length > 0) {
    report(
      {
        ok: false,
        script: 'release',
        summary: 'refusing: no publishable workspace',
        findings: floor,
      },
      args.json,
    );
  }

  // `--check <version>` writes nothing and answers one question: is this repo actually stamped at
  // the version about to be published? The lockstep rule on its own compares packages only to each
  // other, so 29 packages all at 1.2.0 pass while the tag says v1.10.1 — and the publish then dies
  // `EPUBLISHCONFLICT` on all 29. The release workflow runs this before `npm publish`.
  //
  // "Stamped" is EVERY file that carries the version, not the 31 manifests alone. It was the
  // manifests alone until 19.3.0, whose tag answered `31 packages are stamped at 19.3.0` and then
  // failed `verify` 157 seconds later on `framework.manifest.json`, 235 `bun.lock` facts and
  // `wiki/_Footer.md:8` — three files a bump derives from the manifests and did not write. This
  // step exists to refuse BEFORE the gate does, so the same three now have to answer here.
  const check = flagString(args, 'check');
  const changelogPath = join(root, 'CHANGELOG.md');
  const read = await readChangelogFiles(root);
  const changelog = assembleChangelog(read.index, read.files);
  const date = releaseDate(new Date());
  if (check !== undefined) {
    // The window too (wiki/Stability.md): the same rule the bump ran, so no bump PR merges past it.
    const findings = SEMVER.test(check)
      ? [
          ...(await releaseCheckFindings(root, check)),
          ...majorWindowFindings({ version: check, changelog, today: date }),
        ]
      : [badFlagFinding('check', check, 'a semver version (e.g. 1.3.0)')];
    report(
      {
        ok: findings.length === 0,
        script: 'release',
        summary:
          findings.length === 0
            ? `${publishable.length} packages are stamped at ${check}, and so is every file derived from them`
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
  const security = flagString(args, 'security');
  refuseOutsideWindow(
    bumpWindowFindings({ version, changelog, today: date, security }),
    { version, current },
    args.json,
  );

  // Before anything is read, let alone written, and under `--dry-run` too so a dry run predicts
  // the real one: the release commit is `git add -A`, and over a dirty tree it carries whatever
  // else was in flight as part of a release nobody reviewed as one.
  const status = await run(['git', 'status', '--porcelain'], { cwd: root });
  const bumpFlag = flagString(args, 'bump');
  const dirty = treeDirtyFindings(
    status.ok ? status.output : undefined,
    releaseInvocation({
      explicit: flagString(args, 'version'),
      bump: bumpFlag !== undefined && isBump(bumpFlag) ? bumpFlag : undefined,
      dryRun,
      json: args.json,
      security,
    }),
  );
  if (dirty.length > 0) {
    report(
      {
        ok: false,
        script: 'release',
        summary: 'refusing to release: the working tree is not clean',
        findings: dirty,
        data: { version, current, dryRun },
      },
      args.json,
    );
  }

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
  const promoted = promoteUnreleased({
    index: read.index,
    changelog,
    version,
    date,
    subjects,
    security,
  });
  // A section from 30.0.0 without its Highlights would red the gate the moment it exists: read
  // off the new release file itself, the one the Release body is cut from.
  const unpromotable =
    'findings' in promoted
      ? promoted.findings
      : highlightFindings(parseChangelog(promoted.file.text, promoted.file.path));
  if (unpromotable.length > 0) {
    report(
      {
        ok: false,
        script: 'release',
        summary: 'refusing to release: CHANGELOG.md cannot be promoted',
        findings: unpromotable,
        data: { version, current, dryRun },
      },
      args.json,
    );
  }

  if (!dryRun) {
    // Own version for the published manifests, pins for all; then the Helm chart, which is not a
    // workspace — `appVersion` is the default `image.tag`, so a chart left behind names an image tag
    // this release never pushes (it sat at 0.0.1 through every 1.x release) — then the changelog.
    const stamped = await stampReleaseFiles(root, [
      ...manifests.map((path) => ({
        path,
        rewrite: (raw: string) =>
          repinFrameworkDeps(published.has(path) ? setOwnVersion(raw, version) : raw, version),
      })),
      {
        path: join(root, CHART_FILE),
        rewrite: (raw: string) => setChartVersions(raw, version),
        optional: true,
      },
      // The release's own file, then the index that links it: [Unreleased] reset, one row added.
      ...('findings' in promoted
        ? []
        : [
            {
              path: join(root, promoted.file.path),
              rewrite: () => promoted.file.text,
              create: true,
            },
            { path: changelogPath, rewrite: () => promoted.index },
          ]),
      // The same step as the promotion: a Known-Gaps `main` cell names what [Unreleased] carried,
      // and this release is where it shipped (`doc-unreleased.ts` refuses one left behind).
      {
        path: join(root, 'wiki/Known-Gaps.md'),
        rewrite: (raw: string) => rewriteMainCells(raw, version).text,
        optional: true,
      },
      // wiki/Stability.md's next-window date, from the changelog just promoted: a major's own
      // release PR would otherwise red the gate on the date it was never told (`stability-findings`).
      {
        path: join(root, STABILITY_PATH),
        rewrite: (raw: string) =>
          'findings' in promoted ? raw : withNextWindowLine(raw, promoted.changelog),
        optional: true,
      },
    ]);
    if (stamped.findings.length > 0) {
      report(
        {
          ok: false,
          script: 'release',
          summary: `refusing to continue: the bump stopped after ${stamped.written.length} file(s)`,
          findings: stamped.findings,
          lines: stamped.written.map((path) => `  wrote     ${path}`),
          data: { version, current, written: stamped.written },
        },
        args.json,
      );
    }
  }

  // AFTER the manifests, never before: all three of these are derived from what the loop above
  // just wrote, so a run that computed them first would record the version this release is leaving.
  const performed = dryRun
    ? { writes: [], findings: [] }
    : await performReleaseWrites(root, version);

  // The ask this release would close — best effort, and last: by here the manifests are written,
  // so no answer from `gh` (absent binary, failed auth, timeout, garbage) may throw or touch
  // `ok`. The lookup can only add the `Fixes #<n>` close link to the next line, or one printed
  // line saying it could not confirm; a release never waits on it being more.
  const lookup = await run(['gh', ...askIssueArgs(version)], { cwd: root }).catch(() => undefined);
  const openAsks = lookup?.ok === true ? parseAskIssues(lookup.output) : undefined;
  const twin = openAsks === undefined ? undefined : askTwin(openAsks, version);

  report(
    {
      // Findings, not decoration: `ok: true` unconditionally meant a run that reported real
      // X_RELEASE_VERSION_SKEW still exited 0, so the one signal a release pipeline reads said the
      // repo was in a releasable state while the report below said it was not.
      // A write this run could not perform is a failing release, not a footnote: the tree it leaves
      // behind is the one the tag would be cut on, and the gate reads all three files.
      ok: skew.length === 0 && performed.findings.length === 0,
      script: 'release',
      summary: dryRun
        ? `would release ${publishable.length} packages at ${version}`
        : `${publishable.length} packages set to ${version}`,
      findings: [...skew, ...performed.findings],
      lines: [
        `  version   ${current} -> ${version}`,
        `  packages  ${publishable.map((workspace) => workspace.name).join(', ')}`,
        `  manifests ${manifests.length} rewritten (${published.size} published, the rest repinned)`,
        `  chart     ${CHART_FILE} version + appVersion -> ${version}`,
        `  changelog [Unreleased] promoted to docs/changelog/${version}.md, its row in CHANGELOG.md, a fresh [Unreleased]`,
        `  gaps      wiki/Known-Gaps.md \`main\` cells -> **${version}**`,
        `  stability ${STABILITY_PATH} next-window line from the promoted changelog`,
        // Three lines either way: a dry run that listed only what it would NOT do is how the three
        // derived files stayed invisible for nineteen majors.
        ...(dryRun
          ? RELEASE_WRITES.map(plannedWriteLine)
          : performed.writes.map(performedWriteLine)),
        log.ok
          ? `  commits   ${subjects.length} since v${current}, appended under ### Commits`
          : `  commits   none listed — this clone has no v${current} tag to bound the range`,
        ...securityLines(version, security),
        releaseNextLine(version, twin === undefined ? undefined : `Fixes #${twin.number}`),
        ...(twin === undefined && openAsks === undefined ? [askLookupFailedLine(version)] : []),
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
        ...(security === undefined ? {} : { security }),
        ...(twin === undefined ? {} : { openAsk: { number: twin.number, title: twin.title } }),
        writes: dryRun
          ? RELEASE_WRITES.map((spec) => ({ kind: spec.kind, at: spec.at, command: spec.command }))
          : performed.writes,
      },
    },
    args.json,
  );
}
