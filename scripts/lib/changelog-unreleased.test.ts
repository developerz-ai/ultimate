// The unreleased-entry rule, pure and over a real throwaway git repository: shipped source with no
// `[Unreleased]` line is refused, and a test-only, docs-only, release or labelled change is not.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
import {
  addedUnreleasedEntries,
  eventLabels,
  isShippedSource,
  NO_CHANGELOG_LABEL,
  unreleasedGap,
} from './changelog-unreleased';
import { judgesPullRequest, unreleasedCheck } from './changelog-unreleased-git';
import { run } from './run';

const INDEX = (body: string) =>
  `# Changelog\n\nPreamble.\n\n## [Unreleased]\n\n${body}\n\n## Releases\n\n| Version |\n`;
const EMPTY = INDEX('Nothing yet.');
const WRITTEN = INDEX('### Fixed\n\n- The cache bus keeps its subscription across a reconnect.');

const input = (over: Partial<Parameters<typeof unreleasedGap>[0]>) =>
  unreleasedGap({
    changed: ['packages/cache/src/bus.ts'],
    added: [],
    baseIndex: EMPTY,
    headIndex: EMPTY,
    labels: [],
    ...over,
  });

describe('unreleasedGap', () => {
  test('shipped source with no new [Unreleased] line is X_CHANGELOG_UNRELEASED_EMPTY', () => {
    const finding = input({});
    expect(finding?.code).toBe('X_CHANGELOG_UNRELEASED_EMPTY');
    expect(finding?.cause).toContain('packages/cache/src/bus.ts');
    expect(finding?.fix).toStartWith('git diff --name-only origin/main');
  });

  test('a new line under [Unreleased] answers it', () => {
    expect(input({ headIndex: WRITTEN })).toBeUndefined();
  });

  test('a line the base already had is not this change writing one', () => {
    expect(input({ baseIndex: WRITTEN, headIndex: WRITTEN })?.code).toBe(
      'X_CHANGELOG_UNRELEASED_EMPTY',
    );
  });

  test('tests, a package README and docs owe no line', () => {
    expect(
      input({
        changed: [
          'packages/cache/src/bus.test.ts',
          'packages/cache/src/bus.live.test.ts',
          'packages/cache/src/README.md',
          'packages/cache/README.md',
          'wiki/Caching.md',
          'docs/architecture/x.md',
          'scripts/flake-hunt.ts',
        ],
      }),
    ).toBeUndefined();
  });

  test('a release PR — it adds docs/changelog/<version>.md and empties [Unreleased] — passes', () => {
    expect(
      input({
        changed: ['packages/cli/src/version.ts', 'docs/changelog/31.30.0.md', 'CHANGELOG.md'],
        added: ['docs/changelog/31.30.0.md'],
        baseIndex: WRITTEN,
        headIndex: EMPTY,
      }),
    ).toBeUndefined();
  });

  test('the no-changelog label opts a refactor out', () => {
    expect(input({ labels: ['refactor', NO_CHANGELOG_LABEL] })).toBeUndefined();
  });

  test('no base to diff is refused, never read as owing nothing', () => {
    expect(input({ changed: undefined })?.cause).toContain('no origin/main');
  });
});

describe('the parts', () => {
  test('isShippedSource', () => {
    expect(isShippedSource('packages/core/src/a.ts')).toBe(true);
    expect(isShippedSource('packages/ui/src/button.tsx')).toBe(true);
    expect(isShippedSource('packages/core/src/a.test.ts')).toBe(false);
    expect(isShippedSource('packages/core/package.json')).toBe(false);
    expect(isShippedSource('examples/dummy/packages/core/src/a.ts')).toBe(false);
  });

  test('addedUnreleasedEntries reads [Unreleased] only, and bullets only', () => {
    const released = `${EMPTY}\n## 31.29.0 - 2026-11-15\n\n- an old line\n`;
    expect(addedUnreleasedEntries(EMPTY, released)).toEqual([]);
    expect(addedUnreleasedEntries(EMPTY, WRITTEN)).toEqual([
      '- The cache bus keeps its subscription across a reconnect.',
    ]);
  });

  test('eventLabels reads a pull_request payload and nothing else', () => {
    expect(eventLabels({ pull_request: { labels: [{ name: 'a' }, { name: 3 }, {}] } })).toEqual([
      'a',
    ]);
    expect(eventLabels({ push: {} })).toEqual([]);
    expect(eventLabels('nope')).toEqual([]);
  });

  test('a pull request in CI blocks; a local run does not', () => {
    expect(judgesPullRequest({ GITHUB_BASE_REF: 'main' })).toBe(true);
    expect(judgesPullRequest({ GITHUB_BASE_REF: '' })).toBe(false);
    expect(judgesPullRequest({})).toBe(false);
  });
});

const made: string[] = [];
afterAll(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const git = async (cwd: string, ...args: string[]) => {
  const result = await run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });
  if (!result.ok) expect.unreachable(`git ${args.join(' ')}: ${result.output}`);
};

/** A repository whose `origin/main` is its first commit: shipped source and an empty changelog. */
async function repo(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/changelog-unreleased-`);
  made.push(dir);
  await git(dir, 'init', '-q', '-b', 'work');
  await Bun.write(`${dir}/CHANGELOG.md`, EMPTY);
  await Bun.write(`${dir}/packages/cache/src/bus.ts`, 'export const a = 1;\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', 'base');
  await git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
}

describe('unreleasedCheck, over a real repository', () => {
  test('an uncommitted source edit with no line is found, and blocks only on a pull request', async () => {
    const dir = await repo();
    await Bun.write(`${dir}/packages/cache/src/bus.ts`, 'export const a = 2;\n');
    const local = await unreleasedCheck(dir, {});
    expect(local.finding?.code).toBe('X_CHANGELOG_UNRELEASED_EMPTY');
    expect(local.blocking).toBe(false);
    expect((await unreleasedCheck(dir, { GITHUB_BASE_REF: 'main' })).blocking).toBe(true);
  });

  test('a committed source edit plus its line passes; an untracked new source file counts', async () => {
    const dir = await repo();
    await Bun.write(`${dir}/packages/cache/src/new.ts`, 'export const b = 1;\n');
    expect((await unreleasedCheck(dir, {})).finding?.cause).toContain('packages/cache/src/new.ts');
    await Bun.write(`${dir}/CHANGELOG.md`, WRITTEN);
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-q', '-m', 'work');
    expect((await unreleasedCheck(dir, {})).finding).toBeUndefined();
  });

  test('the label on the event payload opts out', async () => {
    const dir = await repo();
    await Bun.write(`${dir}/packages/cache/src/bus.ts`, 'export const a = 3;\n');
    const event = `${dir}/.event.json`;
    await Bun.write(
      event,
      JSON.stringify({ pull_request: { labels: [{ name: 'no-changelog' }] } }),
    );
    const env = { GITHUB_BASE_REF: 'main', GITHUB_EVENT_PATH: event };
    expect((await unreleasedCheck(dir, env)).finding).toBeUndefined();
  });

  test('no origin/main at all is refused', async () => {
    const dir = await repo();
    await git(dir, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect((await unreleasedCheck(dir, {})).finding?.cause).toContain('no origin/main');
  });
});
