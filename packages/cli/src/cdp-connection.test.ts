// The wire, against a fake socket. What a real browser cannot prove cheaply: that a reply is
// matched to its own call and not to the one before it, that a deadline fires, that an error frame
// becomes a coded refusal, and that a close settles everything still in flight at once.

import { afterEach, describe, expect, test } from 'bun:test';
import { cdpConnect } from './cdp-connection';

/** One frame, as the browser would send it. */
interface Frame {
  readonly id?: number;
  readonly method?: string;
  readonly sessionId?: string;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

const real = globalThis.WebSocket;
let live: FakeSocket | undefined;

/**
 * `cdpConnect` reads `WebSocket` off the global, so the seam is the global — there is no factory
 * to inject, and adding one would be a second way to build a connection (axiom 1) for the benefit
 * of a test alone.
 */
class FakeSocket {
  onopen: (() => void) | undefined;
  onmessage: ((event: { data: string }) => void) | undefined;
  onclose: (() => void) | undefined;
  onerror: (() => void) | undefined;
  readonly sent: string[] = [];
  closeCalls = 0;

  constructor(readonly url: string) {
    live = this;
    // A microtask, not a timer: the handshake awaits `onopen`, and a synchronous call from the
    // constructor would fire before the caller has assigned it.
    queueMicrotask(() => this.onopen?.());
  }

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {
    this.closeCalls += 1;
  }

  reply(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  raw(data: string): void {
    this.onmessage?.({ data });
  }
}

const install = (): void => {
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
};

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = real;
  live = undefined;
});

const socket = (): FakeSocket => {
  if (live === undefined) expect.unreachable('the connection constructed no socket');
  return live;
};

const parsed = (text: string): Record<string, unknown> =>
  JSON.parse(text) as Record<string, unknown>;

describe('cdpConnect', () => {
  test('refuses an endpoint that is not a WebSocket url, before constructing one', async () => {
    install();
    const thrown = await cdpConnect({ endpoint: 'http://127.0.0.1:9222', timeoutMs: 50 }).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { code?: string }).code).toBe('X_INVARIANT');
    expect(live).toBeUndefined();
  });

  test('matches each reply to its own call, in whatever order they arrive', async () => {
    install();
    const connection = await cdpConnect({ endpoint: 'ws://x/1', timeoutMs: 1000 });

    const first = connection.send('Page.enable', {}, 'session-a');
    const second = connection.send('Runtime.evaluate', { expression: '1' }, 'session-a');

    const ids = socket().sent.map((text) => parsed(text)['id']);
    expect(ids).toEqual([1, 2]);
    expect(parsed(socket().sent[1] ?? '')['sessionId']).toBe('session-a');

    // Out of order deliberately: correlation is by `id`, so the SECOND call must not take the
    // first reply — which is exactly what a queue-shaped implementation would do.
    socket().reply({ id: 2, result: { value: 'second' } });
    socket().reply({ id: 1, result: { value: 'first' } });

    expect((await first).result).toEqual({ value: 'first' });
    expect((await second).result).toEqual({ value: 'second' });
    connection.close();
  });

  test('an error frame becomes X_CDP_CALL_FAILED carrying the browser’s own message', async () => {
    install();
    const connection = await cdpConnect({ endpoint: 'ws://x/1', timeoutMs: 1000 });

    const call = connection.send('Page.navigate');
    socket().reply({ id: 1, error: { code: -32000, message: 'Cannot navigate to invalid URL' } });

    const thrown = await call.catch((error: unknown) => error);
    expect((thrown as { code?: string }).code).toBe('X_CDP_CALL_FAILED');
    expect((thrown as { cause?: string }).cause).toContain('Cannot navigate to invalid URL');
    connection.close();
  });

  test('a call that never answers times out naming itself', async () => {
    install();
    const connection = await cdpConnect({ endpoint: 'ws://x/1', timeoutMs: 20 });

    const thrown = await connection.send('Runtime.evaluate').catch((error: unknown) => error);

    expect((thrown as { code?: string }).code).toBe('X_CDP_TIMEOUT');
    expect((thrown as { cause?: string }).cause).toContain('Runtime.evaluate');
    connection.close();
  });

  test('a close settles every in-flight call at once, rather than one deadline each', async () => {
    install();
    // A deadline far past the test's own budget: if close did not settle these, the test would
    // time out rather than fail, which is the failure this assertion exists to make loud.
    const connection = await cdpConnect({ endpoint: 'ws://x/1', timeoutMs: 600_000 });
    const calls = [connection.send('A'), connection.send('B'), connection.send('C')];

    connection.close();

    for (const call of calls) {
      const thrown = await call.catch((error: unknown) => error);
      expect((thrown as { code?: string }).code).toBe('X_CDP_CALL_FAILED');
    }
    expect(socket().closeCalls).toBe(1);
  });

  test('a call after close is refused rather than queued into a dead socket', async () => {
    install();
    const connection = await cdpConnect({ endpoint: 'ws://x/1', timeoutMs: 1000 });
    connection.close();

    const thrown = await connection.send('Page.enable').catch((error: unknown) => error);

    expect((thrown as { cause?: string }).cause).toContain('already closed');
  });

  test('a socket the browser closes settles the calls waiting on it', async () => {
    install();
    const connection = await cdpConnect({ endpoint: 'ws://x/1', timeoutMs: 600_000 });
    const call = connection.send('Page.enable');

    socket().onclose?.();

    const thrown = await call.catch((error: unknown) => error);
    expect((thrown as { cause?: string }).cause).toContain('the browser closed');
  });

  test('an unparseable frame and an event are ignored rather than failing a call', async () => {
    install();
    const connection = await cdpConnect({ endpoint: 'ws://x/1', timeoutMs: 1000 });
    const call = connection.send('Page.enable');

    socket().raw('not json at all');
    socket().reply({ method: 'Page.frameStartedLoading', params: {} } as Frame);
    socket().reply({ id: 999, result: { stray: true } });
    socket().reply({ id: 1, result: { ok: true } });

    expect((await call).result).toEqual({ ok: true });
    connection.close();
  });

  test('once resolves true on its own event and ignores another session’s', async () => {
    install();
    const connection = await cdpConnect({ endpoint: 'ws://x/1', timeoutMs: 1000 });

    const waiting = connection.once('Page.loadEventFired', 'mine', 5_000);
    socket().reply({ method: 'Page.loadEventFired', sessionId: 'theirs' });
    socket().reply({ method: 'Page.frameStoppedLoading', sessionId: 'mine' });
    socket().reply({ method: 'Page.loadEventFired', sessionId: 'mine' });

    expect(await waiting).toBe(true);
    connection.close();
  });

  test('once answers false at its deadline rather than throwing', async () => {
    install();
    const connection = await cdpConnect({ endpoint: 'ws://x/1', timeoutMs: 1000 });

    expect(await connection.once('Page.loadEventFired', undefined, 10)).toBe(false);
    connection.close();
  });

  test('once on a closed connection answers false, not a hang', async () => {
    install();
    const connection = await cdpConnect({ endpoint: 'ws://x/1', timeoutMs: 1000 });
    connection.close();

    expect(await connection.once('Page.loadEventFired', undefined, 600_000)).toBe(false);
  });
});
