// `scripts/release-due.ts` against real git repositories built per test: the last tag is the
// highest one HEAD contains, the window is what git says landed since it, and a tree with no tag
// is a coded refusal — never "nothing to release".

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { git as gitIn } from './lib/release-due-git';
import { REPO_SCAN_TIMEOUT_MS, repoRoot, run } from './lib/run';
import type { TagProbe } from './registry-audit';
import { decideAt, lastReleaseTag, parseWindowLog, readWindow, settleHoursOf } from './release-due';

// Each test spawns a dozen git processes; the CLI test boots the real tree.
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
  const dir = await mkdtemp(join(tmpdir(), 'release-due-'));
  madeDirs.push(dir);
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
  };
  await git(['init', '--quiet', '-b', 'main']);
  await land(
    {
      'packages/core/package.json': MANIFEST('1.0.0'),
      'packages/core/src/a.ts': 'export const a = 1;\n',
      'CHANGELOG.md': CHANGELOG,
    },
    'chore: release 1.0.0 (#1)',
  );
  if (options.tag) await git(['tag', '-a', 'v1.0.0', '-m', 'v1.0.0']);
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

describe('unit · release-due · read from a real repository', () => {
  test('no reachable vX.Y.Z tag is X_RELEASE_TAG_UNREACHABLE, not an empty window', async () => {
    const { dir } = await released({ tag: false });
    const read = await decideAt(dir, 24, NOW, probed());
    expect('code' in read && read.code).toBe('X_RELEASE_TAG_UNREACHABLE');
  });

  test('a docs-only and a root-only commit since the tag ship nothing', async () => {
    const { dir, land } = await released();
    await land({ 'docs/a.md': '# a\n' }, 'docs: a page');
    await land(
      { 'bun.lock': '{}\n', 'packages/core/README.md': '# core\n' },
      'chore(deps): bump x',
      72,
      'dependabot[bot] <bot@example.test>',
    );
    const read = await decideAt(dir, 24, NOW, probed('v1.0.0'));
    if (!('decision' in read)) return expect.unreachable(read.cause);
    expect(read.decision.reason).toBe('nothing_ships');
    expect(read.decision.inert).toBe(2);
  });

  test('a settled source change is a due patch; a fresh one is settling', async () => {
    const { dir, land } = await released();
    await land(
      { 'packages/core/src/a.ts': 'export const a = 2;\n' },
      'fix(core): a is two | really (#2)',
      30,
    );
    const settled = await decideAt(dir, 24, NOW, probed('v1.0.0'));
    if (!('decision' in settled)) return expect.unreachable(settled.cause);
    expect(settled.tagged).toBe('1.0.0');
    expect(settled.decision.due).toBe(true);
    expect(settled.decision.next).toBe('1.0.1');
    expect(settled.decision.shipping.map((c) => [c.subject, c.packages])).toEqual([
      ['fix(core): a is two | really (#2)', ['core']],
    ]);
    const fresh = await decideAt(dir, 48, NOW, probed('v1.0.0'));
    if (!('decision' in fresh)) return expect.unreachable(fresh.cause);
    expect(fresh.decision.reason).toBe('settling');
  });

  test('the last release is the highest tag HEAD contains, never one on another branch', async () => {
    const { dir, git, land } = await released();
    await git(['checkout', '--quiet', '-b', 'side']);
    await land({ 'packages/core/src/b.ts': 'export const b = 1;\n' }, 'feat: side');
    await git(['tag', '-a', 'v9.0.0', '-m', 'v9.0.0']);
    await git(['checkout', '--quiet', 'main']);
    expect(await lastReleaseTag(dir, probed('v1.0.0'))).toBe('1.0.0');
    await git(['tag', '-a', 'v1.0.0-rc.1', '-m', 'rc']);
    expect(await lastReleaseTag(dir, probed('v1.0.0'))).toBe('1.0.0');
  });

  test('a merged bump with no tag yet is awaiting_tag, not a second release', async () => {
    const { dir, land } = await released();
    await land({ 'packages/core/src/a.ts': 'export const a = 3;\n' }, 'fix(core): three');
    await land({ 'packages/core/package.json': MANIFEST('1.0.1') }, 'chore: release 1.0.1 (#3)');
    const read = await decideAt(dir, 24, NOW, probed('v1.0.0'));
    if (!('decision' in read)) return expect.unreachable(read.cause);
    expect(read.decision.reason).toBe('awaiting_tag');
  });
});

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

describe('unit · release-due · refusals that name their own cause', () => {
  // `readWindow` is only reached once `git tag --merged HEAD` has named a reachable tag, so a log that fails
  // there is not a tag miss: it is its own code with its own fix. A tag git cannot resolve stands in
  // for whatever makes the log fail.
  test('a git log that fails over a found tag is X_RELEASE_WINDOW_UNREADABLE, not a tag miss', async () => {
    const { dir } = await released();
    const read = await readWindow(dir, '9.9.9');
    expect('code' in read && read.code).toBe('X_RELEASE_WINDOW_UNREADABLE');
    expect('fix' in read && read.fix).not.toContain('--tags origin &&');
  });

  // No version is invented: a tree whose only workspace is private is refused, never read as 0.0.0.
  test('a tree with no publishable workspace is refused before a version is read', async () => {
    const { dir, land } = await released();
    await land(
      {
        'packages/core/package.json': JSON.stringify({
          name: '@ultimat3/core',
          version: '1.0.0',
          private: true,
        }),
      },
      'chore: make it private',
    );
    const read = await decideAt(dir, 24, NOW, probed('v1.0.0'));
    expect('code' in read && read.code).toBe('X_CORPUS_UNSCANNED');
  });
});

describe('unit · release-due · parsing and flags', () => {
  test('the window log splits on control characters, so a subject may hold anything', () => {
    const log = '\x1eabc\x1f100\x1fdependabot[bot]\x1fchore: a | b\n\npackages/core/package.json\n';
    expect(parseWindowLog(log)).toEqual([
      {
        sha: 'abc',
        committedAt: 100,
        author: 'dependabot[bot]',
        subject: 'chore: a | b',
        files: ['packages/core/package.json'],
      },
    ]);
    expect(parseWindowLog('')).toEqual([]);
  });

  test('--settle-hours takes a number of hours at or above zero, and nothing else', () => {
    expect(settleHoursOf(undefined)).toBe(24);
    expect(settleHoursOf('0')).toBe(0);
    expect(settleHoursOf('1.5')).toBe(1.5);
    for (const bad of ['-1', 'soon', '', 'Infinity']) {
      const refused = settleHoursOf(bad);
      expect({ bad, code: typeof refused === 'number' ? refused : refused.code }).toEqual({
        bad,
        code: 'X_CLI_BAD_FLAG',
      });
    }
  });

  test('--json on the real tree is one envelope a bot can branch on', async () => {
    const out = await run(['bun', 'run', 'scripts/release-due.ts', '--json'], {
      cwd: repoRoot(),
    });
    const parsed = JSON.parse(out.output) as {
      ok: boolean;
      script: string;
      data?: { due: boolean; lastTag: string; reason?: string };
      findings?: readonly { code: string }[];
    };
    expect(parsed.script).toBe('release-due');
    // CI checks out shallow and tagless; there the one legal answer is the coded refusal.
    if (!parsed.ok) {
      expect(parsed.findings?.map((f) => f.code)).toEqual(['X_RELEASE_TAG_UNREACHABLE']);
      return;
    }
    expect(typeof parsed.data?.due).toBe('boolean');
    expect(parsed.data?.lastTag).toMatch(/^v\d+\.\d+\.\d+$/);
    if (!parsed.data?.due) expect(parsed.data?.reason).toBeDefined();
  });
});
