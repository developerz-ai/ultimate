// What the cross-instance invalidation hop reports when its transport or a peer's frame fails.
// Split from `dev-cache.test.ts` at the 500-line ceiling: that file's subject is which TIERS a boot
// registers, and this one's is one renderer that must never throw inside the loop it protects.

import { describe, expect, test } from 'bun:test';
import { broadcastErrorText } from './dev-cache';

/**
 * What the cross-instance invalidation hop writes when its transport or a peer's frame fails. Only
 * ever a log field — and still total, because it runs INSIDE the `try` that keeps the subscriber
 * loop alive: a throw here ends cross-instance invalidation for the whole process, quietly, which
 * is the failure that `try` exists to prevent.
 */
describe('unit · what a failed broadcast hop reports', () => {
  test('an Error keeps its message', () => {
    expect(broadcastErrorText(new TypeError('redis went away'))).toContain('redis went away');
  });

  // `error instanceof Error ? error.message : 'unknown error'` was the old form, so a driver that
  // rejected with a string — which every `Promise.reject('…')` in a transport does — reported the
  // words "unknown error" and nothing else.
  test('a non-Error throw is rendered, never flattened to "unknown error"', () => {
    expect(broadcastErrorText('ECONNRESET')).toContain('ECONNRESET');
    expect(broadcastErrorText('ECONNRESET')).not.toBe('unknown error');
    expect(broadcastErrorText({ code: 'ECONNRESET' })).not.toBe('unknown error');
  });

  test('a message getter that throws is rendered, never re-thrown', () => {
    const hostile = new Error('unused');
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new TypeError('message is a trap');
      },
    });
    expect(() => broadcastErrorText(hostile)).not.toThrow();
    expect(broadcastErrorText(hostile)).not.toContain('message is a trap');
  });

  test('and a Proxy that traps getPrototypeOf is rendered too', () => {
    const trap = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new TypeError('no prototype for you');
        },
      },
    );
    expect(() => broadcastErrorText(trap)).not.toThrow();
  });
});
