// The child's watch with its two facts faked: whether its supervisor is alive, and whether its root
// is on disk. The real orphan — a SIGKILLed supervisor, a deleted root — is
// `cmd-dev-orphan.live.test.ts`.

import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
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

/**
 * Runs a watch at 5ms for `ticks` ticks of Bun's fake clock; answers why it left, if it did, and
 * how often it asked — a "stays" verdict from a watch that never polled would prove nothing.
 */
function watched(
  options: { parent: () => number; exists: () => boolean; env?: Record<string, string> },
  ticks = 20,
  between?: (tick: number) => void,
): { readonly left: readonly DevChildGone[]; readonly polls: number } {
  const left: DevChildGone[] = [];
  let polls = 0;
  const stop = watchDevChild({
    root: '/app',
    env: options.env ?? SUPERVISED,
    leave: (why) => left.push(why),
    supervisorAlive: (pid) => options.parent() === pid,
    rootExists: (root) => {
      polls += 1;
      return root === '/app' && options.exists();
    },
    intervalMs: 5,
  });
  for (let tick = 0; tick < ticks; tick += 1) {
    between?.(tick);
    jest.advanceTimersByTime(5);
  }
  stop();
  return { left, polls };
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
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('a live supervisor and a present root: the child stays', () => {
    const run = watched({ parent: () => 4242, exists: () => true });
    expect(run.left).toEqual([]);
    expect(run.polls).toBe(20);
  });

  test('reparented — the supervisor is gone — the child leaves, once', () => {
    let parent = 4242;
    const run = watched({ parent: () => parent, exists: () => true }, 20, (tick) => {
      if (tick === 4) parent = 1;
    });
    expect(run.left).toEqual(['supervisor']);
    // Four ticks with the root asked, then the supervisor's death, then not one more poll.
    expect(run.polls).toBe(4);
  });

  test('a supervisor that died before the first tick is still caught', () => {
    expect(watched({ parent: () => 1, exists: () => true }).left).toEqual(['supervisor']);
  });

  test('the app root deleted: the child leaves, naming the root', () => {
    expect(watched({ parent: () => 4242, exists: () => false }).left).toEqual(['root']);
  });

  test('an unsupervised process watches its root and never its parent', () => {
    const stays = watched({ parent: () => 1, exists: () => true, env: {} });
    expect(stays).toEqual({ left: [], polls: 20 });
    expect(watched({ parent: () => 1, exists: () => false, env: {} }).left).toEqual(['root']);
  });

  test('the stop it answers ends the watch: a later death is never reported', () => {
    let parent = 4242;
    const left: DevChildGone[] = [];
    const stop = watchDevChild({
      root: '/app',
      env: SUPERVISED,
      leave: (why) => left.push(why),
      supervisorAlive: (pid) => parent === pid,
      rootExists: () => true,
      intervalMs: 5,
    });
    jest.advanceTimersByTime(10);
    stop();
    parent = 1;
    jest.advanceTimersByTime(50);
    expect(left).toEqual([]);
  });
});

describe('unit · hardExit', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('armed once, it exits with the first code after its delay, however often it is asked', () => {
    const exits: number[] = [];
    const stopping = hardExit(
      (code) => exits.push(code),
      () => 20,
    );
    stopping(143);
    stopping(1);
    expect(exits).toEqual([]);
    jest.advanceTimersByTime(19);
    expect(exits).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(exits).toEqual([143]);
    jest.advanceTimersByTime(100);
    expect(exits).toEqual([143]);
  });
});
