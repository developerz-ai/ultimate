// The CLI's half of `x db migrate` beside a live `x dev`: what the holder answered, read; and
// every answer that is not the route's becomes the refusal whose fix needs no holder.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { allowHost } from '@ultimat3/testing';
import { askDev, type DevWait, migrateThroughDev, postJson } from './db-migrate-through-dev';
import type { DevLock } from './dev-lock';

const lock: DevLock = { pid: 4242, port: 3111, url: 'https://0.0.0.0:3111', startedAt: '' };

const DATA = {
  applied: ['0001_gadgets'],
  skipped: 2,
  appVersion: 'dev',
  durationMs: 12,
  drift: [],
  catalog: { schema: 'public', tables: [] },
  storage: [],
};

async function refusal(run: Promise<unknown>): Promise<{ code: string; fix: string }> {
  const error = await run.then(
    () => expect.unreachable('the pass was answered'),
    (thrown: unknown) => thrown,
  );
  if (!isUltimateError(error)) return expect.unreachable('an uncoded throw');
  return { code: error.code, fix: error.fix };
}

describe('migrateThroughDev', () => {
  test('posts to the holder through loopback, on the scheme it serves', async () => {
    const asked: string[] = [];
    const data = await migrateThroughDev(lock, '/app/.x', async (url) => {
      asked.push(url);
      return { ok: true, data: DATA };
    });
    expect(asked).toEqual(['https://localhost:3111/_x/db/migrate']);
    expect(data.applied).toEqual(['0001_gadgets']);
    expect(data.skipped).toBe(2);
  });

  test("the holder's own refusal is re-thrown under its code, cause and fix", async () => {
    const error = { code: 'X_MIGRATION_FAILED', cause: 'syntax error', fix: 'x db gen "repair"' };
    expect(
      await refusal(migrateThroughDev(lock, '/app/.x', async () => ({ ok: false, error }))),
    ).toEqual({ code: 'X_MIGRATION_FAILED', fix: 'x db gen "repair"' });
  });

  test.each([
    ['a closed port', () => Promise.reject(new TypeError('ConnectionRefused'))],
    ['an older server with no such route', async () => ({ panel: '/_x/db/migrate' })],
    ['an answer that is not the pass', async () => ({ ok: true, data: { applied: 'all' } })],
    ['a refusal with no error', async () => ({ ok: false })],
  ])('%s refuses with the stop, migrate, start that needs no holder', async (_name, post) => {
    expect(await refusal(migrateThroughDev(lock, '/app/.x', post))).toEqual({
      code: 'X_DEV_ALREADY_RUNNING',
      fix: 'x stop --json && x db migrate && x dev   # the embedded database takes one process at a time; pass the flags you passed',
    });
  });
});

// Measured with two real processes: `x db gen && x db migrate` reached an `x dev` whose child was
// restarting. The lock was live, the port not yet bound, and the pass was refused with a fix that
// stops a server about to answer.
describe('askDev while the holder boots', () => {
  const refusedConnection = (): Error =>
    Object.assign(new TypeError('ECONNREFUSED: Unable to connect'), { code: 'ECONNREFUSED' });
  const NOW = Date.parse('2026-11-19T12:00:00.000Z');
  const booting: DevLock = { ...lock, startedAt: '2026-11-19T11:59:58.000Z' };
  const ask = {
    path: '/_x/db/migrate',
    resume: ['db', 'migrate'],
    read: (data: unknown) => ({ value: data }),
  };

  /** A clock that moves only when the command sleeps, and the lock each re-read finds. */
  function waiting(locks: readonly (DevLock | undefined)[]): DevWait & { slept: number[] } {
    let at = NOW;
    let read = 0;
    const slept: number[] = [];
    return {
      slept,
      now: () => at,
      sleep: async (ms) => {
        slept.push(ms);
        at += ms;
      },
      relock: async () => locks[Math.min(read++, locks.length - 1)],
    };
  }

  test('a refused connection to a holder that just started is waited out, then asked again', async () => {
    const wait = waiting([booting]);
    let calls = 0;
    const data = await askDev(
      booting,
      '/app/.x',
      ask,
      async () => {
        calls += 1;
        if (calls < 3) throw refusedConnection();
        return { ok: true, data: { applied: ['0001'] } };
      },
      wait,
    );
    expect(data).toEqual({ applied: ['0001'] });
    expect(wait.slept).toHaveLength(2);
  });

  test('a new child under the same supervisor is dialled on the port its own lock names', async () => {
    const child: DevLock = { ...booting, pid: 5555, port: 3222 };
    const asked: string[] = [];
    await askDev(
      { ...lock, startedAt: '2026-11-19T09:00:00.000Z' },
      '/app/.x',
      ask,
      async (url) => {
        asked.push(url);
        if (asked.length === 1) throw refusedConnection();
        return { ok: true, data: {} };
      },
      waiting([child]),
    );
    expect(asked).toEqual([
      'https://localhost:3111/_x/db/migrate',
      'https://localhost:3222/_x/db/migrate',
    ]);
  });

  test('a holder that has been up for hours and refuses is not booting: refused at once', async () => {
    const old: DevLock = { ...lock, startedAt: '2026-11-19T09:00:00.000Z' };
    const wait = waiting([old]);
    const refused = await refusal(
      askDev(old, '/app/.x', ask, () => Promise.reject(refusedConnection()), wait),
    );
    expect(refused.code).toBe('X_DEV_ALREADY_RUNNING');
    expect(wait.slept).toEqual([]);
  });

  test('a lock that stays gone ends the wait: the holder exited, and nothing is applied here', async () => {
    const wait = waiting([undefined]);
    const refused = await refusal(
      askDev(booting, '/app/.x', ask, () => Promise.reject(refusedConnection()), wait),
    );
    expect(refused.code).toBe('X_DEV_ALREADY_RUNNING');
    expect(refused.fix).toStartWith('x stop --json && x db migrate && x dev');
    expect(wait.slept.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(10_500);
  });

  test('a boot that never answers is bounded', async () => {
    // Each re-read finds a lock stamped "just now": a child that restarts for ever.
    let at = NOW;
    const wait: DevWait = {
      now: () => at,
      sleep: async (ms) => {
        at += ms;
      },
      relock: async () => ({ ...lock, startedAt: new Date(at).toISOString() }),
    };
    const refused = await refusal(
      askDev(booting, '/app/.x', ask, () => Promise.reject(refusedConnection()), wait),
    );
    expect(refused.code).toBe('X_DEV_ALREADY_RUNNING');
    expect(at - NOW).toBeLessThanOrEqual(121_000);
  });

  test('a request that died mid-flight is never sent twice: a rollback is not idempotent', async () => {
    const wait = waiting([booting]);
    let calls = 0;
    await refusal(
      askDev(
        booting,
        '/app/.x',
        ask,
        () => {
          calls += 1;
          return Promise.reject(new TypeError('socket closed'));
        },
        wait,
      ),
    );
    expect(calls).toBe(1);
  });
});

// Measured with two real processes against an app with CSRF protection on (every scaffold): the
// pipeline answered the bare POST `X_CSRF_BLOCKED` before the route ran, and the command read
// that 403 as "not a route of that x dev". The fixture app the in-process test boots has none.
describe('postJson', () => {
  test("proves same-origin the way a browser does, so an app's CSRF check lets the door answer", async () => {
    const seen: Record<string, string | null> = {};
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        seen['method'] = request.method;
        seen['sec-fetch-site'] = request.headers.get('sec-fetch-site');
        seen['origin'] = request.headers.get('origin');
        return Response.json({ ok: true, data: {} });
      },
    });
    try {
      allowHost(`localhost:${String(server.port)}`);
      expect(await postJson(`http://localhost:${String(server.port)}/_x/db/migrate`)).toEqual({
        ok: true,
        data: {},
      });
      expect(seen).toEqual({ method: 'POST', 'sec-fetch-site': 'same-origin', origin: null });
    } finally {
      await server.stop(true);
    }
  });
});
