// A bump rewrites the public API lock: the report's next lock lands on disk at the release's
// version, an unreadable surface is a finding with that report's own fix, and `release.ts --bump`
// really calls it — a lock left at the previous release would judge the next one against it.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no mkdtemp/rm of its own; a unique directory per run keeps test workers apart.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun has no tmpdir() of its own; node:os is the only way to find the platform temp root.
import { tmpdir } from 'node:os';
import { LOCK_PATH, parseLock } from './lib/public-api-breaks';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import type { PublicApiReport } from './public-api';
import { BREAK_CODE, UNSCANNED_CODE } from './public-api';
import { API_LOCK_COMMAND, plannedApiLockLine, writeApiLock } from './release-api-lock';

// The last case reads `scripts/release.ts` off the real tree.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

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

const NEXT = { version: '1.1.0', entries: { '@ultimat3/alpha': { area: 'h1', KIND: 'h2' } } };

const reportOf =
  (over: Partial<PublicApiReport>): (() => Promise<PublicApiReport>) =>
  async () => ({ findings: [], diff: { breaks: [], added: [] }, symbols: 2, ...over });

describe('writeApiLock', () => {
  test('writes the next lock at the release version, keys sorted', async () => {
    const dir = await tree();
    const outcome = await writeApiLock(dir, reportOf({ next: NEXT }));
    expect(outcome.finding).toBeUndefined();
    expect(outcome.line).toContain('recorded 2 symbols at 1.1.0');
    const written = parseLock(await Bun.file(`${dir}/${LOCK_PATH}`).json());
    expect(written).toEqual({
      version: '1.1.0',
      entries: { '@ultimat3/alpha': { KIND: 'h2', area: 'h1' } },
    });
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

  test('release.ts --bump calls it, after the derived writes, and reports both outcomes', async () => {
    const source = await Bun.file(`${repoRoot()}/scripts/release.ts`).text();
    const performed = source.indexOf('await performReleaseWrites(root, version)');
    const locked = source.indexOf('await writeApiLock(root)');
    expect(performed).toBeGreaterThan(-1);
    expect(locked).toBeGreaterThan(performed);
    expect(source).toContain('plannedApiLockLine()');
    expect(source).toContain('apiLock?.finding === undefined');
  });
});
