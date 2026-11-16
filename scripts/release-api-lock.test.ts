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

  test('an undeclared break still pending is said on the line, not hidden by the write', async () => {
    const dir = await tree();
    const pending = { code: BREAK_CODE, cause: 'c', fix: 'f' };
    const outcome = await writeApiLock(dir, reportOf({ next: NEXT, findings: [pending] }));
    expect(outcome.finding).toBeUndefined();
    expect(outcome.line).toContain('1 undeclared break(s) still reported');
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
    const dir = await tree();
    await Bun.write(`${dir}/package.json`, '{ "name": "fixture", "private": true }');
    await Bun.write(
      `${dir}/packages/core/package.json`,
      '{ "name": "@ultimat3/core", "version": "1.0.0" }',
    );
    await Bun.write(
      `${dir}/CHANGELOG.md`,
      '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- one.\n\n## Releases\n',
    );
    const calls: string[] = [];
    const written = { code: 'X_LOCKFILE_STALE', cause: 'bun.lock missing', fix: 'bun install' };
    const unread = { code: UNSCANNED_CODE, cause: 'no surface', fix: API_LOCK_COMMAND };
    const deps = {
      root: dir,
      now: new Date('2026-09-01T00:00:00Z'),
      run: async (command: readonly string[]) => {
        const branch = command.join(' ') === 'git branch --show-current';
        const output = command[0] === 'git' ? (branch ? 'chore/release-1.1.0' : '') : '[]';
        return { command, code: 0, ok: true, output, durationMs: 1, timedOut: false };
      },
      performWrites: async () => {
        calls.push('derived');
        return { writes: [], findings: [written] };
      },
      writeLock: async () => {
        calls.push('api-lock');
        return { line: '  api-lock  NOT written', finding: unread };
      },
    };
    // A dry run performs neither, and plans the lock beside the other derived files.
    const planned = await releaseResult(parseScriptArgs(['--bump', 'minor', '--dry-run']), deps);
    expect(calls).toEqual([]);
    expect(planned.lines).toContain(plannedApiLockLine());
    // The real bump: the derived writes first, the lock last, and each outcome reported.
    const bumped = await releaseResult(parseScriptArgs(['--bump', 'minor']), deps);
    expect(bumped.summary).toBe('1 packages set to 1.1.0');
    expect(calls).toEqual(['derived', 'api-lock']);
    expect(bumped.ok).toBe(false);
    expect(bumped.findings).toEqual([written, unread]);
    expect(bumped.lines).toContain('  api-lock  NOT written');
  });
});
