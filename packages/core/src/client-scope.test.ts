import { afterEach, describe, expect, test } from 'bun:test';
import type { ClientScope } from './client-scope';
import { onRescope, rescope } from './client-scope';
import { scopeChanged } from './client-scope-error';
import { createFence, isSuperseded } from './generation-fence';
import { pageClient } from './record-sink';

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
});

describe('rescope', () => {
  test('a principal change bumps the epoch and notifies once, synchronously, with both scopes', () => {
    const seen: [ClientScope, ClientScope][] = [];
    onRescope((next, prev) => seen.push([next, prev]));
    rescope('user:1');
    expect(seen).toEqual([
      [
        { principal: 'user:1', epoch: 1 },
        { principal: undefined, epoch: 0 },
      ],
    ]);
    expect(pageClient().scope).toEqual({ principal: 'user:1', epoch: 1 });
  });

  test('the same principal again is not a change — no bump, no notification', () => {
    let calls = 0;
    onRescope(() => {
      calls += 1;
    });
    rescope('user:1');
    rescope('user:1');
    expect(calls).toBe(1);
    expect(pageClient().scope.epoch).toBe(1);
    rescope(null);
    expect(calls).toBe(2);
    expect(pageClient().scope).toEqual({ principal: null, epoch: 2 });
    rescope(null);
    expect(calls).toBe(2);
  });

  test('the unsubscribe stops the calls, and one throwing subscriber does not starve the rest', () => {
    const order: string[] = [];
    const off = onRescope(() => order.push('gone'));
    onRescope(() => {
      throw scopeChanged('a subscriber', 0, 1);
    });
    onRescope(() => order.push('after'));
    off();
    expect(() => rescope('user:2')).toThrow('X_CLIENT_SCOPE_CHANGED');
    expect(order).toEqual(['after']);
  });

  test('subscribers registered through another module copy are notified too', async () => {
    const other: { onRescope: typeof onRescope } = await import(`./client-scope.ts?copy=${'b'}`);
    let heard: string | null | undefined = 'nothing';
    other.onRescope((next) => {
      heard = next.principal;
    });
    rescope('user:3');
    expect(heard).toBe('user:3');
  });
});

test('an unscoped page becoming anonymous IS a change — nobody is not the anonymous visitor', () => {
  let calls = 0;
  onRescope(() => {
    calls += 1;
  });
  expect(pageClient().scope.principal).toBeUndefined();
  rescope(null);
  expect(calls).toBe(1);
  expect(pageClient().scope).toEqual({ principal: null, epoch: 1 });
});

describe('isSuperseded', () => {
  test('answers true for both supersessions and false for anything else', () => {
    const fence = createFence('a probe');
    const issued = fence.generation();
    fence.bump();
    let flight: unknown;
    try {
      fence.guard(issued);
    } catch (error) {
      flight = error;
    }
    expect(isSuperseded(flight)).toBe(true);
    expect(isSuperseded(scopeChanged('GET /x', 0, 1))).toBe(true);
    expect(isSuperseded(new TypeError('network'))).toBe(false);
  });
});
