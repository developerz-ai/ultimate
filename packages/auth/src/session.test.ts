import { describe, expect, test } from 'bun:test';
import { type FrozenClock, frozenClock } from '@ultimat3/core';
import type { SessionStore } from './adapter';
import { AuthError } from './errors';
import { MemoryAdapter } from './memory-adapter';
import {
  createSession,
  DEFAULT_SESSION_POLICY,
  idleSlideMs,
  listDevices,
  readSessionCookie,
  revokeSession,
  type SessionPolicy,
  type SessionRuntime,
  sessionCookie,
  verifySession,
} from './session';

const POLICY: SessionPolicy = {
  ...DEFAULT_SESSION_POLICY,
  absoluteTtlMs: 60_000,
  idleTtlMs: 30_000,
};

interface TestRuntime extends SessionRuntime {
  readonly clock: FrozenClock;
}

const runtime = (startMs = 0): TestRuntime => ({
  store: new MemoryAdapter(),
  policy: POLICY,
  clock: frozenClock(startMs),
});

const caught = async (fn: () => Promise<unknown>): Promise<AuthError> => {
  try {
    await fn();
  } catch (error) {
    if (error instanceof AuthError) return error;
    throw error;
  }
  throw new Error('expected the call to throw');
};

describe('session', () => {
  test('absolute expiry rejects even when idle expiry is repeatedly refreshed', async () => {
    const rt = runtime();
    const { token } = await createSession(rt, { userId: 'user-1' });

    // Three touches, each well inside the 30s idle window, but the 60s ceiling does not move.
    rt.clock.advance(20_000);
    await verifySession(rt, token);
    rt.clock.advance(20_000);
    await verifySession(rt, token);
    rt.clock.advance(20_000);

    const error = await caught(() => verifySession(rt, token));
    expect(error.code).toBe('X_SESSION_EXPIRED');
    expect(error.cause).toContain('absolute');
  });

  test('the idle expiry rejects on its own, long before the absolute one', async () => {
    const rt = runtime();
    const { token } = await createSession(rt, { userId: 'user-1' });

    rt.clock.advance(31_000);
    const error = await caught(() => verifySession(rt, token));
    expect(error.code).toBe('X_SESSION_EXPIRED');
    expect(error.cause).toContain('idle');
  });

  test('a live session verifies and slides its idle window forward', async () => {
    const rt = runtime();
    const { session, token } = await createSession(rt, { userId: 'user-1', ip: '203.0.113.7' });
    rt.clock.advance(10_000);
    const touched = await verifySession(rt, token);
    expect(touched.id).toBe(session.id);
    expect(touched.lastSeenAt.getTime()).toBe(10_000);
  });

  test('a forged token never resolves and the stored row holds no plaintext', async () => {
    const rt = runtime();
    const { session, token } = await createSession(rt, { userId: 'user-1' });
    const secret = token.slice(token.indexOf('.') + 1);
    expect(JSON.stringify(session)).not.toContain(secret);

    const error = await caught(() => verifySession(rt, `${session.id}.forged-secret`));
    expect(error.code).toBe('X_UNAUTHENTICATED');
  });

  test('revocation removes the session from the device list', async () => {
    const rt = runtime();
    const first = await createSession(rt, { userId: 'user-1', userAgent: 'laptop' });
    rt.clock.advance(1_000);
    const second = await createSession(rt, { userId: 'user-1', userAgent: 'phone' });

    expect(await listDevices(rt, 'user-1')).toHaveLength(2);

    expect(await revokeSession(rt, first.session.id)).toBe(true);
    const devices = await listDevices(rt, 'user-1', second.session.id);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.sessionId).toBe(second.session.id);
    expect(devices[0]?.userAgent).toBe('phone');
    expect(devices[0]?.current).toBe(true);
  });

  test('the cookie carries every attribute the __Host- prefix requires', () => {
    const cookie = sessionCookie('token-value', POLICY);
    expect(cookie.startsWith('__Host-x_session=token-value;')).toBe(true);
    for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=60']) {
      expect(cookie).toContain(attribute);
    }
    expect(cookie).not.toContain('Domain=');
  });

  test('a percent-escaped cookie value is decoded on the way back in', () => {
    const request = new Request('https://app.test/', {
      headers: { cookie: `${POLICY.cookieName}=a%20b` },
    });
    expect(readSessionCookie(request, POLICY)).toBe('a b');
  });

  /**
   * The header is whatever the client sent. `decodeURIComponent('%')` throws a bare `URIError`,
   * which every caller of this parser would have propagated as a 500 — a request carrying a
   * malformed cookie must fail as "no valid session", the same as one carrying junk.
   */
  test('a malformed percent-escape reads back raw instead of throwing', () => {
    const request = new Request('https://app.test/', {
      headers: { cookie: `${POLICY.cookieName}=%` },
    });
    expect(readSessionCookie(request, POLICY)).toBe('%');
  });

  test('a malformed cookie value never verifies as a session', async () => {
    const rt = runtime();
    await createSession(rt, { userId: 'user-1' });
    const request = new Request('https://app.test/', {
      headers: { cookie: `${POLICY.cookieName}=%` },
    });
    const raw = readSessionCookie(request, POLICY) ?? '';
    expect((await caught(() => verifySession(rt, raw))).code).toBe('X_UNAUTHENTICATED');
  });
});

/**
 * The failure case first: before `idleSlideMs`, `verifySession` wrote on EVERY authenticated
 * request. One request was a SELECT, an `UPDATE … RETURNING *` and a second SELECT before the
 * app's own first query — 20k writes a second on one hot table at 20k rps, presenting as "the
 * database is slow" rather than "authentication is a write path".
 */
describe('the idle window slides, it does not grind', () => {
  /** Counts writes without changing behaviour: the real adapter still does the work. */
  const counting = (base: MemoryAdapter): { store: SessionStore; writes: () => number } => {
    let writes = 0;
    const store: SessionStore = {
      getSession: (id) => base.getSession(id),
      createSession: (session) => base.createSession(session),
      updateSession: (id, patch) => {
        writes += 1;
        return base.updateSession(id, patch);
      },
      deleteSession: (id) => base.deleteSession(id),
      deleteOtherSessions: (userId, keep) => base.deleteOtherSessions(userId, keep),
      listSessions: (userId) => base.listSessions(userId),
    };
    return { store, writes: () => writes };
  };

  const slidingRuntime = (clock: FrozenClock) => {
    const counted = counting(new MemoryAdapter());
    // idleTtlMs 30s / IDLE_SLIDE_DIVISOR 20 = a 1.5s slide. The absolute ceiling is widened so
    // these tests measure the idle window and only the idle window.
    const policy: SessionPolicy = { ...POLICY, absoluteTtlMs: 3_600_000 };
    return { runtime: { store: counted.store, policy, clock }, writes: counted.writes };
  };

  test('a second request inside the slide window issues no write at all', async () => {
    const clock = frozenClock(0);
    const { runtime: rt, writes } = slidingRuntime(clock);
    const issued = await createSession(rt, { userId: 'user-1' });
    const before = writes();

    clock.advance(500);
    await verifySession(rt, issued.token);
    clock.advance(500);
    await verifySession(rt, issued.token);
    expect(writes()).toBe(before);

    // Past the slide, exactly one write moves the window forward.
    clock.advance(1_000);
    const slid = await verifySession(rt, issued.token);
    expect(writes()).toBe(before + 1);
    expect(slid.lastSeenAt.getTime()).toBe(2_000);
  });

  test('the window still slides, so a session used steadily never idles out', async () => {
    const clock = frozenClock(0);
    const { runtime: rt } = slidingRuntime(clock);
    const issued = await createSession(rt, { userId: 'user-1' });
    // idleTtlMs is 30s; ten hops of 20s each would expire it if nothing ever moved lastSeenAt.
    for (let hop = 0; hop < 10; hop += 1) {
      clock.advance(20_000);
      await verifySession(rt, issued.token);
    }
    expect((await rt.store.getSession(issued.session.id))?.lastSeenAt.getTime()).toBe(200_000);
  });

  test('a changed address is written immediately, slide window or not', async () => {
    const clock = frozenClock(0);
    const { runtime: rt, writes } = slidingRuntime(clock);
    const issued = await createSession(rt, { userId: 'user-1', ip: '203.0.113.7' });
    const before = writes();
    clock.advance(100);
    // Well inside the slide — but a device list and an incident review read this row.
    const touched = await verifySession(rt, issued.token, { ip: '198.51.100.9' });
    expect(writes()).toBe(before + 1);
    expect(touched.ip).toBe('198.51.100.9');
    // The window itself did NOT move: only the observation did.
    expect(touched.lastSeenAt.getTime()).toBe(0);
  });

  test('idleSlideMs is derived from idleTtlMs, so shortening the TTL cannot outrun it', () => {
    expect(idleSlideMs({ ...DEFAULT_SESSION_POLICY, idleTtlMs: 60 * 60 * 1000 })).toBe(180_000);
    // An explicit value wins, including zero — which restores the write-every-request behaviour
    // for an app that would rather pay for exact idle expiry.
    expect(idleSlideMs({ ...DEFAULT_SESSION_POLICY, idleSlideMs: 0 })).toBe(0);
  });
});
