// The Redis store's wire and its failure rules, against a client that records what it was sent.
// That the Lua is Lua — and is a token bucket — is `rate-limit-redis.live.test.ts`'s, against a
// real server: a fake that cannot run a script has no opinion about one.
import { afterEach, describe, expect, test } from 'bun:test';
import { setLogSink, UltimateError } from '@ultimat3/core';
import type { Bucket } from './rate-limit';
import { REDIS_RATE_LIMIT_TAKE, redisRateLimitStore } from './rate-limit-redis';

const bucket: Bucket = { capacity: 2, refillPerSecond: 0.001 };
const NOW = 1_700_000_000_000;

type Sent = { readonly command: string; readonly args: readonly string[] };

const recording = (answer: (sent: Sent) => unknown) => {
  const sent: Sent[] = [];
  return {
    sent,
    client: {
      send: async (command: string, args: string[]) => {
        sent.push({ command, args });
        return answer({ command, args });
      },
    },
  };
};

/** What Bun's client rejects with, by shape: a server reply or a refused send, never a verdict. */
const redisFailure = (message: string, code?: string) => ({
  name: 'RedisError',
  message,
  ...(code === undefined ? {} : { code }),
});
const connectionClosed = () => redisFailure('Connection closed', 'ERR_REDIS_CONNECTION_CLOSED');

let previousSink: ReturnType<typeof setLogSink> | undefined;
afterEach(() => {
  setLogSink(previousSink);
  previousSink = undefined;
});
const quiet = (): void => {
  previousSink = setLogSink(() => undefined);
};

describe('redisRateLimitStore', () => {
  test('is shared, so it satisfies a fleet-wide declaration', () => {
    expect(redisRateLimitStore({ client: recording(() => null).client }).scope).toBe('shared');
  });

  test('a take is one EVALSHA on the prefixed key, with the caller clock', async () => {
    const { client, sent } = recording(() => ['1.5', 1]);
    const decision = await redisRateLimitStore({ client, prefix: 'app' }).take(
      'r|ip:1.2.3.4',
      bucket,
      1,
      NOW + 0.7,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.command).toBe('EVALSHA');
    expect(sent[0]?.args.slice(1)).toEqual([
      '1',
      'app:rl:r|ip:1.2.3.4',
      '2',
      '0.001',
      '1',
      String(NOW),
    ]);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(1);
  });

  test('a server that lost the script gets it with EVAL, once', async () => {
    const { client, sent } = recording(({ command }) => {
      if (command === 'EVALSHA') throw redisFailure('NOSCRIPT No matching script.');
      return ['0', 0];
    });
    const decision = await redisRateLimitStore({ client }).take('k', bucket, 1, NOW);
    expect(sent.map((entry) => entry.command)).toEqual(['EVALSHA', 'EVAL']);
    expect(sent[1]?.args[0]).toBe(REDIS_RATE_LIMIT_TAKE);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('a peek is a read — HMGET, never the script — and a missing key is full', async () => {
    const { client, sent } = recording(() => [null, null]);
    const peek = await redisRateLimitStore({ client }).peek('k', bucket, NOW);
    expect(sent.map((entry) => entry.command)).toEqual(['HMGET']);
    expect(peek.remaining).toBe(2);
  });

  test('a peek refills what it read, without writing it back', async () => {
    const { client } = recording(() => ['0', String(NOW - 1_000_000)]);
    expect((await redisRateLimitStore({ client }).peek('k', bucket, NOW)).remaining).toBe(1);
  });

  test('a reply that is not the script answering is refused, never read as allowed', async () => {
    const { client } = recording(() => 'OK');
    await expect(redisRateLimitStore({ client }).take('k', bucket, 1, NOW)).rejects.toThrow(
      /X_RATE_LIMIT_STORE_UNAVAILABLE/,
    );
  });

  test('a closed connection degrades to a per-process bucket that still limits', async () => {
    quiet();
    const { client } = recording(() => {
      throw connectionClosed();
    });
    const store = redisRateLimitStore({ client });
    const verdicts = [];
    for (let index = 0; index < 3; index += 1) {
      verdicts.push((await store.take('k', bucket, 1, NOW)).allowed);
    }
    expect(verdicts).toEqual([true, true, false]);
    expect((await store.peek('k', bucket, NOW)).remaining).toBe(0);
  });

  // The degraded line names the store that is down: "could not reach the database" sent an
  // operator to Postgres while Redis was the thing refusing.
  test('a degraded Redis store says Redis, with the command that checks it', async () => {
    const lines: string[] = [];
    previousSink = setLogSink((line) => {
      lines.push(line);
    });
    const { client } = recording(() => {
      throw connectionClosed();
    });
    await redisRateLimitStore({ client }).take('k', bucket, 1, NOW);
    const degraded = lines.find((line) => line.includes('http.rate_limit.degraded')) ?? '';
    expect(degraded).toContain('Redis');
    expect(degraded).not.toContain('database');
    expect(degraded).toContain('redis-cli');
  });

  // Config resolution refuses it, so this is the guard for a store handed a bucket directly: a
  // bucket that never refills would be a key that never expires.
  test('a bucket that never refills is a coded refusal, never a key held forever', async () => {
    const { client, sent } = recording(() => ['0', 1]);
    const store = redisRateLimitStore({ client });
    for (const refillPerSecond of [0, -1, Number.NaN]) {
      await expect(store.take('k', { capacity: 2, refillPerSecond }, 1, NOW)).rejects.toMatchObject(
        { code: 'X_CONFIG_INVALID' },
      );
    }
    expect(sent).toEqual([]);
  });

  test('a server that never answers degrades at the deadline', async () => {
    quiet();
    const client = { send: () => new Promise<unknown>(() => undefined) };
    const store = redisRateLimitStore({
      client,
      deadlineMs: 5,
      schedule: (fn) => {
        queueMicrotask(fn);
        return () => undefined;
      },
    });
    expect((await store.take('k', bucket, 1, NOW)).allowed).toBe(true);
  });

  test('a bad deadline names THIS store, with its own call to paste', () => {
    expect(() =>
      redisRateLimitStore({ client: recording(() => null).client, deadlineMs: 0 }),
    ).toThrow(/redisRateLimitStore/);
  });

  test('an error REPLY is not an outage: it still refuses', async () => {
    const reply = new UltimateError({ code: 'X_SOMETHING', cause: 'c', fix: 'x doctor --json' });
    const { client } = recording(({ command }) => {
      if (command === 'EVALSHA') throw redisFailure('ERR Error running script');
      throw reply;
    });
    await expect(redisRateLimitStore({ client }).take('k', bucket, 1, NOW)).rejects.toMatchObject({
      message: 'ERR Error running script',
    });
  });

  test('reset deletes the prefixed key', async () => {
    const { client, sent } = recording(() => 1);
    await redisRateLimitStore({ client }).reset('k');
    expect(sent).toEqual([{ command: 'DEL', args: ['x:rl:k'] }]);
  });
});
