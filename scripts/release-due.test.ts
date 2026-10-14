// `scripts/release-due.ts` against real git repositories built per test: the last tag is the
// highest one HEAD contains, the window is what git says landed since it, and a tree with no tag
// is a coded refusal — never "nothing to release".

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REPO_SCAN_TIMEOUT_MS, repoRoot, run } from './lib/run';
import { decideAt, lastReleaseTag, parseWindowLog, settleHoursOf } from './release-due';

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
  const git = (argv: readonly string[], hoursAgo = 72): string => {
    const date = new Date(NOW - hoursAgo * HOUR).toISOString();
    const out = Bun.spawnSync(
      [
        'git',
        '-c',
        'user.email=t@example.test',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'tag.gpgsign=false',
        ...argv,
      ],
      {
        cwd: dir,
        // A hook that runs this suite exports GIT_DIR, and git would follow it to the real repo.
        env: {
          ...Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.startsWith('GIT_'))),
          GIT_AUTHOR_NAME: 't',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_DATE: date,
          GIT_AUTHOR_DATE: date,
        },
        timeout: 30_000,
      },
    );
    expect({ argv, code: out.exitCode, err: out.stderr.toString() }).toEqual({
      argv,
      code: 0,
      err: expect.any(String),
    });
    return out.stdout.toString();
  };
  const land = async (
    files: Readonly<Record<string, string>>,
    subject: string,
    hoursAgo = 72,
    author?: string,
  ): Promise<void> => {
    for (const [path, body] of Object.entries(files)) await Bun.write(join(dir, path), body);
    git(['add', '-A'], hoursAgo);
    git(
      ['commit', '--quiet', '-m', subject, ...(author === undefined ? [] : ['--author', author])],
      hoursAgo,
    );
  };
  git(['init', '--quiet', '-b', 'main']);
  await land(
    {
      'packages/core/package.json': MANIFEST('1.0.0'),
      'packages/core/src/a.ts': 'export const a = 1;\n',
      'CHANGELOG.md': CHANGELOG,
    },
    'chore: release 1.0.0 (#1)',
  );
  if (options.tag) git(['tag', '-a', 'v1.0.0', '-m', 'v1.0.0']);
  return { dir, git, land };
}

describe('unit · release-due · read from a real repository', () => {
  test('no reachable vX.Y.Z tag is X_RELEASE_TAG_UNREACHABLE, not an empty window', async () => {
    const { dir } = await released({ tag: false });
    const read = await decideAt(dir, 24, NOW);
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
    const read = await decideAt(dir, 24, NOW);
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
    const settled = await decideAt(dir, 24, NOW);
    if (!('decision' in settled)) return expect.unreachable(settled.cause);
    expect(settled.tagged).toBe('1.0.0');
    expect(settled.decision.due).toBe(true);
    expect(settled.decision.next).toBe('1.0.1');
    expect(settled.decision.shipping.map((c) => [c.subject, c.packages])).toEqual([
      ['fix(core): a is two | really (#2)', ['core']],
    ]);
    const fresh = await decideAt(dir, 48, NOW);
    if (!('decision' in fresh)) return expect.unreachable(fresh.cause);
    expect(fresh.decision.reason).toBe('settling');
  });

  test('the last release is the highest tag HEAD contains, never one on another branch', async () => {
    const { dir, git, land } = await released();
    git(['checkout', '--quiet', '-b', 'side']);
    await land({ 'packages/core/src/b.ts': 'export const b = 1;\n' }, 'feat: side');
    git(['tag', '-a', 'v9.0.0', '-m', 'v9.0.0']);
    git(['checkout', '--quiet', 'main']);
    expect(await lastReleaseTag(dir)).toBe('1.0.0');
    git(['tag', '-a', 'v1.0.0-rc.1', '-m', 'rc']);
    expect(await lastReleaseTag(dir)).toBe('1.0.0');
  });

  test('a merged bump with no tag yet is awaiting_tag, not a second release', async () => {
    const { dir, land } = await released();
    await land({ 'packages/core/src/a.ts': 'export const a = 3;\n' }, 'fix(core): three');
    await land({ 'packages/core/package.json': MANIFEST('1.0.1') }, 'chore: release 1.0.1 (#3)');
    const read = await decideAt(dir, 24, NOW);
    if (!('decision' in read)) return expect.unreachable(read.cause);
    expect(read.decision.reason).toBe('awaiting_tag');
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
    const out = await run(['bun', 'run', 'scripts/release-due.ts', '--json'], { cwd: repoRoot() });
    const parsed = JSON.parse(out.output) as {
      ok: boolean;
      script: string;
      data: { due: boolean; lastTag: string; reason?: string };
    };
    expect(parsed.script).toBe('release-due');
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.data.due).toBe('boolean');
    expect(parsed.data.lastTag).toMatch(/^v\d+\.\d+\.\d+$/);
    if (!parsed.data.due) expect(parsed.data.reason).toBeDefined();
  });
});
