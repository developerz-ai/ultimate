// `x stop` against a real process: a child that holds a lock in a temp state directory, as `x dev`
// does, and drains on SIGTERM the way `holdUntilShutdown` does (lock first, then exit). Each case
// waits on the child's own events, never on the clock.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory or recursive-remove native; each case gets its own state dir.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { DevStopDeniedError, DevStopTimeoutError, stopDev } from './cmd-stop';
import { lockPath, parseLock, writeLock } from './dev-lock';

const dirs: string[] = [];
const children: Bun.Subprocess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const stateDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'x-stop-'));
  dirs.push(dir);
  return dir;
};

/**
 * A child that says `ready` once its SIGTERM handler is installed. `drains` removes the lock and
 * exits, as `x dev`'s shutdown does; otherwise it ignores the signal and keeps running.
 */
const holder = async (dir: string, drains: boolean): Promise<Bun.Subprocess<'ignore', 'pipe'>> => {
  const onTerm = drains
    ? `require('node:fs').rmSync(${JSON.stringify(lockPath(dir))}, { force: true }); process.exit(0);`
    : '';
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `process.on('SIGTERM', () => { ${onTerm} }); setInterval(() => {}, 1000); console.log('ready');`,
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
  );
  children.push(child);
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(value)).toContain('ready');
  await writeLock(dir, {
    pid: child.pid,
    port: 4123,
    url: 'http://localhost:4123',
    startedAt: '2026-11-03T00:00:00.000Z',
  });
  return child;
};

describe('unit · x stop ends the x dev this checkout lock names', () => {
  test('SIGTERM, then the pid is gone and the lock cleared before it returns', async () => {
    const dir = stateDir();
    const child = await holder(dir, true);
    const result = await stopDev({ stateDir: dir, timeoutMs: 20_000 });
    expect(result).toMatchObject({ stopped: true, pid: child.pid, port: 4123, drained: true });
    expect(await child.exited).toBe(0);
    expect(await Bun.file(lockPath(dir)).exists()).toBe(false);
  });

  test('nothing running is a pass: stopped false, nothing signalled', async () => {
    const signalled: number[] = [];
    const result = await stopDev({
      stateDir: stateDir(),
      timeoutMs: 1_000,
      kill: (pid) => signalled.push(pid),
    });
    expect(result).toEqual({ stopped: false });
    expect(signalled).toEqual([]);
  });

  test('a lock naming a dead pid is not signalled, and is left for preflight to clear', async () => {
    const dir = stateDir();
    const gone = Bun.spawn([process.execPath, '-e', '0'], { stdout: 'ignore', stderr: 'ignore' });
    await gone.exited;
    await writeLock(dir, {
      pid: gone.pid,
      port: 4123,
      url: 'http://localhost:4123',
      startedAt: '',
    });
    const signalled: number[] = [];
    const result = await stopDev({
      stateDir: dir,
      timeoutMs: 1_000,
      kill: (pid) => signalled.push(pid),
    });
    expect(result).toEqual({ stopped: false });
    expect(signalled).toEqual([]);
    expect(await Bun.file(lockPath(dir)).exists()).toBe(true);
  });

  test('a child that ignores SIGTERM is X_DEV_STOP_TIMEOUT naming its pid, and keeps its lock', async () => {
    const dir = stateDir();
    const child = await holder(dir, false);
    const refused = await stopDev({ stateDir: dir, timeoutMs: 300 }).catch(
      (error: unknown) => error,
    );
    if (!(refused instanceof DevStopTimeoutError)) {
      return expect.unreachable('x stop returned while the pid it signalled was still running');
    }
    expect(refused).toBeInstanceOf(UltimateError);
    expect(refused.code).toBe('X_DEV_STOP_TIMEOUT');
    expect(refused.fix).toBe(`kill -9 ${String(child.pid)}   # then: x dev --json`);
    expect(refused.cause).toContain(String(child.pid));
    expect(child.exitCode).toBeNull();
    expect(await Bun.file(lockPath(dir)).exists()).toBe(true);
  });

  test('Windows terminates without a drain: drained false, and x stop clears the lock', async () => {
    const dir = stateDir();
    const child = await holder(dir, false);
    const result = await stopDev({
      stateDir: dir,
      timeoutMs: 20_000,
      platform: 'win32',
      // TerminateProcess, as `kill` is there: no handler runs, so nothing clears the lock.
      kill: (pid) => process.kill(pid, 'SIGKILL'),
    });
    expect(result).toMatchObject({ stopped: true, pid: child.pid, drained: false });
    await child.exited;
    expect(await Bun.file(lockPath(dir)).exists()).toBe(false);
  });
});

describe('unit · x stop never signals a process the lock does not identify', () => {
  test('writeLock records the holder`s start time beside its pid', async () => {
    const dir = stateDir();
    const child = await holder(dir, true);
    const lock = parseLock(await Bun.file(lockPath(dir)).text());
    expect(lock?.pid).toBe(child.pid);
    expect(lock?.started).toBeDefined();
  });

  test('a reused pid (start time differs) is not signalled, and the lock is reported stale', async () => {
    const dir = stateDir();
    const stranger = await holder(dir, true);
    // The lock a kill -9 left behind: the same pid, a process that started at another time.
    await Bun.write(
      lockPath(dir),
      JSON.stringify({ pid: stranger.pid, port: 4123, url: 'http://localhost:4123', started: '1' }),
    );
    const signalled: number[] = [];
    const result = await stopDev({
      stateDir: dir,
      timeoutMs: 1_000,
      kill: (pid) => signalled.push(pid),
    });
    expect(result).toEqual({ stopped: false, stale: true });
    expect(signalled).toEqual([]);
    expect(stranger.exitCode).toBeNull();
    expect(await Bun.file(lockPath(dir)).exists()).toBe(true);
  });

  test('a pid another user owns is X_DEV_STOP_DENIED, never a raw EPERM', async () => {
    const dir = stateDir();
    const child = await holder(dir, false);
    const refused = await stopDev({
      stateDir: dir,
      timeoutMs: 1_000,
      kill: () => {
        throw Object.assign(new TypeError('kill EPERM'), { code: 'EPERM' });
      },
    }).catch((error: unknown) => error);
    if (!(refused instanceof DevStopDeniedError)) {
      return expect.unreachable('x stop let the EPERM escape uncoded');
    }
    expect(refused.code).toBe('X_DEV_STOP_DENIED');
    expect(refused.cause).toContain(String(child.pid));
    expect(refused.fix).toBe(
      `ps -o user= -p ${String(child.pid)}   # then, as that user: x stop --json`,
    );
  });
});
