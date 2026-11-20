// `exitWithin`, against a scripted role: an exit inside the window is its code and no signal; a role
// that will not exit is SIGKILLed and reported `null`, so a wedged drain ends the drill. And a start
// that failed keeps its own error when the stop after it fails too.

import { describe, expect, test } from 'bun:test';
import { NotImplementedError } from '@ultimat3/core';
import type { DrillRoleProcess } from './drill-fleet';
import { exitWithin, stopAfterFailedStart } from './drill-fleet';

const scripted = (exit: Promise<number>) => {
  const signals: string[] = [];
  const role: DrillRoleProcess = {
    role: 'worker',
    origin: 'http://127.0.0.1:1',
    readyz: 'http://127.0.0.1:2/readyz',
    signal: (signal) => {
      signals.push(signal);
    },
    exited: () => exit,
    respawn: async () => expect.unreachable('exitWithin never respawns'),
    log: () => '',
  };
  return { role, signals };
};

describe('exitWithin', () => {
  test('an exit inside the window is its code, and nothing is signalled', async () => {
    const { role, signals } = scripted(Promise.resolve(143));
    expect(await exitWithin(role, 1_000)).toBe(143);
    expect(signals).toEqual([]);
  });

  test('a role still running past the window is SIGKILLed and reported null', async () => {
    const exit = Promise.withResolvers<number>();
    const { role, signals } = scripted(exit.promise);
    role.signal = (signal) => {
      signals.push(signal);
      if (signal === 'SIGKILL') exit.resolve(137);
    };
    expect(await exitWithin(role, 5)).toBeNull();
    expect(signals).toEqual(['SIGKILL']);
  });
});

describe('stopAfterFailedStart', () => {
  const coded = (what: string) =>
    new NotImplementedError({ cause: `${what} in this test`, fix: 'x drill --list --json' });

  test('the fleet is stopped and the start error is what is thrown', async () => {
    const stopped: string[] = [];
    const error = await stopAfterFailedStart(coded('the start'), async () => {
      stopped.push('stop');
    }).catch((thrown: unknown) => thrown);
    expect(stopped).toEqual(['stop']);
    expect(String(Reflect.get(error as object, 'cause'))).toContain('the start');
  });

  test('a stop that throws too does not replace the start error', async () => {
    const error = await stopAfterFailedStart(coded('the start'), async () => {
      throw coded('the drop');
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeUltimateError('X_NOT_IMPLEMENTED');
    expect(String(Reflect.get(error as object, 'cause'))).toContain('the start');
  });
});
