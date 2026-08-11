import { describe, expect, test } from 'bun:test';
import { type FrozenClock, frozenClock } from '@ultimat3/core';
import { AuthError } from './errors';
import { MemoryAdapter } from './memory-adapter';
import {
  createSession,
  DEFAULT_SESSION_POLICY,
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
