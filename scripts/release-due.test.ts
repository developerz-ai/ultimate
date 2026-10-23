// `scripts/release-due.ts` against real git repositories built per test: the last tag is the
// highest one HEAD contains that the stubbed remote also holds, the window is what git says
// landed since it, and a tree with no tag is a coded refusal — never "nothing to release". The
// three seams a test injects are `probe` (whether origin holds a candidate tag), `listPrTitles`
// (the bump-PR twin lookup) and `listIssueTitles` (the pending-major issue's twin lookup), in
// that order — a real answer from any of them is a remote read or a network call this suite
// never makes. The pending-major issue twin lives in `release-due-major.test.ts`: this file
// reads the window, that one reads the major's open-issue seam.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { FETCH_MAIN } from './lib/base-ref';
import { git as gitIn } from './lib/release-due-git';
import { REPO_SCAN_TIMEOUT_MS, repoRoot, run } from './lib/run';
import type { TagProbe } from './registry-audit';
import {
  decideAt,
  lastReleaseTag,
  openPrTitlesAt,
  parseWindowLog,
  readWindow,
  settleHoursOf,
} from './release-due';

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
/**
 * A manifest whose DEPENDENCY moved, at the same own version: what a `chore(deps):` commit lands.
 * Moving the version instead would read as a merged release awaiting its tag, and the window would
 * never reach the bump the notes branch hangs off.
 */
const DEP_BUMP = (version: string): string =>
  `${JSON.stringify({ name: '@ultimat3/core', version, dep: '1.1.0', files: ['src', '!src/**/*.test.ts'] }, null, 2)}\n`;
const CHANGELOG =
  '# Changelog\n\n## [Unreleased]\n\nNothing yet.\n\n## 1.0.0 - 2026-10-01\n\n- first\n';

/** A repository with one publishable package, released and tagged at 1.0.0 — or untagged. */
async function released(options: { readonly tag: boolean } = { tag: true }) {
  const dir = await mkdtemp(join(tmpdir(), 'release-due-'));
  madeDirs.push(dir);
  // A bare upstream reachable as `origin`, so `baseRef()` resolves and `decideAt` can read
  // both HEAD and the base SHA from the same fixture. Tracks in `madeDirs` for cleanup.
  const upstream = await mkdtemp(join(tmpdir(), 'release-due-upstream-'));
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

  // A Dependabot PR that touches versions arrives without a usable `bun.lock` (PUBLISHING.md), so a
  // regenerated lockfile rides along in the same squash. git records ONE author per commit, so the
  // landed commit is still `dependabot[bot]` and the window stays Dependabot-only: `### Changed`
  // must still be owed, or the release notes would name the lockfile commit and the dependency
  // bump not at all.
  test('a squashed Dependabot bump that also carries a regenerated bun.lock still owes ### Changed', async () => {
    const { dir, land } = await released();
    await land(
      {
        'bun.lock': '{}\n',
        'packages/core/package.json': DEP_BUMP('1.0.0'),
      },
      'chore(deps): bump x (#4)',
      72,
      'dependabot[bot] <bot@example.test>',
    );
    const read = await decideAt(dir, 24, NOW, probed('v1.0.0'));
    if (!('decision' in read)) return expect.unreachable(read.cause);
    expect(read.decision.bump).toBe('patch');
    expect(read.decision.notes.join('\n')).toContain('### Changed');
    expect(read.decision.notes.join('\n')).toContain('Dependabot-only');
  });

  // The same PR as two commits on main — the Dependabot bump, then a maintainer's lockfile
  // regeneration. A `bun.lock`-only commit changes no path a published tarball packs, so it is
  // inert and the shipping list is still Dependabot-only. If the lockfile ever began to ship, this
  // would become a human window — which is why the assertion pins the shipping set too.
  test('a Dependabot bump with a separate non-Dependabot bun.lock commit still owes ### Changed', async () => {
    const { dir, land } = await released();
    await land(
      { 'packages/core/package.json': DEP_BUMP('1.0.0') },
      'chore(deps): bump x (#4)',
      72,
      'dependabot[bot] <bot@example.test>',
    );
    await land({ 'bun.lock': '{}\n' }, 'chore: regenerate bun.lock after the bump');
    const read = await decideAt(dir, 24, NOW, probed('v1.0.0'));
    if (!('decision' in read)) return expect.unreachable(read.cause);
    // The lockfile commit ships nothing, so it is inert rather than a human shipping commit.
    expect(read.decision.shipping.map((c) => c.author)).toEqual(['dependabot[bot]']);
    expect(read.decision.inert).toBe(1);
    expect(read.decision.bump).toBe('patch');
    expect(read.decision.notes.join('\n')).toContain('### Changed');
    expect(read.decision.notes.join('\n')).toContain('Dependabot-only');
  });

  test('a merged bump with no tag yet is awaiting_tag, not a second release', async () => {
    const { dir, land } = await released();
    await land({ 'packages/core/src/a.ts': 'export const a = 3;\n' }, 'fix(core): three');
    await land({ 'packages/core/package.json': MANIFEST('1.0.1') }, 'chore: release 1.0.1 (#3)');
    const read = await decideAt(dir, 24, NOW, probed('v1.0.0'));
    if (!('decision' in read)) return expect.unreachable(read.cause);
    expect(read.decision.reason).toBe('awaiting_tag');
  });

  // The concrete anchor a `data.headSha` consumer compares against: HEAD's SHA at the moment
  // `decideAt` ran the head-vs-base check. On main, `releaseDue` is handed the same SHA and
  // the rule's only job is to carry it through.
  test('on-main HEAD propagates into read.decision.headSha', async () => {
    const { dir, git } = await released();
    const read = await decideAt(dir, 24, NOW, probed('v1.0.0'));
    if (!('decision' in read)) return expect.unreachable(read.cause);
    expect(read.decision.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(read.decision.headSha).toBe((await git(['rev-parse', 'HEAD'])).trim());
  });

  // A side-branch head is HEAD at the tip of `origin/main` neither — naming both SHAs and the
  // branch in the cause is the contract the `data.headSha` consumer relies on to compare the
  // answer against the SHA of the latest green `ci.yml` run on `main`.
  test('a side-branch HEAD refuses with X_RELEASE_HEAD_NOT_MAIN naming both SHAs', async () => {
    const { dir, git, land } = await released();
    await git(['checkout', '--quiet', '-b', 'side']);
    await land({ 'packages/core/src/b.ts': 'export const b = 1;\n' }, 'feat: side');
    const headSha = (await git(['rev-parse', 'HEAD'])).trim();
    const baseSha = (await git(['rev-parse', 'origin/main'])).trim();
    expect(headSha).not.toBe(baseSha);
    const read = await decideAt(dir, 24, NOW, probed('v1.0.0'));
    expect('code' in read).toBe(true);
    if (!('code' in read)) return;
    expect(read.code).toBe('X_RELEASE_HEAD_NOT_MAIN');
    expect(read.cause).toContain(headSha);
    expect(read.cause).toContain(baseSha);
    expect(read.cause).toContain('side');
  });

  // The `fetch` kind of `headNotMain`: `baseRef()` could not establish `origin/main` because
  // the local tracking ref was deleted AND the fetch returned non-zero, so the script cannot
  // tell what HEAD is anchored to. The same X_RELEASE_HEAD_NOT_MAIN code as the side-branch
  // test above keeps one consumer branch enough across both unreachable-origin and side-branch;
  // the cause and the fix both name FETCH_MAIN, the literal command that fixes both cases.
  test('an unreachable origin refuses with X_RELEASE_HEAD_NOT_MAIN whose cause and fix name the fetch', async () => {
    const { dir, git } = await released();
    // Drop the local tracking ref so `baseRef()` actually attempts FETCH_MAIN; after the
    // auto-push in `land()`, refs/remotes/origin/main points at HEAD and `baseRef()` would
    // short-circuit past the fetch if the local ref still existed.
    await git(['update-ref', '-d', 'refs/remotes/origin/main']);
    // Repoint `origin` at a missing local path so FETCH_MAIN fails at the resolver the same
    // way a dead network would, without waiting on a network timeout.
    await git(['remote', 'set-url', 'origin', '/nonexistent/release-due-fetch']);
    const read = await decideAt(dir, 24, NOW, probed('v1.0.0'));
    expect('code' in read).toBe(true);
    if (!('code' in read)) return;
    expect(read.code).toBe('X_RELEASE_HEAD_NOT_MAIN');
    expect(read.cause).toContain(FETCH_MAIN);
    expect(read.fix).toContain(FETCH_MAIN);
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

/** Every refusal `decideAt` can hand back on a real checkout: a tagless shallow clone, a
 * window the log could not read, or HEAD not at the base ref's tip. One list, so a refusal
 * code added to `release-due.ts` cannot slip past the closed set this suite pins. */
const REFUSAL_CODES = [
  'X_RELEASE_TAG_UNREACHABLE',
  'X_RELEASE_WINDOW_UNREADABLE',
  'X_RELEASE_HEAD_NOT_MAIN',
] as const;
type RefusalCode = (typeof REFUSAL_CODES)[number];

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
      data?: { due: boolean; lastTag: string; reason?: string; headSha?: string };
      findings?: readonly { code: RefusalCode }[];
    };
    expect(parsed.script).toBe('release-due');
    // A refusal carries no `data`: every signal a bot branches on is in `findings`. The codes
    // are a closed set — a tagless shallow checkout (TAG_UNREACHABLE), a hung git log
    // (WINDOW_UNREADABLE), or HEAD not at origin/main's tip (HEAD_NOT_MAIN) — so a real-tree
    // run on a side branch keeps the suite green instead of mismatching the prior exact match.
    if (!parsed.ok) {
      expect(parsed.data).toBeUndefined();
      for (const finding of parsed.findings ?? []) {
        expect(REFUSAL_CODES).toContain(finding.code);
      }
      return;
    }
    expect(typeof parsed.data?.due).toBe('boolean');
    expect(parsed.data?.lastTag).toMatch(/^v\d+\.\d+\.\d+$/);
    // The concrete anchor for the consumer: HEAD's SHA at the moment decideAt ran.
    expect(parsed.data?.headSha).toMatch(/^[0-9a-f]{40}$/);
    if (!parsed.data?.due) expect(parsed.data?.reason).toBeDefined();
  });
});

describe('unit · release-due · the bump-PR twin', () => {
  test('a due decision names the open bump PR — the release already in flight', async () => {
    const { dir, land } = await released();
    await land({ 'packages/core/src/a.ts': 'export const a = 4;\n' }, 'fix(core): four (#4)', 30);
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => ['chore: release 1.0.1 (#3)'],
      async () => [],
    );
    if (!('decision' in read)) return expect.unreachable(read.cause);
    expect(read.decision.due).toBe(true);
    expect(read.decision.next).toBe('1.0.1');
    expect(read.decision.detail).toContain('; a bump PR already open: chore: release 1.0.1 (#3)');
  });

  test('an ask title is not a bump PR: the two readers stay disjoint at this seam too', async () => {
    const { dir, land } = await released();
    await land({ 'packages/core/src/a.ts': 'export const a = 5;\n' }, 'fix(core): five (#5)', 30);
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => ['Release 1.0.1'],
      async () => [],
    );
    if (!('decision' in read)) return expect.unreachable(read.cause);
    expect(read.decision.due).toBe(true);
    expect(read.decision.detail).not.toContain('bump PR');
  });

  test('a decision that reads no twin never asks the CLI for one', async () => {
    const { dir, land } = await released();
    await land({ 'docs/a.md': '# a\n' }, 'docs: a page');
    const asked: string[] = [];
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async (version) => {
        asked.push(version);
        return [];
      },
      async () => [],
    );
    if (!('decision' in read)) return expect.unreachable(read.cause);
    expect(read.decision.reason).toBe('nothing_ships');
    expect(asked).toEqual([]);
  });

  // Absent binary, no auth and a failed call all land here, and all three must read as NO KNOWN
  // PRs: the twin note is absent and the decision stands, never an invented "none open".
  test('a lookup that cannot answer is no known PRs, never a twin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'release-due-pr-'));
    madeDirs.push(dir);
    expect(await openPrTitlesAt(dir, '1.0.1')).toEqual([]);
  });
});
