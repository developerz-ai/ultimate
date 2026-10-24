// The ask twin, against real git repositories built per test: a due decision names the open
// release ask it would duplicate, through the GitHub CLI lookup the test injects, because a real
// answer from the CLI is a network call this suite never makes. This is the PRODUCTION wiring —
// `decideAt`, the seam and the rule — not the rule's own fixtures: the defect this file pins is
// that the ask's twin was never read in production at all, so only a rule-level fixture could
// reach the note. Split from `release-due.test.ts`, which owns the release window itself and is
// at its filesize ceiling, and from `release-due-major.test.ts`, which owns the other subject.
// The fixture is duplicated rather than shared, the way `release-due-major.test.ts` does it: a
// shared module would be a second thing to keep in step with the window it stands in for.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { git as gitIn } from './lib/release-due-git';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';
import type { TagProbe } from './registry-audit';
import { decideAt, type IssueSubject, openAskTitlesAt } from './release-due';

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
const CHANGELOG = `# Changelog

## [Unreleased]

Nothing yet.

## 1.0.0 - 2026-10-01

- first
`;

/** A repository with one publishable package, released and tagged at 1.0.0. */
async function released() {
  const dir = await mkdtemp(join(tmpdir(), 'release-due-ask-'));
  madeDirs.push(dir);
  // A bare upstream reachable as `origin`, so `baseRef()` resolves and `decideAt` can read
  // both HEAD and the base SHA from the same fixture. Tracks in `madeDirs` for cleanup.
  const upstream = await mkdtemp(join(tmpdir(), 'release-due-ask-upstream-'));
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
  // Init the upstream and the local repo independently: the remote command requires a
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

describe('unit · release-due · the ask twin', () => {
  // The window a due decision sees: one settled source change, so the bump is a patch to 1.0.1
  // and the ask the brief would file is titled `Release 1.0.1`.
  const due = async () => {
    const fixture = await released();
    await fixture.land(
      { 'packages/core/src/a.ts': 'export const a = 2;\n' },
      'fix(core): two (#2)',
      30,
    );
    return fixture;
  };

  // The defect this file pins: the ask's twin was read only from rule fixtures, never in
  // production, so the note below was unreachable outside a test.
  test('a due decision names the open ask already filed', async () => {
    const { dir } = await due();
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => [],
      async () => ['Release 1.0.1'],
    );
    if (!('decision' in read)) return expect.unreachable(read.cause);
    expect(read.decision.due).toBe(true);
    expect(read.decision.next).toBe('1.0.1');
    expect(read.decision.detail).toContain('; an ask already open: Release 1.0.1');
  });

  test('with no ask open the decision carries no ask note', async () => {
    const { dir } = await due();
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => [],
      async () => [],
    );
    if (!('decision' in read)) return expect.unreachable(read.cause);
    expect(read.decision.due).toBe(true);
    expect(read.decision.detail).not.toContain('already open');
  });

  // Another version's ask is not this version's ask: the note names only the twin.
  test("another version's ask is not an ask twin", async () => {
    const { dir } = await due();
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => [],
      async () => ['Release 9.9.9'],
    );
    if (!('decision' in read)) return expect.unreachable(read.cause);
    expect(read.decision.due).toBe(true);
    expect(read.decision.detail).not.toContain('already open');
  });

  // The lookup is made for the ASK on this path and for nothing else: the pending-major issue
  // is a different subject, with its own query.
  test('a due decision asks the CLI for the ask and for nothing else', async () => {
    const { dir } = await due();
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
    expect(asked).toEqual(['ask']);
    expect(asked).not.toContain('pending_major');
  });

  // A decision that reads no twin never asks the CLI for one: a window that ships nothing is
  // not a due decision, so there is no ask to look for.
  test('a decision that is not due never asks the CLI for an ask', async () => {
    const { dir, land } = await released();
    await land({ 'docs/a.md': '# a\n' }, 'docs: a page');
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
    expect(read.decision.reason).toBe('nothing_ships');
    expect(asked).toEqual([]);
  });

  // Both twins at once: the ask and the bump PR are different subjects, and a due decision that
  // has both open names both.
  test('a due decision names the open ask and the open bump PR together', async () => {
    const { dir } = await due();
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => ['chore: release 1.0.1 (#3)'],
      async () => ['Release 1.0.1'],
    );
    if (!('decision' in read)) return expect.unreachable(read.cause);
    expect(read.decision.due).toBe(true);
    expect(read.decision.detail).toContain('; an ask already open: Release 1.0.1');
    expect(read.decision.detail).toContain('; a bump PR already open: chore: release 1.0.1 (#3)');
  });

  // Absent binary, no auth and a failed call all land here, and all three must read as the
  // lookup COULD NOT ANSWER — `undefined`, not an empty list. On the ask path that only costs
  // the twin note: the decision stands, and it claims no ask.
  test('a lookup that cannot answer is no answer at all, never an empty list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'release-due-ask-issue-'));
    madeDirs.push(dir);
    expect(await openAskTitlesAt(dir, '1.0.1')).toBeUndefined();
  });

  // And the consequence: an unanswered lookup on the ask path must not read as an open ask.
  test('a due decision whose ask lookup could not answer names no ask', async () => {
    const { dir } = await due();
    const read = await decideAt(
      dir,
      24,
      NOW,
      probed('v1.0.0'),
      async () => [],
      async () => undefined,
    );
    if (!('decision' in read)) return expect.unreachable(read.cause);
    expect(read.decision.due).toBe(true);
    expect(read.decision.detail).not.toContain('already open');
  });
});
