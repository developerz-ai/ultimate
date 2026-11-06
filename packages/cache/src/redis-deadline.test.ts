// `withinDeadline` against a client that never answers: the deadline turns a hang into a refusal,
// the park turns the next five seconds of refusals into ones that cost nothing, and a bust is
// never parked. The timer and the clock are both the test's — nothing here waits.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { DeadlineTimer } from '@ultimat3/core/outbound';
import { CacheDriverUnavailableError } from './errors';
import type { RedisLike } from './redis';
import {
  DEFAULT_REDIS_BUST_TIMEOUT_MS,
  DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
  REDIS_PARK_MS,
  withinDeadline,
} from './redis-deadline';

/** A timer the test fires by hand, recording each deadline it was armed with. */
function manualTimer() {
  const armed = new Map<number, { fire: () => void; ms: number }>();
  let next = 0;
  const timer: DeadlineTimer = {
    set(fire, ms) {
      next += 1;
      armed.set(next, { fire, ms });
      return next;
    },
    clear(handle) {
      armed.delete(handle as number);
    },
  };
  const fireAll = (): void => {
    for (const [handle, entry] of [...armed]) {
      armed.delete(handle);
      entry.fire();
    }
  };
  return { timer, armed, fireAll };
}

/** A server that is paused: every command is accepted and none is ever answered. */
function hungRedis() {
  const calls: string[] = [];
  const never = new Promise<never>(() => undefined);
  const client: RedisLike = {
    get: (key) => {
      calls.push(`GET ${key}`);
      return never;
    },
    set: (key) => {
      calls.push(`SET ${key}`);
      return never;
    },
    send: (command) => {
      calls.push(command);
      return never;
    },
  };
  return { client, calls };
}

const refusalOf = (pending: Promise<unknown>): Promise<unknown> =>
  pending.then(
    () => expect.unreachable('a command against a hung server answered'),
    (error: unknown) => error,
  );

describe('unit · withinDeadline', () => {
  test('the defaults are the measured ones', () => {
    expect(DEFAULT_REDIS_COMMAND_TIMEOUT_MS).toBe(150);
    expect(DEFAULT_REDIS_BUST_TIMEOUT_MS).toBe(1_000);
    expect(REDIS_PARK_MS).toBe(5_000);
  });

  test('a never-settling GET is refused at its deadline, as CacheDriverUnavailableError', async () => {
    const { client } = hungRedis();
    const { timer, armed, fireAll } = manualTimer();
    const { value } = withinDeadline(client, {
      commandTimeoutMs: 150,
      clock: frozenClock(),
      timer,
    });

    const pending = refusalOf(value.get('k'));
    expect([...armed.values()].map((entry) => entry.ms)).toEqual([150]);
    fireAll();
    const refusal = await pending;
    expect(refusal).toBeInstanceOf(CacheDriverUnavailableError);
    expect((refusal as CacheDriverUnavailableError).cause).toContain('150 ms');
  });

  test('after a miss the value path refuses without touching the client, until REDIS_PARK_MS passes', async () => {
    const { client, calls } = hungRedis();
    const { timer, fireAll } = manualTimer();
    const clock = frozenClock();
    const { value } = withinDeadline(client, { commandTimeoutMs: 150, clock, timer });

    const first = refusalOf(value.get('k'));
    fireAll();
    await first;
    expect(calls).toEqual(['GET k']);

    clock.advance(REDIS_PARK_MS - 1);
    const parked = await refusalOf(value.send('PTTL', ['k']));
    expect(parked).toBeInstanceOf(CacheDriverUnavailableError);
    expect((parked as CacheDriverUnavailableError).cause).toContain('parked');
    expect(calls).toEqual(['GET k']);

    clock.advance(1);
    const reopened = refusalOf(value.set('k', 'v'));
    expect(calls).toEqual(['GET k', 'SET k']);
    fireAll();
    await reopened;
  });

  test('a bust is never parked, and carries its own longer deadline', async () => {
    const { client, calls } = hungRedis();
    const { timer, armed, fireAll } = manualTimer();
    const { value, bust } = withinDeadline(client, {
      commandTimeoutMs: 150,
      clock: frozenClock(),
      timer,
    });
    const miss = refusalOf(value.get('k'));
    fireAll();
    await miss;

    const pending = refusalOf(bust.send('EVAL', ['script']));
    expect(calls).toEqual(['GET k', 'EVAL']);
    expect([...armed.values()].map((entry) => entry.ms)).toEqual([DEFAULT_REDIS_BUST_TIMEOUT_MS]);
    fireAll();
    expect(await pending).toBeInstanceOf(CacheDriverUnavailableError);
  });

  test('an answer before the deadline is the answer, and its timer is cleared', async () => {
    const { timer, armed } = manualTimer();
    const client: RedisLike = {
      get: () => Promise.resolve('v'),
      set: () => Promise.resolve('OK'),
      send: () => Promise.reject(new Error('WRONGTYPE')),
    };
    const { value } = withinDeadline(client, {
      commandTimeoutMs: 150,
      clock: frozenClock(),
      timer,
    });
    expect(await value.get('k')).toBe('v');
    // A refusal the server gave is passed through as itself, and never parks the path.
    expect(await refusalOf(value.send('GET', ['k']))).toBeInstanceOf(Error);
    expect(await value.set('k', 'v')).toBe('OK');
    expect(armed.size).toBe(0);
  });
});
