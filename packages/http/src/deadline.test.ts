// `signal` appeared nowhere in this package, so `ctx.signal` was undefined, `throwIfAborted()`
// threw a TypeError instead of unwinding, and a hung vendor call held its connection and its
// pool slot until the process died. This is the timer that ends that.
import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { REQUEST_TIMEOUT_HEADER, resolveTimeoutMs, startDeadline } from './deadline';

const config = (requestTimeoutMs: number) =>
  defineHttpConfig({ rateLimit: { scope: 'process' }, requestTimeoutMs });

describe('resolveTimeoutMs', () => {
  test('the configured budget with no header', () => {
    expect(resolveTimeoutMs(new Headers(), config(30_000))).toBe(30_000);
  });

  test('a caller may shorten it', () => {
    expect(resolveTimeoutMs(new Headers({ [REQUEST_TIMEOUT_HEADER]: '500' }), config(30_000))).toBe(
      500,
    );
  });

  // The only thing an inbound deadline could buy an attacker is a slower request of their own,
  // so it is honoured without trusting the proxy — but never upward.
  test('a caller may NOT lengthen it', () => {
    expect(
      resolveTimeoutMs(new Headers({ [REQUEST_TIMEOUT_HEADER]: '600000' }), config(30_000)),
    ).toBe(30_000);
  });

  test('nonsense in the header is ignored, not thrown on', () => {
    expect(
      resolveTimeoutMs(new Headers({ [REQUEST_TIMEOUT_HEADER]: 'soon' }), config(30_000)),
    ).toBe(30_000);
    expect(resolveTimeoutMs(new Headers({ [REQUEST_TIMEOUT_HEADER]: '-5' }), config(30_000))).toBe(
      30_000,
    );
  });
});

describe('startDeadline', () => {
  const start = (requestTimeoutMs: number) =>
    startDeadline({
      headers: new Headers(),
      config: config(requestTimeoutMs),
      method: 'POST',
      pathname: '/slow',
    });

  test('aborts the signal and rejects with X_TIMEOUT when the budget passes', async () => {
    const deadline = start(5);
    expect(deadline.signal.aborted).toBe(false);
    const outcome = await deadline.expired?.catch((error: unknown) => error);
    expect(deadline.signal.aborted).toBe(true);
    expect((outcome as { code: string }).code).toBe('X_TIMEOUT');
    expect((outcome as { cause: string }).cause).toContain('POST /slow');
    deadline.clear();
  });

  test('0 means no deadline at all — no timer, no signal to abort', () => {
    const deadline = start(0);
    expect(deadline.expired).toBeUndefined();
    expect(deadline.timeoutMs).toBe(0);
    expect(deadline.signal.aborted).toBe(false);
    deadline.clear();
  });

  // A live timer keeps the event loop from going idle, so a process that answered every request
  // would still refuse to exit for the length of one timeout.
  test('clear() stops the timer before it can fire', async () => {
    const deadline = start(5);
    deadline.clear();
    await Bun.sleep(15);
    expect(deadline.signal.aborted).toBe(false);
  });
});
