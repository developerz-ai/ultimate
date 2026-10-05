// The child's watch with its two facts faked: whether its supervisor is alive, and whether its root
// is on disk. The real orphan — a SIGKILLed supervisor, a deleted root — is
// `cmd-dev-orphan.live.test.ts`.

import { describe, expect, test } from 'bun:test';
import {
  DEV_SUPERVISOR_PID_ENV,
  type DevChildGone,
  defaultSupervisorAlive,
  hardExit,
  isDevDrainMessage,
  pidAlive,
  signalExitCode,
  supervisorPid,
  watchDevChild,
} from './dev-child-watch';

const SUPERVISED = { [DEV_SUPERVISOR_PID_ENV]: '4242' };

/** Runs a watch at 5ms until it leaves or `ms` passes; answers why it left, if it did. */
async function watched(
  options: { parent: () => number; exists: () => boolean; env?: Record<string, string> },
  ms = 100,
): Promise<readonly DevChildGone[]> {
  const left: DevChildGone[] = [];
  const stop = watchDevChild({
    root: '/app',
    env: options.env ?? SUPERVISED,
    leave: (why) => left.push(why),
    supervisorAlive: (pid) => options.parent() === pid,
    rootExists: options.exists,
    intervalMs: 5,
  });
  await Bun.sleep(ms);
  stop();
  return left;
}

describe('unit · supervisorPid', () => {
  test('a positive integer is a pid; anything else is a child nobody named', () => {
    expect(supervisorPid(SUPERVISED)).toBe(4242);
    expect(supervisorPid({})).toBeUndefined();
    expect(supervisorPid({ [DEV_SUPERVISOR_PID_ENV]: 'x' })).toBeUndefined();
    expect(supervisorPid({ [DEV_SUPERVISOR_PID_ENV]: '0' })).toBeUndefined();
  });
});

describe('unit · is the supervisor alive', () => {
  const failing = (code: string) => (): void => {
    throw Object.assign(new Error(code), { code });
  };

  test('signal 0 delivered or refused for permission is alive; no such process is gone', () => {
    expect(pidAlive(1, () => undefined)).toBe(true);
    expect(pidAlive(1, failing('EPERM'))).toBe(true);
    expect(pidAlive(1, failing('ESRCH'))).toBe(false);
  });

  test('Windows asks the process table — its ppid never changes — and POSIX the ppid', () => {
    expect(defaultSupervisorAlive('win32')(process.pid)).toBe(true);
    expect(defaultSupervisorAlive('linux')(process.ppid)).toBe(true);
    // This process's own pid is alive but is not its parent: POSIX says gone, Windows alive.
    expect(defaultSupervisorAlive('linux')(process.pid)).toBe(false);
  });
});

describe('unit · the drain message', () => {
  test("only the supervisor's own shape is a drain, and its code is the signal's", () => {
    expect(isDevDrainMessage({ type: 'x-dev-drain', signal: 'SIGTERM' })).toBe(true);
    expect(isDevDrainMessage({ type: 'x-dev-drain', signal: 'SIGKILL' })).toBe(false);
    expect(isDevDrainMessage({ type: 'other', signal: 'SIGINT' })).toBe(false);
    expect(isDevDrainMessage(null)).toBe(false);
    expect(signalExitCode('SIGINT')).toBe(130);
    expect(signalExitCode('SIGTERM')).toBe(143);
  });
});

describe('unit · watchDevChild', () => {
  test('a live supervisor and a present root: the child stays', async () => {
    expect(await watched({ parent: () => 4242, exists: () => true })).toEqual([]);
  });

  test('reparented — the supervisor is gone — the child leaves, once', async () => {
    let parent = 4242;
    const left = watched({ parent: () => parent, exists: () => true });
    await Bun.sleep(20);
    parent = 1;
    expect(await left).toEqual(['supervisor']);
  });

  test('a supervisor that died before the first tick is still caught', async () => {
    expect(await watched({ parent: () => 1, exists: () => true })).toEqual(['supervisor']);
  });

  test('the app root deleted: the child leaves, naming the root', async () => {
    expect(await watched({ parent: () => 4242, exists: () => false })).toEqual(['root']);
  });

  test('an unsupervised process watches its root and never its parent', async () => {
    expect(await watched({ parent: () => 1, exists: () => true, env: {} })).toEqual([]);
    expect(await watched({ parent: () => 1, exists: () => false, env: {} })).toEqual(['root']);
  });
});

describe('unit · hardExit', () => {
  test('armed once, it exits with the first code after its delay, however often it is asked', async () => {
    const exits: number[] = [];
    const stopping = hardExit(
      (code) => exits.push(code),
      () => 20,
    );
    stopping(143);
    stopping(1);
    expect(exits).toEqual([]);
    await Bun.sleep(60);
    expect(exits).toEqual([143]);
  });
});
