import { afterEach, describe, expect, test } from 'bun:test';
import { rescope } from './client-scope';
import { clientTransport } from './client-transport';
import { UltimateError } from './errors';
import { onSessionLost, sessionIsLost, whileSessionHeld } from './session-lost';

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

async function refusedRead(code: string, status = 401, url = '/q/me'): Promise<void> {
  const settled = await clientTransport({
    method: 'GET',
    url,
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

  test("another origin's 401 says nothing about this page's session", async () => {
    rescope('user:1');
    await refusedRead('X_UNAUTHENTICATED', 401, 'https://api.elsewhere.example/q/me');
    await refusedRead('X_SESSION_EXPIRED', 401, '//api.elsewhere.example/q/me');
    expect(sessionIsLost()).toBe(false);
  });

  test("an absolute URL on the page's own origin is this page's", async () => {
    const had = Object.hasOwn(globalThis, 'location');
    const before: unknown = Reflect.get(globalThis, 'location');
    Reflect.set(globalThis, 'location', { origin: 'https://app.example' });
    try {
      rescope('user:1');
      await refusedRead('X_UNAUTHENTICATED', 401, 'https://app.example/q/me');
      expect(sessionIsLost()).toBe(true);
    } finally {
      if (had) Reflect.set(globalThis, 'location', before);
      else Reflect.deleteProperty(globalThis, 'location');
    }
  });

  test('a loss code on any status but 401 is not a loss', async () => {
    rescope('user:1');
    await refusedRead('X_UNAUTHENTICATED', 403);
    await refusedRead('X_SESSION_EXPIRED', 400);
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

describe('whileSessionHeld', () => {
  /** A run that counts its starts and stops. */
  function counted(): { starts: number; stops: number; start: () => () => void } {
    const run = {
      starts: 0,
      stops: 0,
      start: (): (() => void) => {
        run.starts += 1;
        return (): void => {
          run.stops += 1;
        };
      },
    };
    return run;
  }

  test('a loss stops the run, and the next signed-in principal starts it again', async () => {
    rescope('user:1');
    const run = counted();
    const dispose = whileSessionHeld(run.start);
    expect(run).toMatchObject({ starts: 1, stops: 0 });
    await refusedRead('X_UNAUTHENTICATED');
    expect(run).toMatchObject({ starts: 1, stops: 1 });
    rescope(null);
    expect(run.starts).toBe(1);
    rescope('user:2');
    expect(run).toMatchObject({ starts: 2, stops: 1 });
    await refusedRead('X_SESSION_EXPIRED');
    expect(run).toMatchObject({ starts: 2, stops: 2 });
    dispose();
    rescope('user:3');
    expect(run.starts).toBe(2);
  });

  test('started after the loss it waits, and a running one ignores a rescope', async () => {
    rescope('user:1');
    await refusedRead('X_UNAUTHENTICATED');
    const run = counted();
    const dispose = whileSessionHeld(run.start);
    expect(run.starts).toBe(0);
    rescope('user:2');
    rescope('user:3');
    expect(run).toMatchObject({ starts: 1, stops: 0 });
    dispose();
    dispose();
    expect(run.stops).toBe(1);
  });
});
