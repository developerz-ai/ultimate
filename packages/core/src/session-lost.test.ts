import { afterEach, describe, expect, test } from 'bun:test';
import { rescope } from './client-scope';
import { clientTransport } from './client-transport';
import { UltimateError } from './errors';
import { onSessionLost, sessionIsLost } from './session-lost';

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
});

const refusing =
  (code: string, status = 401) =>
  async (): Promise<Response> =>
    new Response(JSON.stringify({ code, cause: 'no session', fix: 'sign in' }), {
      status,
      headers: { 'content-type': 'application/problem+json' },
    });

async function refusedRead(code: string, status = 401): Promise<void> {
  const settled = await clientTransport({
    method: 'GET',
    url: '/q/me',
    fetchImpl: refusing(code, status),
  }).then(
    () => 'answered',
    () => 'refused',
  );
  expect(settled).toBe('refused');
}

describe('onSessionLost', () => {
  test('a 401 on a page acting for a principal marks the loss, and fires once', async () => {
    rescope('user:1');
    let fired = 0;
    onSessionLost(() => {
      fired += 1;
    });
    expect(sessionIsLost()).toBe(false);
    await refusedRead('X_UNAUTHENTICATED');
    await refusedRead('X_SESSION_EXPIRED');
    expect(sessionIsLost()).toBe(true);
    expect(fired).toBe(1);
  });

  test('X_SESSION_EXPIRED is a loss too', async () => {
    rescope('user:1');
    await refusedRead('X_SESSION_EXPIRED');
    expect(sessionIsLost()).toBe(true);
  });

  test("an anonymous page's 401 is a wrong password, never a loss", async () => {
    rescope(null);
    let fired = 0;
    onSessionLost(() => {
      fired += 1;
    });
    await refusedRead('X_UNAUTHENTICATED');
    expect(sessionIsLost()).toBe(false);
    expect(fired).toBe(0);
  });

  test('an unscoped page, and any other refusal, mark nothing', async () => {
    await refusedRead('X_UNAUTHENTICATED');
    expect(sessionIsLost()).toBe(false);
    rescope('user:1');
    await refusedRead('X_FORBIDDEN', 403);
    expect(sessionIsLost()).toBe(false);
  });

  test('a late subscriber is told at once, and its disposer is harmless', async () => {
    rescope('user:1');
    await refusedRead('X_UNAUTHENTICATED');
    let fired = 0;
    const off = onSessionLost(() => {
      fired += 1;
    });
    expect(fired).toBe(1);
    off();
    off();
  });

  test('an unsubscribed listener is not called', async () => {
    rescope('user:1');
    let fired = 0;
    const off = onSessionLost(() => {
      fired += 1;
    });
    off();
    await refusedRead('X_UNAUTHENTICATED');
    expect(fired).toBe(0);
  });

  test('rescope clears the loss, so the next principal can lose it again', async () => {
    rescope('user:1');
    await refusedRead('X_UNAUTHENTICATED');
    expect(sessionIsLost()).toBe(true);
    rescope('user:2');
    expect(sessionIsLost()).toBe(false);
    let fired = 0;
    onSessionLost(() => {
      fired += 1;
    });
    await refusedRead('X_UNAUTHENTICATED');
    expect(fired).toBe(1);
  });

  test('a throwing listener neither stops the others nor replaces the refusal', async () => {
    rescope('user:1');
    const raised: unknown[] = [];
    const original = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (task: () => void): void => {
      try {
        task();
      } catch (error) {
        raised.push(error);
      }
    };
    try {
      let reached = false;
      const boom = new UltimateError({
        code: 'X_TEST_LISTENER',
        cause: 'a listener bug',
        fix: 'f',
      });
      onSessionLost(() => {
        throw boom;
      });
      onSessionLost(() => {
        reached = true;
      });
      await refusedRead('X_UNAUTHENTICATED');
      expect(reached).toBe(true);
      expect(raised).toEqual([boom]);
    } finally {
      globalThis.queueMicrotask = original;
    }
  });
});
