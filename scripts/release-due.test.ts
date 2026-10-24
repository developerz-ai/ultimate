// `scripts/release-due.ts` against real git repositories built per test: the last tag is the
// highest one HEAD contains that the stubbed remote also holds, the window is what git says
// landed since it, and a tree with no tag is a coded refusal — never "nothing to release". The
// three seams a test injects are `probe` (whether origin holds a candidate tag), `listPrTitles`
// (the bump-PR twin lookup) and `listIssueTitles` (the open-issue twin lookup), in that order —
// a real answer from any of them is a remote read or a network call this suite never makes, so
// EVERY `decideAt` call in this file injects all three — the guard below pins that.
// `listIssueTitles` is SUBJECT-AWARE: the `ask` on a `due` decision, the `pending_major` on a
// `major_needs_a_maintainer` one. Both live beside this file, not here: `release-due-ask.test.ts`
// owns the ask's twin and `release-due-major.test.ts` the pending-major issue's.
//
// This file owns the WINDOW: what ships, whether it has settled, what the bump is, and the
// refusals that name their own cause. The three subjects a decision reads live beside it —
// `release-due-pr.test.ts` the bump PR, `release-due-ask.test.ts` the ask, `release-due-major.test.ts`
// the pending-major issue — and the script's own reading surfaces live in
// `release-due-flags.test.ts`, which owns the parser, the flag reader and the JSON envelope.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { FETCH_MAIN } from './lib/base-ref';
import { git as gitIn } from './lib/release-due-git';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';
import type { TagProbe } from './registry-audit';
import { decideAt, lastReleaseTag, readWindow } from './release-due';

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
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed(),
      async () => [],
      async () => [],
    );
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
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => [],
      async () => [],
    );
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
    const settled = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => [],
      async () => [],
    );
    if (!('decision' in settled)) return expect.unreachable(settled.cause);
    expect(settled.tagged).toBe('1.0.0');
    expect(settled.decision.due).toBe(true);
    expect(settled.decision.next).toBe('1.0.1');
    expect(settled.decision.shipping.map((c) => [c.subject, c.packages])).toEqual([
      ['fix(core): a is two | really (#2)', ['core']],
    ]);
    const fresh = await decideAt(
      dir,
      48,
      NOW,
      probed('v1.0.0'),
      async () => [],
      async () => [],
    );
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
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => [],
      async () => [],
    );
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
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => [],
      async () => [],
    );
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
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => [],
      async () => [],
    );
    if (!('decision' in read)) return expect.unreachable(read.cause);
    expect(read.decision.reason).toBe('awaiting_tag');
  });

  // The concrete anchor a `data.headSha` consumer compares against: HEAD's SHA at the moment
  // `decideAt` ran the head-vs-base check. On main, `releaseDue` is handed the same SHA and
  // the rule's only job is to carry it through.
  test('on-main HEAD propagates into read.decision.headSha', async () => {
    const { dir, git } = await released();
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => [],
      async () => [],
    );
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
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => [],
      async () => [],
    );
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
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => [],
      async () => [],
    );
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
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => [],
      async () => [],
    );
    expect('code' in read && read.code).toBe('X_CORPUS_UNSCANNED');
  });
});

describe('unit · release-due · this file never reaches the GitHub CLI', () => {
  const GUARD_MARKER = "describe('unit · release-due · this file never reaches the GitHub CLI'";
  // The guard behind the header's claim. A `decideAt` call that injects no `listIssueTitles`
  // seam falls through to the REAL one — the ask lookup — which spawns the `gh` binary on every
  // due decision. It failed SILENTLY: an unanswered lookup only costs the twin note, so the
  // tests stayed green while the binary was being spawned. So the property is pinned here.
  test('every decideAt call in this file injects both lookup seams', async () => {
    const source = await Bun.file(join(import.meta.dir, 'release-due.test.ts')).text();
    // Only the source ABOVE this guard: the guard's own text holds the word it looks for.
    const calls = decideAtCalls(source.slice(0, source.indexOf(GUARD_MARKER)));
    expect(calls.length).toBeGreaterThan(0);
    const bare = calls.filter((call) => (call.match(/async/g) ?? []).length < 2);
    const message = 'a decideAt call without an injected lookup seam spawns the gh binary';
    expect(bare, message).toEqual([]);
  });
});

/**
 * Every `decideAt(` call expression in `source`, as the text of the call: a source scan and not a
 * runtime hook, because only the text of this file says whether a call reaches the binary.
 */
function decideAtCalls(source: string): readonly string[] {
  const OPEN = 'decideAt(';
  const found: string[] = [];
  for (let at = source.indexOf(OPEN); at !== -1; ) {
    let depth = 0;
    let end = at;
    for (; end < source.length; end++) {
      // A paren inside a string does not balance, so the strings are read around.
      if (source[end] === "'" || source[end] === '"') {
        const quote = source[end];
        for (end++; source[end] !== quote; end++) if (source[end] === '\\') end++;
      } else if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    found.push(source.slice(at, end + 1));
    at = source.indexOf(OPEN, end);
  }
  return found;
}
