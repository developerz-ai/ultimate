// The child's watch with its two facts faked: which parent the child has, and whether its root is
// on disk. The real orphan — a SIGKILLed supervisor, a deleted root — is
// `cmd-dev-orphan.live.test.ts`.

import { describe, expect, test } from 'bun:test';
import {
  DEV_SUPERVISOR_PID_ENV,
  type DevChildGone,
  hardExit,
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
    parentPid: options.parent,
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
