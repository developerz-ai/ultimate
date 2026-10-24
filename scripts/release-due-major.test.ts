// The pending-major issue twin, against real git repositories built per test: a breaking
// change in the window makes the decision a major, and the major path reads the open
// pending-major issue's twin through a GitHub CLI lookup the test injects, because a real
// answer from the CLI is a network call this suite never makes. Split from
// `release-due.test.ts`, which owns the release window itself, so the seam that asks the CLI
// for the pending-major issue is not also the file that reads the commits since the last tag.
// The fixture is duplicated rather than shared, the way `release-due-tags.test.ts` does it: a
// shared module would be a second thing to keep in step with the window it stands in for.
//
// The open-issue seam is SUBJECT-AWARE: it is asked for the `ask` on a `due` decision and for
// the `pending_major` on a `major_needs_a_maintainer` one. So a test that records what it was
// asked for records the SUBJECT, and the two subjects never mix — the same disjointness
// `release-subject.test.ts` claims over the matchers, claimed here over the lookup itself.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { git as gitIn } from './lib/release-due-git';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';
import type { TagProbe } from './registry-audit';
import { decideAt, type IssueSubject, openIssueTitlesAt } from './release-due';

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
  const dir = await mkdtemp(join(tmpdir(), 'release-due-major-'));
  madeDirs.push(dir);
  // A bare upstream reachable as `origin`, so `baseRef()` resolves and `decideAt` can read
  // both HEAD and the base SHA from the same fixture. Tracks in `madeDirs` for cleanup.
  const upstream = await mkdtemp(join(tmpdir(), 'release-due-major-upstream-'));
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

describe('unit · release-due · the pending-major issue twin', () => {
  // A breaking change in the window: the decision is a major, and the major path reads the
  // pending-major issue's twin.
  const BREAKING = '### Changed\n\n- **BREAKING — a thing goes.** detail';

  test('a major decision names the pending-major issue already open', async () => {
    const { dir, land } = await released();
    // A source change too: a changelog-only commit ships nothing, and the window would be
    // `nothing_ships` before the bump was ever computed.
    await land(
      {
        'packages/core/src/a.ts': 'export const a = 2;\n',
        'CHANGELOG.md': CHANGELOG.replace('Nothing yet.', BREAKING),
      },
      'fix(core): two',
    );
    const asked: IssueSubject[] = [];
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => [],
      async (subject) => {
        asked.push(subject);
        return ['Major release pending: 2.0.0'];
      },
    );
    if (!('decision' in read)) return expect.unreachable(read.cause);
    expect(read.decision.reason).toBe('major_needs_a_maintainer');
    expect(read.decision.next).toBe('2.0.0');
    expect(read.decision.detail).toContain(
      '; a pending-major issue already open: Major release pending: 2.0.0',
    );
    // The major path asks for the pending-major issue and for nothing else.
    expect(asked).toEqual(['pending_major']);
  });

  test('with no such issue open the decision names the one issue to file', async () => {
    const { dir, land } = await released();
    await land(
      {
        'packages/core/src/a.ts': 'export const a = 2;\n',
        'CHANGELOG.md': CHANGELOG.replace('Nothing yet.', BREAKING),
      },
      'fix(core): two',
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
    expect(read.decision.reason).toBe('major_needs_a_maintainer');
    expect(read.decision.detail).toContain(
      '; file one issue titled `Major release pending: 2.0.0`',
    );
    expect(read.decision.detail).not.toContain('already open');
  });

  test('a decision that is not a major never asks the CLI for the pending-major issue', async () => {
    const { dir, land } = await released();
    await land({ 'packages/core/src/a.ts': 'export const a = 6;\n' }, 'fix(core): six', 30);
    const asked: IssueSubject[] = [];
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => [],
      async (subject) => {
        asked.push(subject);
        return [];
      },
    );
    if (!('decision' in read)) return expect.unreachable(read.cause);
    expect(read.decision.due).toBe(true);
    expect(read.decision.reason).toBeUndefined();
    // A due decision asks for the ASK's twin and for nothing else: the pending-major issue is
    // a different subject, with its own query, and it is never asked for on this path.
    expect(asked).not.toContain('pending_major');
    expect(asked).toEqual(['ask']);
  });

  // Absent binary, no auth and a failed call all land here, and all three must read as the
  // lookup COULD NOT ANSWER — `undefined`, not an empty list. An empty list says "none open",
  // which is a fact the rule files on; an unanswered lookup says nothing, and the rule must
  // not file on that.
  test('a lookup that cannot answer is no answer at all, never an empty list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'release-due-issue-'));
    madeDirs.push(dir);
    expect(await openIssueTitlesAt(dir, '2.0.0')).toBeUndefined();
  });

  // The whole point of that distinction: on a major window an unanswerable lookup must not
  // become a DUPLICATE maintainer issue. The decision names no issue to file and claims no
  // twin — it says the lookup could not answer, so the releaser finishes the check by hand.
  test('a major decision whose lookup could not answer files nothing and claims no twin', async () => {
    const { dir, land } = await released();
    await land(
      {
        'packages/core/src/a.ts': 'export const a = 2;\n',
        'CHANGELOG.md': CHANGELOG.replace('Nothing yet.', BREAKING),
      },
      'fix(core): two',
    );
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => [],
      async () => undefined,
    );
    if (!('decision' in read)) return expect.unreachable(read.cause);
    expect(read.decision.reason).toBe('major_needs_a_maintainer');
    expect(read.decision.next).toBe('2.0.0');
    expect(read.decision.detail).not.toContain('file one issue');
    expect(read.decision.detail).not.toContain('already open');
    expect(read.decision.detail).toContain('could not answer');
  });
});
