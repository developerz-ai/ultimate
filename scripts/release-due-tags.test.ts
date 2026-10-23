// `lastReleaseTag`'s remote answer, against real git repositories built per test: a tag the remote
// cannot confirm is not a release, and a remote that could not answer is not a denial. Split from
// `release-due.test.ts`, which owns the release window itself, so the seam that asks `origin` is not
// also the file that reads the commits since the last tag. The probe is injected for the same
// reason the fixture's `origin` is a bare repo on disk: a test that reached the real remote would
// report its tags, not this checkout's.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { git as gitIn } from './lib/release-due-git';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';
import type { TagProbe } from './registry-audit';
import { decideAt, lastReleaseTag } from './release-due';

// Each test spawns a dozen git processes.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const madeDirs: string[] = [];
afterAll(async () => {
  for (const dir of madeDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 14, 12);

const MANIFEST = (version: string): string =>
  `${JSON.stringify({ name: '@ultimat3/core', version, files: ['src', '!src/**/*.test.ts'] }, null, 2)}\n`;
const CHANGELOG =
  '# Changelog\n\n## [Unreleased]\n\nNothing yet.\n\n## 1.0.0 - 2026-10-01\n\n- first\n';

/** A repository with one publishable package, released and tagged at 1.0.0 — or untagged. */
async function released(options: { readonly tag: boolean } = { tag: true }) {
  const dir = await mkdtemp(join(tmpdir(), 'release-due-tags-'));
  madeDirs.push(dir);
  // A bare upstream reachable as `origin`, so `baseRef()` resolves and `decideAt` can read
  // both HEAD and the base SHA from the same fixture. Tracks in `madeDirs` for cleanup.
  const upstream = await mkdtemp(join(tmpdir(), 'release-due-tags-upstream-'));
  madeDirs.push(upstream);
  // Through the one bounded, non-interactive git the script uses: no call here can outlive
  // GIT_TIMEOUT_MS or wait on stdin, whatever git or the machine is doing.
  const git = async (argv: readonly string[], hoursAgo = 72): Promise<string> => {
    const date = new Date(NOW - hoursAgo * HOUR).toISOString();
    const out = await gitIn(
      [
        '-c',
        'user.email=t@example.test',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'tag.gpgsign=false',
        ...argv,
      ],
      dir,
      {
        GIT_AUTHOR_NAME: 't',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_DATE: date,
        GIT_AUTHOR_DATE: date,
      },
    );
    expect({ argv, ok: out.ok, output: out.output }).toEqual({
      argv,
      ok: true,
      output: expect.any(String),
    });
    return out.output;
  };
  const land = async (
    files: Readonly<Record<string, string>>,
    subject: string,
    hoursAgo = 72,
    author?: string,
  ): Promise<void> => {
    for (const [path, body] of Object.entries(files)) await Bun.write(join(dir, path), body);
    await git(['add', '-A'], hoursAgo);
    await git(
      ['commit', '--quiet', '-m', subject, ...(author === undefined ? [] : ['--author', author])],
      hoursAgo,
    );
    // Keep origin/main in lockstep with local main so the head-vs-base check passes for
    // on-main fixtures. A non-main branch — the side-branch test — suppresses the auto-push.
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (branch === 'main') {
      await git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
    }
  };
  // A bare upstream reachable as `origin`, so `baseRef()` returns `BASE_REF` for every fixture.
  // Init the upstream and the local repo independently: `git remote add` requires a
  // `.git` directory in cwd, so the local init comes first.
  await git(['init', '--quiet', '--bare', upstream]);
  await git(['init', '--quiet', '-b', 'main']);
  await git(['remote', 'add', 'origin', upstream]);
  await land(
    {
      'packages/core/package.json': MANIFEST('1.0.0'),
      'packages/core/src/a.ts': 'export const a = 1;\n',
      'CHANGELOG.md': CHANGELOG,
    },
    'chore: release 1.0.0 (#1)',
  );
  if (options.tag) await git(['tag', '-a', 'v1.0.0', '-m', 'v1.0.0']);
  // `land()` already pushed the initial commit (auto-push on main); push the tag too.
  if (options.tag) await git(['push', '--quiet', 'origin', 'v1.0.0']);
  return { dir, git, land };
}

/**
 * The default remote each fixture stands in for. Every repository built above has an `origin` only
 * because this probe says so — a fixture that reached the real remote would report the remote's
 * tags, not this one's.
 */
const probed =
  (...tags: readonly string[]): TagProbe =>
  async (tag) =>
    tags.includes(tag);

/**
 * A probe that records every tag it is asked about, in the caller's own array — spread arguments
 * would copy it empty at call time, and the recorded order IS the assertion: candidates are walked
 * highest first, so a rejected one must be seen before the one below it.
 */
const recording =
  (asked: string[], answer: (tag: string) => boolean | undefined): TagProbe =>
  async (tag) => {
    asked.push(tag);
    return answer(tag);
  };

describe('unit · release-due · the remote has the last word on a tag', () => {
  test('origin holding it: the highest confirmed candidate is the last release', async () => {
    const { dir, git, land } = await released();
    await git(['tag', '-a', 'v0.9.0', '-m', 'v0.9.0']);
    await land({ 'packages/core/src/c.ts': 'export const c = 1;\n' }, 'fix(core): c');
    const asked: string[] = [];
    // Only v0.9.0 is confirmed, so the scan walks PAST v1.0.0 rather than accepting the local tag.
    const tag = await lastReleaseTag(
      dir,
      recording(asked, (t) => t === 'v0.9.0'),
    );
    expect(tag).toBe('0.9.0');
    expect(asked).toEqual(['v1.0.0', 'v0.9.0']);
  });

  test('origin rejecting it: a local-only tag is not a release, so the scan falls through', async () => {
    const { dir } = await released();
    const asked: string[] = [];
    // v1.0.0 exists locally and is denied on origin, and nothing else is reachable: the window has
    // no honest base, which is the coded refusal — never a window counted from a tag nobody can see.
    const tag = await lastReleaseTag(
      dir,
      recording(asked, () => false),
    );
    expect(tag).toBeUndefined();
    expect(asked).toEqual(['v1.0.0']);
    const read = await decideAt(dir, 24, NOW, probed());
    expect('code' in read && read.code).toBe('X_RELEASE_TAG_UNREACHABLE');
  });

  test('git unable to answer: the unreachable path is unchanged, not a false denial', async () => {
    const { dir } = await released();
    const asked: string[] = [];
    // git declining to answer is NOT a denial and NOT a pass-over: `lastReleaseTag` refuses, so a
    // window is never counted from a tag whose remote state is unknown.
    const tag = await lastReleaseTag(
      dir,
      recording(asked, () => undefined),
    );
    expect(typeof tag === 'object' && tag.code).toBe('X_RELEASE_TAG_UNREACHABLE');
    expect(asked).toEqual(['v1.0.0']);
    // The same no-answer through `decideAt`, driven by an undefined-returning probe: with `probed()`
    // here this assertion would hold for a plain denial and prove nothing about the no-answer path.
    const read = await decideAt(dir, 24, NOW, async () => undefined);
    expect('code' in read && read.code).toBe('X_RELEASE_TAG_UNREACHABLE');
  });

  test('a no-answer on the higher tag refuses, never falls through to the older one', async () => {
    const { dir, git } = await released();
    await git(['tag', '-a', 'v0.9.0', '-m', 'v0.9.0']);
    await git(['tag', '-a', 'v2.0.0', '-m', 'v2.0.0']);
    const asked: string[] = [];
    // Candidates highest first: v2.0.0 is denied, v1.0.0 cannot be asked about, v0.9.0 is on origin.
    // Returning v0.9.0 would count the window from a release older than the one in doubt — reporting
    // a shipped release's commits as unshipped — so the no-answer stops the scan and refuses.
    const tag = await lastReleaseTag(
      dir,
      recording(asked, (t) => (t === 'v0.9.0' ? true : t === 'v1.0.0' ? undefined : false)),
    );
    expect(typeof tag === 'object' && tag.code).toBe('X_RELEASE_TAG_UNREACHABLE');
    // v0.9.0 is never reached: the no-answer on the higher candidate ends the question.
    expect(asked).toEqual(['v2.0.0', 'v1.0.0']);
  });
});
