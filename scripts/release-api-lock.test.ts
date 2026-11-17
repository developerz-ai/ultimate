// A bump rewrites the public API lock: the report's next lock lands on disk at the release's
// version, an unreadable surface is a finding with that report's own fix, and `release.ts --bump`
// really calls it — a lock left at the previous release would judge the next one against it.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp/rm of its own; a unique directory per run keeps test workers apart.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun has no tmpdir() of its own; node:os is the only way to find the platform temp root.
import { tmpdir } from 'node:os';
import { parseScriptArgs } from './lib/args';
import { LOCK_PATH, parseLock } from './lib/public-api-lock';
import type { PublicApiReport } from './public-api';
import { BREAK_CODE, UNSCANNED_CODE } from './public-api';
import type { ReleaseDeps } from './release';
import { releaseResult } from './release';
import { API_LOCK_COMMAND, plannedApiLockLine, writeApiLock } from './release-api-lock';

const made: string[] = [];
afterAll(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tree(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/release-api-lock-`);
  made.push(dir);
  await mkdir(`${dir}/scripts/lib`, { recursive: true });
  await Bun.write(`${dir}/${LOCK_PATH}`, '{"version":"1.0.0","entries":{}}\n');
  return dir;
}

const NEXT = {
  format: 2,
  version: '1.1.0',
  entries: { '@ultimat3/alpha': { area: { hash: 'h1' }, KIND: { hash: 'h2' } } },
} as const;

const reportOf =
  (over: Partial<PublicApiReport>): (() => Promise<PublicApiReport>) =>
  async () => ({
    findings: [],
    diff: { breaks: [], compatible: [], added: [] },
    symbols: 2,
    migratedFrom: [],
    ...over,
  });

describe('writeApiLock', () => {
  test('writes the next lock at the release version, keys sorted', async () => {
    const dir = await tree();
    const outcome = await writeApiLock(dir, reportOf({ next: NEXT }));
    expect(outcome.finding).toBeUndefined();
    expect(outcome.line).toContain('recorded 2 symbols at 1.1.0');
    const written = parseLock(await Bun.file(`${dir}/${LOCK_PATH}`).json());
    expect(written).toEqual(NEXT);
  });

  // A held entry is a break shipped undeclared: the lock would carry it into every later release,
  // reporting a finding no changelog line can clear (main refuses BREAKING —, X_BREAKING_ON_MAIN).
  test('an undeclared break still pending writes no lock and is the finding', async () => {
    const dir = await tree();
    const pending = { code: BREAK_CODE, cause: 'c', fix: 'f', at: 'packages/alpha/src/index.ts' };
    const outcome = await writeApiLock(dir, reportOf({ next: NEXT, findings: [pending] }));
    expect(outcome.finding).toEqual(pending);
    expect(outcome.line).toContain('NOT written');
    expect(await Bun.file(`${dir}/${LOCK_PATH}`).text()).toBe('{"version":"1.0.0","entries":{}}\n');
  });

  test('an unreadable surface leaves the lock alone and is a finding with its own fix', async () => {
    const dir = await tree();
    const unscanned = { code: UNSCANNED_CODE, cause: 'tsc failed', fix: 'bun install' };
    const outcome = await writeApiLock(dir, reportOf({ findings: [unscanned], symbols: 0 }));
    expect(outcome.finding).toEqual({
      code: UNSCANNED_CODE,
      cause: `${LOCK_PATH} was not rewritten by this bump: tsc failed`,
      fix: 'bun install',
      at: LOCK_PATH,
    });
    expect(await Bun.file(`${dir}/${LOCK_PATH}`).text()).toBe('{"version":"1.0.0","entries":{}}\n');
  });

  test('the dry-run line names the file and the command that writes it alone', () => {
    expect(plannedApiLockLine()).toContain(LOCK_PATH);
    expect(plannedApiLockLine()).toContain(API_LOCK_COMMAND);
  });

  // Driven, not grepped: the order and both outcomes are what `releaseResult` does over a tree.
  test('release.ts --bump calls it, after the derived writes, and reports both outcomes', async () => {
    const dir = await releaseTree();
    const calls: string[] = [];
    const written = { code: 'X_LOCKFILE_STALE', cause: 'bun.lock missing', fix: 'bun install' };
    const unread = { code: UNSCANNED_CODE, cause: 'no surface', fix: API_LOCK_COMMAND };
    const deps = releaseDeps(dir, calls, reportOf({ next: NEXT }), {
      performWrites: async () => {
        calls.push('derived');
        return { writes: [], findings: [written] };
      },
      writeLock: async () => {
        calls.push('api-lock');
        return { line: '  api-lock  NOT written', finding: unread };
      },
    });
    // A dry run performs neither, and plans the lock beside the other derived files.
    const planned = await releaseResult(parseScriptArgs(['--bump', 'minor', '--dry-run']), deps);
    expect(calls).toEqual(['read-api']);
    expect(planned.lines).toContain(plannedApiLockLine());
    // The real bump: the surface read first, the derived writes, the lock last, each reported.
    calls.length = 0;
    const bumped = await releaseResult(parseScriptArgs(['--bump', 'minor']), deps);
    expect(bumped.summary).toBe('1 packages set to 1.1.0');
    expect(calls).toEqual(['read-api', 'derived', 'api-lock']);
    expect(bumped.ok).toBe(false);
    expect(bumped.findings).toEqual([written, unread]);
    expect(bumped.lines).toContain('  api-lock  NOT written');
  });

  // Before a single file moves, and under --dry-run too: once shipped, a break can no longer be
  // declared (main refuses the BREAKING — line), so the release is the last place to catch it.
  test('release.ts refuses a bump while an undeclared break is pending, writing nothing', async () => {
    const dir = await releaseTree();
    const calls: string[] = [];
    const pending = { code: BREAK_CODE, cause: 'c', fix: 'f', at: 'packages/core/src/index.ts' };
    const deps = releaseDeps(dir, calls, reportOf({ next: NEXT, findings: [pending] }), {
      performWrites: async () => {
        calls.push('derived');
        return { writes: [], findings: [] };
      },
      writeLock: async () => {
        calls.push('api-lock');
        return { line: '' };
      },
    });
    for (const argv of [
      ['--bump', 'minor', '--dry-run'],
      ['--bump', 'minor'],
    ]) {
      calls.length = 0;
      const refused = await releaseResult(parseScriptArgs(argv), deps);
      expect(refused.ok).toBe(false);
      expect(refused.findings).toEqual([pending]);
      expect(calls).toEqual(['read-api']);
    }
    expect(await Bun.file(`${dir}/packages/core/package.json`).text()).toBe(CORE_MANIFEST);
    expect(await Bun.file(`${dir}/${LOCK_PATH}`).text()).toBe('{"version":"1.0.0","entries":{}}\n');
  });
});

const CORE_MANIFEST = '{ "name": "@ultimat3/core", "version": "1.0.0" }';

async function releaseTree(): Promise<string> {
  const dir = await tree();
  await Bun.write(`${dir}/package.json`, '{ "name": "fixture", "private": true }');
  await Bun.write(`${dir}/packages/core/package.json`, CORE_MANIFEST);
  await Bun.write(
    `${dir}/CHANGELOG.md`,
    '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- one.\n\n## Releases\n',
  );
  return dir;
}

/** A release run over `dir` whose git answers a clean tree on a release branch. */
function releaseDeps(
  dir: string,
  calls: string[],
  read: () => Promise<PublicApiReport>,
  writers: Pick<ReleaseDeps, 'performWrites' | 'writeLock'>,
): ReleaseDeps {
  return {
    root: dir,
    now: new Date('2026-09-01T00:00:00Z'),
    run: async (command: readonly string[]) => {
      const branch = command.join(' ') === 'git branch --show-current';
      const output = command[0] === 'git' ? (branch ? 'chore/release-1.1.0' : '') : '[]';
      return { command, code: 0, ok: true, output, durationMs: 1, timedOut: false };
    },
    readApi: async () => {
      calls.push('read-api');
      return read();
    },
    ...writers,
  };
}
