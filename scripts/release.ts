#!/usr/bin/env bun
// Lockstep versioning: every published package moves to the same version in one commit. Packages
// in this repo import each other by tier, so a mixed-version release means a user can install a
// combination we never tested. One version, one changelog entry, one tag.
//
//   bun run scripts/release.ts --bump minor [--dry-run] [--json]
//   bun run scripts/release.ts --bump major --security GHSA-xxxx-xxxx-xxxx   (inside the window)
//   bun run scripts/release.ts --bump minor --rehearse   (CI: the bump minus the changelog, uncommitted)

// why: Bun ships no path joiner.
import { join } from 'node:path';
import { SEMVER } from '@ultimat3/cli';
import { renderFixShellArg } from '../packages/core/src/error-render';
import { CHART_FILE, setChartVersions } from './chart-version';
import { rewriteMainCells } from './doc-unreleased';
import { flagBool, flagString, parseScriptArgs, type ScriptArgs } from './lib/args';
import { highlightFindings } from './lib/changelog-highlights';
import { type Changelog, parseChangelog } from './lib/changelog-sections';
import { assembleChangelog, readChangelogFiles } from './lib/changelog-store';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { bumpWindowFindings, majorWindowFindings, outsideWindowResult } from './lib/major-window';
import { promoteUnreleased, releaseDate } from './lib/release-changelog';
import { laneFindings, laneOf } from './lib/release-lane';
import { branchNameFindings, treeDirtyFindings } from './lib/release-preflight';
import { releaseInvocation, repinFrameworkDeps, setOwnVersion } from './lib/release-text';
import { badFlagFinding, isBump, RELEASE_FLAGS, readReleaseVersion } from './lib/release-version';
import {
  performReleaseWrites,
  releaseCheckFindings,
  stampReleaseFiles,
} from './lib/release-writes';
import { type RunOptions, type RunResult, repoRoot, run } from './lib/run';
import { STABILITY_PATH, withNextWindowLine } from './lib/stability-findings';
import {
  listWorkspaces,
  publishFloorFindings,
  publishOrder,
  type Workspace,
  workspaceManifests,
} from './lib/workspaces';
import type { PublicApiReport } from './public-api';
import { pendingBreaks, readApiAt, writeApiLock } from './release-api-lock';
import { type ReleaseDone, releaseDoneResult } from './release-done';
import { unlessRehearsed } from './release-rehearse';

export { bumpWindowFindings } from './lib/major-window';
export { laneFindings, laneOf, maintenanceMajor } from './lib/release-lane';
// The ask query lives with the other release subjects (`lib/release-subject.ts`), one definition
// for one query; re-exported here so this script stays the one module its callers import it from.
export { askIssueArgs, askLookupFailedLine, parseAskIssues } from './lib/release-subject';
export {
  releaseInvocation,
  releaseNextLine,
  repinFrameworkDeps,
  setOwnVersion,
} from './lib/release-text';
export type { Bump } from './lib/release-version';
export {
  BUMPS,
  isBump,
  nextVersion,
  RELEASE_FLAGS,
  readReleaseVersion,
  unknownReleaseFlags,
} from './lib/release-version';

/** The world one run touches: the repo, the subprocesses, the clock, and the two derived writers. */
export interface ReleaseDeps {
  readonly root: string;
  readonly run: (command: readonly string[], options: RunOptions) => Promise<RunResult>;
  readonly now: Date;
  readonly performWrites?: typeof performReleaseWrites;
  readonly writeLock?: typeof writeApiLock;
  /** The public surface judged as the version being cut; default `readApiAt`. */
  readonly readApi?: (root: string, version: string) => Promise<PublicApiReport>;
}

const refusal = (summary: string, findings: readonly Finding[], data?: unknown): ScriptResult => ({
  ok: false,
  script: 'release',
  summary,
  findings,
  ...(data === undefined ? {} : { data }),
});

/**
 * `--check <version>` writes nothing and answers one question: is this repo actually stamped at
 * the version about to be published? The lockstep rule on its own compares packages only to each
 * other, so 29 packages all at 1.2.0 pass while the tag says v1.10.1 — and the publish then dies
 * `EPUBLISHCONFLICT` on all 29. The release workflow runs this before `npm publish`.
 *
 * "Stamped" is EVERY file that carries the version, not the 31 manifests alone. It was the
 * manifests alone until 19.3.0, whose tag answered `31 packages are stamped at 19.3.0` and then
 * failed `verify` 157 seconds later on `framework.manifest.json`, 235 `bun.lock` facts and
 * `wiki/_Footer.md:8` — three files a bump derives from the manifests and did not write. This
 * step exists to refuse BEFORE the gate does, so the same three now have to answer here.
 */
async function checkResult(
  root: string,
  check: string,
  input: { readonly changelog: Changelog; readonly today: string; readonly packages: number },
): Promise<ScriptResult> {
  // The window too (wiki/Stability.md): the same rule the bump ran, so no bump PR merges past it.
  const findings = SEMVER.test(check)
    ? [
        ...(await releaseCheckFindings(root, check)),
        ...majorWindowFindings({ version: check, changelog: input.changelog, today: input.today }),
      ]
    : [badFlagFinding('check', check, 'a semver version (e.g. 1.3.0)')];
  return {
    ok: findings.length === 0,
    script: 'release',
    summary:
      findings.length === 0
        ? `${input.packages} packages are stamped at ${check}, and so is every file derived from them`
        : `${findings.length} finding(s): this repo is not at ${check}`,
    findings,
    data: { check, packages: input.packages },
  };
}

/** A workspace left behind by the last release: reported, and realigned by this one. */
const skewFindings = (
  publishable: readonly Workspace[],
  current: string,
  version: string,
): readonly Finding[] =>
  publishable
    .filter((workspace) => workspace.version !== current)
    .map((workspace) => ({
      code: 'X_RELEASE_VERSION_SKEW',
      cause: `${workspace.name} was at ${workspace.version}, not ${current}`,
      fix: `git diff packages/${renderFixShellArg(workspace.dir, '<dir>')}/package.json — this release realigns it to ${version}`,
      at: `packages/${workspace.dir}/package.json`,
    }));

/** The whole run for parsed `args`: the first refusal it reaches, or what the bump did. */
export async function releaseResult(args: ScriptArgs, deps: ReleaseDeps): Promise<ScriptResult> {
  const { root, run } = deps;
  const workspaces = await listWorkspaces(root);
  const publishable = publishOrder(workspaces);
  const current = publishable[0]?.version ?? '0.0.1';
  // Before `--check` and before any write: a tree that enumerates no publishable workspace is read
  // from the wrong place, and both answers below were `ok` over it ("0 packages are stamped").
  const floor = publishFloorFindings(workspaces);
  if (floor.length > 0) return refusal('refusing: no publishable workspace', floor);

  const read = await readChangelogFiles(root);
  const changelog = assembleChangelog(read.index, read.files);
  const date = releaseDate(deps.now);
  const check = flagString(args, 'check');
  if (check !== undefined) {
    return checkResult(root, check, { changelog, today: date, packages: publishable.length });
  }

  const explicit = flagString(args, 'version');
  const bumpFlag = flagString(args, 'bump');
  const resolved = readReleaseVersion({ explicit, bump: bumpFlag, current });
  if ('findings' in resolved) {
    return refusal(
      'refusing to release: the version to publish is not decidable',
      resolved.findings,
      { current },
    );
  }
  const version = resolved.version;
  const dryRun = flagBool(args, 'dry-run');
  const rehearse = flagBool(args, 'rehearse');
  const security = flagString(args, 'security');
  const window = outsideWindowResult(
    bumpWindowFindings({ version, changelog, today: date, security }),
    { version, current },
  );
  if (window !== undefined) return window;

  // Before anything is read, let alone written, and under `--dry-run` too so a dry run predicts
  // the real one: the release commit is `git add -A`, and over a dirty tree it carries whatever
  // else was in flight as part of a release nobody reviewed as one.
  const status = await run(['git', 'status', '--porcelain'], { cwd: root });
  const dirty = treeDirtyFindings(
    status.ok ? status.output : undefined,
    releaseInvocation({
      explicit,
      bump: bumpFlag !== undefined && isBump(bumpFlag) ? bumpFlag : undefined,
      dryRun,
      json: args.json,
      security,
      rehearse,
    }),
  );
  if (dirty.length > 0) {
    return refusal('refusing to release: the working tree is not clean', dirty, {
      version,
      current,
      dryRun,
    });
  }

  // Under `--dry-run` too. `release/*` is the maintenance lines' namespace, and both workflows run
  // on `release/<major>.x`: a bump branch named like one is how v31.1.0 got tagged off main (#1054).
  // A detached HEAD prints nothing and names no branch; a git that could not run refuses nothing.
  // On a `release/<major>.x` line the bump is a patch of that major, or nothing (SECURITY.md).
  const branch = await run(['git', 'branch', '--show-current'], { cwd: root });
  const branchName = branch.ok ? branch.output.trim() : undefined;
  const upstream = await run(['git', 'rev-parse', '--abbrev-ref', '@{upstream}'], { cwd: root });
  const line = laneOf(branchName, upstream.ok ? upstream.output.trim() : undefined);
  const lane = laneFindings({ branch: line, current, version });
  const misnamed = [...branchNameFindings(branchName, version), ...lane];
  if (misnamed.length > 0) {
    return refusal(
      lane.length > 0
        ? `refusing to release: ${line} ships patches of its own major only`
        : 'refusing to release: the branch is named like a maintenance line',
      misnamed,
      { version, current, dryRun },
    );
  }

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
  const unpromotable = unlessRehearsed(
    rehearse,
    'findings' in promoted
      ? promoted.findings
      : highlightFindings(parseChangelog(promoted.file.text, promoted.file.path)),
  );
  if (unpromotable.length > 0) {
    return refusal('refusing to release: CHANGELOG.md cannot be promoted', unpromotable, {
      version,
      current,
      dryRun,
    });
  }

  // Last of the refusals, under `--dry-run` too: an undeclared break that ships can never be
  // declared after (main refuses the `BREAKING —` line), so the lock would carry it forever. The
  // same report writes the lock below: the surface is compiled once per run.
  const api = await (deps.readApi ?? readApiAt)(root, version);
  const breaks = pendingBreaks(api);
  if (breaks.length > 0) {
    return refusal(
      `refusing to release: ${breaks.length} undeclared public API break(s) pending`,
      breaks,
      { version, current, dryRun },
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
      // A rehearsal stops before this side (`release-rehearse.ts`): it is the release PR's own act.
      ...unlessRehearsed(rehearse, [
        ...('findings' in promoted
          ? []
          : [
              {
                path: join(root, promoted.file.path),
                rewrite: () => promoted.file.text,
                create: true,
              },
              { path: join(root, 'CHANGELOG.md'), rewrite: () => promoted.index },
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
      ]),
    ]);
    if (stamped.findings.length > 0) {
      return {
        ...refusal(
          `refusing to continue: the bump stopped after ${stamped.written.length} file(s)`,
          stamped.findings,
          { version, current, written: stamped.written },
        ),
        lines: stamped.written.map((path) => `  wrote     ${path}`),
      };
    }
  }

  // AFTER the manifests, never before: all three of these are derived from what the loop above
  // just wrote, so a run that computed them first would record the version this release is leaving.
  const performed = dryRun
    ? { writes: [], findings: [] }
    : await (deps.performWrites ?? performReleaseWrites)(root, version);
  // Last of the derived files: the public API lock, the surface read above at this version, so the
  // next release's breaks are judged against this one.
  const apiLock = dryRun
    ? undefined
    : await (deps.writeLock ?? writeApiLock)(root, async () => api);

  // The ask this release would close — best effort, and last: by here the manifests are written,
  // so no answer from `gh` (absent binary, failed auth, timeout, garbage) may throw or touch
  // `ok`. The lookup can only add the `Fixes #<n>` close link to the next line.
  const done: ReleaseDone = {
    version,
    current,
    publishable: publishable.map((workspace) => workspace.name),
    manifests: manifests.length,
    published: published.size,
    skew: skewFindings(publishable, current, version),
    performed,
    apiLock,
    subjects: log.ok ? subjects : undefined,
    date,
    dryRun,
    rehearse,
    security,
  };
  return releaseDoneResult(done, rehearse ? undefined : (argv) => run(argv, { cwd: root }));
}

/** A flag this script does not declare: refused before anything is decided, `--check` included. */
export const unknownFlagsResult = (unknown: readonly string[]): ScriptResult => ({
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
});

if (import.meta.main) {
  // Before anything is decided, let alone written — `--check` included: a flag this script does not
  // declare is a mistake, and the mistake this guard exists for wrote 47 manifests.
  const args = parseScriptArgs(Bun.argv.slice(2), {
    names: RELEASE_FLAGS,
    refuse: (unknown, flags) => report(unknownFlagsResult(unknown), flags.get('json') === true),
  });
  report(await releaseResult(args, { root: repoRoot(), run, now: new Date() }), args.json);
}
