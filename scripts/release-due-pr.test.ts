// The bump-PR twin, against real git repositories built per test: a due decision names the open
// release bump PR it would duplicate, through the GitHub CLI lookup the test injects, because a
// real answer from the CLI is a network call this suite never makes. This is the THIRD subject a
// release-due decision reads — the ask (`release-due-ask.test.ts`) and the pending-major issue
// (`release-due-major.test.ts`) are the other two — so it lives beside them rather than in
// `release-due.test.ts`, which owns the release window itself and is at its filesize ceiling.
// The fixture is duplicated rather than shared, the way `release-due-major.test.ts` does it: a
// shared module would be a second thing to keep in step with the window it stands in for.
//
// The three seams a test injects are `probe` (whether origin holds a candidate tag), `listPrTitles`
// (this file's subject) and `listIssueTitles` (the open-issue twin lookup) — a real answer from
// any of them is a remote read or a network call this suite never makes, so EVERY `decideAt` call
// in this file injects all three. The guard at the bottom of this file pins that.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { git as gitIn } from './lib/release-due-git';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';
import type { TagProbe } from './registry-audit';
import { decideAt, openPrTitlesAt } from './release-due';

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

/** A repository with one publishable package, released and tagged at 1.0.0. */
async function released() {
  const dir = await mkdtemp(join(tmpdir(), 'release-due-pr-'));
  madeDirs.push(dir);
  // A bare upstream reachable as `origin`, so `baseRef()` resolves and `decideAt` can read
  // both HEAD and the base SHA from the same fixture. Tracks in `madeDirs` for cleanup.
  const upstream = await mkdtemp(join(tmpdir(), 'release-due-pr-upstream-'));
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
  ): Promise<void> => {
    for (const [path, body] of Object.entries(files)) await Bun.write(join(dir, path), body);
    await git(['add', '-A'], hoursAgo);
    await git(['commit', '--quiet', '-m', subject], hoursAgo);
    // Keep origin/main in lockstep with local main so the head-vs-base check passes for
    // on-main fixtures.
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
  await git(['tag', '-a', 'v1.0.0', '-m', 'v1.0.0']);
  // `land()` already pushed the initial commit (auto-push on main); push the tag too.
  await git(['push', '--quiet', 'origin', 'v1.0.0']);
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

  // The ask and the bump PR are DIFFERENT subjects: the ask's title never reads as a bump PR, so
  // an open ask never suppresses the bump-PR note and never appears as one.
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
    const dir = await mkdtemp(join(tmpdir(), 'release-due-pr-lookup-'));
    madeDirs.push(dir);
    expect(await openPrTitlesAt(dir, '1.0.1')).toEqual([]);
  });
});

describe('unit · release-due · this file never reaches the GitHub CLI', () => {
  const GUARD_MARKER = "describe('unit · release-due · this file never reaches the GitHub CLI'";
  // The guard behind the header's claim. A `decideAt` call that injects no `listIssueTitles`
  // seam falls through to the REAL one — the ask lookup — which spawns the `gh` binary on every
  // due decision. It failed SILENTLY: an unanswered lookup only costs the twin note, so the
  // tests stayed green while the binary was being spawned. So the property is pinned here.
  test('every decideAt call in this file injects both lookup seams', async () => {
    const source = await Bun.file(join(import.meta.dir, 'release-due-pr.test.ts')).text();
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
