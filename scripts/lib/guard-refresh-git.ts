// The git half of `changelog-check`'s guard-refresh rule: the release tags bounding each range,
// the guard templates each range changed, and a finding per gap `lib/guard-refresh-rows.ts` finds.
// A tag this clone lacks is fetched by `fetchFromOrigin` — depth 1 only into a clone already
// shallow, so a full clone is never cut; CI fetches both tags once, before the parallel tests.

// why: the LEAF modules, never the `@ultimat3/cli` barrel — the import deprecation-window.ts makes.
import { quoteArg } from '../../packages/cli/src/shell-quote';
import { SHIPPED_GUARD_NAMES } from '../../packages/cli/src/templates/scaffold-guards';
import { remoteTagProbe, type TagProbe } from '../registry-audit';
import type { Changelog } from './changelog-sections';
import { fetchFromOrigin, type GitRunner } from './git-fetch';
import {
  changedGuards,
  GUARD_REFRESH_PAGE,
  GUARD_TEMPLATE_DIR,
  type GuardChange,
  type GuardRefreshGap,
  guardRefreshGaps,
} from './guard-refresh-rows';
import type { Finding } from './log';
import { git } from './release-due-git';
import { MAX_UNTAGGED_SECTIONS, releasedVersions } from './release-tag-walk';

export interface GuardRefreshOptions {
  readonly runner?: GitRunner;
  readonly probe?: TagProbe;
  /** The shipped guard names; the CLI's `SHIPPED` list unless a test names its own. */
  readonly shipped?: readonly string[];
  /** The guard modules that import a helper stem; read off the tree unless a test answers. */
  readonly importers?: (stem: string) => Promise<readonly string[]>;
}

/** The bounded, non-interactive git every read here goes through. */
const boundedGit: GitRunner = (command, { cwd }) => git(command.slice(1), cwd);

const unreachable = (tag: string): Finding => ({
  code: 'X_RELEASE_TAG_UNREACHABLE',
  cause: `${tag} bounds the guard templates ${GUARD_REFRESH_PAGE} must name a refresh for, and neither this clone nor origin could answer for it — a shallow or tagless clone, or a remote that could not be asked`,
  fix: `git fetch --no-tags origin ${quoteArg(`+refs/tags/${tag}:refs/tags/${tag}`)} && bun run changelog-check --json`,
  at: 'CHANGELOG.md',
});

type TagState = 'present' | 'absent' | 'unreachable';

async function ensureTag(
  root: string,
  tag: string,
  runner: GitRunner,
  probe: TagProbe,
): Promise<TagState> {
  const local = async (): Promise<boolean> =>
    (
      await runner(['git', 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], {
        cwd: root,
      })
    ).ok;
  if (await local()) return 'present';
  const held = await probe(tag);
  if (held === undefined) return 'unreachable';
  if (!held) return 'absent';
  const ref = `+refs/tags/${tag}:refs/tags/${tag}`;
  await fetchFromOrigin(root, ['--quiet', '--no-tags', 'origin', ref], runner);
  return (await local()) ? 'present' : 'unreachable';
}

type Bound = { readonly version?: string; readonly finding?: Finding };

/**
 * The first of `versions` with a tag, skipping those origin says it never tagged. A version
 * nobody can answer for refuses, and so does running out of the untagged allowance.
 */
async function firstTagged(
  root: string,
  versions: readonly string[],
  runner: GitRunner,
  probe: TagProbe,
): Promise<Bound> {
  for (const version of versions.slice(0, MAX_UNTAGGED_SECTIONS)) {
    const state = await ensureTag(root, `v${version}`, runner, probe);
    if (state === 'present') return { version };
    if (state === 'unreachable') return { finding: unreachable(`v${version}`) };
  }
  // Every section ran out: the oldest release has no earlier one to bound it, which is no gap.
  if (versions.length < MAX_UNTAGGED_SECTIONS) return {};
  return { finding: unreachable(`v${versions[0] ?? '0.0.0'}`) };
}

/**
 * The newest released version origin holds a tag for, and the newest tagged release below it. A
 * bump PR's section is untagged, and so is a release stamped but never published: skipped, so the
 * range runs from the last release an adopter could install — the honest one.
 */
export async function releaseBounds(
  root: string,
  changelog: Changelog,
  runner: GitRunner,
  probe: TagProbe,
): Promise<
  { readonly latest: string; readonly previous?: string } | { readonly finding: Finding }
> {
  const released = releasedVersions(changelog);
  const latest = await firstTagged(root, released, runner, probe);
  if (latest.finding !== undefined) return { finding: latest.finding };
  if (latest.version === undefined) return { finding: unreachable(`v${released[0] ?? '0.0.0'}`) };
  const older = released.slice(released.indexOf(latest.version) + 1);
  const below = await firstTagged(root, older, runner, probe);
  if (below.finding !== undefined) return { finding: below.finding };
  return below.version === undefined
    ? { latest: latest.version }
    : { latest: latest.version, previous: below.version };
}

/** The shipped guard modules that import `./guard-<stem>`, read off the working tree. */
const treeImporters =
  (root: string, shipped: readonly string[]) =>
  async (stem: string): Promise<readonly string[]> => {
    const names: string[] = [];
    for (const name of shipped) {
      const file = Bun.file(`${root}/${GUARD_TEMPLATE_DIR}/guard-${name}.ts`);
      if ((await file.exists()) && (await file.text()).includes(`from './guard-${stem}'`)) {
        names.push(name);
      }
    }
    return names;
  };

/** `git diff --name-only` over the templates: two tags, or one tag against the working tree. */
async function changedPaths(
  root: string,
  refs: readonly string[],
  runner: GitRunner,
): Promise<readonly string[] | undefined> {
  const diff = await runner(
    ['git', 'diff', '--no-renames', '--name-only', ...refs, '--', `${GUARD_TEMPLATE_DIR}/`],
    { cwd: root },
  );
  return diff.ok ? diff.output.split('\n').filter((line) => line.trim() !== '') : undefined;
}

/** The range as a reader names it: `31.4.0 → 31.4.1`, or `31.4.1 → [Unreleased]`. */
const rangeName = (change: GuardChange): string =>
  `${change.from} → ${change.to ?? '[Unreleased]'}`;

/** The finding for one range's unstated guards; its fix opens with the diff that lists them. */
export function guardRefreshFinding(gap: GuardRefreshGap): Finding {
  const { change, missing } = gap;
  const target = change.to ?? `the version after ${change.from}`;
  // Literal paths and one quoted tag per position: the fix-line rules read these statically.
  return {
    code: 'X_DOC_GUARD_REFRESH_UNSTATED',
    cause: `${GUARD_REFRESH_PAGE} names no \`x g guard\` refresh for ${missing.length} shipped guard template(s) that changed in ${rangeName(change)}: ${missing.join(', ')} — an app's guards/ copy is its own, so without the row it keeps the old rule`,
    fix:
      change.to === undefined
        ? `git diff --name-only ${quoteArg(`v${change.from}`)} -- packages/cli/src/templates/   # then a row in wiki/Upgrading.md naming each guard the cause lists, x g guard NAME --force and the version ${target}; rerun: bun run changelog-check --json`
        : `git diff --name-only ${quoteArg(`v${change.from}`)} ${quoteArg(`v${change.to}`)} -- packages/cli/src/templates/   # then a row in wiki/Upgrading.md naming each guard the cause lists, x g guard NAME --force and the version ${target}; rerun: bun run changelog-check --json`,
    at: GUARD_REFRESH_PAGE,
  };
}

export async function guardRefreshFindings(
  root: string,
  changelog: Changelog,
  page: string,
  options: GuardRefreshOptions = {},
): Promise<readonly Finding[]> {
  const runner = options.runner ?? boundedGit;
  const shipped = options.shipped ?? SHIPPED_GUARD_NAMES;
  const bounds = await releaseBounds(
    root,
    changelog,
    runner,
    options.probe ?? remoteTagProbe(root),
  );
  if ('finding' in bounds) return [bounds.finding];
  const importersOf = options.importers ?? treeImporters(root, shipped);
  const ranges: { readonly from: string; readonly to: string | undefined }[] = [
    ...(bounds.previous === undefined ? [] : [{ from: bounds.previous, to: bounds.latest }]),
    { from: bounds.latest, to: undefined },
  ];
  const changes: GuardChange[] = [];
  for (const range of ranges) {
    const refs = [`v${range.from}`, ...(range.to === undefined ? [] : [`v${range.to}`])];
    const paths = await changedPaths(root, refs, runner);
    if (paths === undefined) return [unreachable(refs.at(-1) ?? `v${range.from}`)];
    const helpers = new Map<string, readonly string[]>();
    for (const path of paths) {
      const stem = /guard-([a-z0-9-]+)\.ts$/.exec(path)?.[1];
      if (stem !== undefined && !shipped.includes(stem)) helpers.set(stem, await importersOf(stem));
    }
    const guards = changedGuards(paths, shipped, (stem) => helpers.get(stem) ?? []);
    if (guards.length > 0) changes.push({ ...range, guards });
  }
  return guardRefreshGaps(changes, page).map(guardRefreshFinding);
}
