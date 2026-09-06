// The declaration half of a problem document's `meta`: what an app may declare, what it may not,
// and the copy that leaves the process. What `toProblem` does with the answer is
// `error-facts.test.ts`'s — this file never builds a document.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  MAX_PROBLEM_META_BYTES,
  problemMetaKeysFor,
  registerProblemMeta,
  resetProblemMeta,
  wireMeta,
} from './problem-meta';

describe('registerProblemMeta', () => {
  afterEach(resetProblemMeta);

  test('an undeclared code carries nothing, which is every framework code', () => {
    expect(problemMetaKeysFor('X_RATE_LIMITED')).toBeUndefined();
    expect(problemMetaKeysFor('X_SESSION_CHECKOUT_BUSY')).toBeUndefined();
  });

  test('a declared code answers its keys, copied rather than aliased', () => {
    const keys = ['sessionId', 'title'];
    registerProblemMeta({ X_SESSION_CHECKOUT_BUSY: keys });
    keys.push('state');
    expect(problemMetaKeysFor('X_SESSION_CHECKOUT_BUSY')).toEqual(['sessionId', 'title']);
  });

  test('the framework’s own codes are not negotiable — their meta is operator-only', () => {
    // `bodyInvalid` puts the fragment the parser choked on in `meta`; the limiter puts its key.
    expect(() => registerProblemMeta({ X_BODY_INVALID: ['excerpt'] })).toThrow(
      'X_PROBLEM_META_INVALID',
    );
    expect(() => registerProblemMeta({ X_RATE_LIMITED: ['key'] })).toThrow(
      'X_PROBLEM_META_INVALID',
    );
  });

  test('a prototype name is not a framework code — the table is read by own key', () => {
    // `Object.keys(ERROR_STATUS)` never lists `toString`, so the refusal below is the KEY rule's.
    expect(() => registerProblemMeta({ toString: ['x'] })).not.toThrow();
    expect(problemMetaKeysFor('toString')).toEqual(['x']);
  });

  test('`issues` and `__proto__` are refused by name; so is an empty list', () => {
    expect(() => registerProblemMeta({ X_APP: ['issues'] })).toThrow('top level');
    expect(() => registerProblemMeta({ X_APP: ['__proto__'] })).toThrow('X_PROBLEM_META_INVALID');
    expect(() => registerProblemMeta({ X_APP: [] })).toThrow('empty');
    expect(() => registerProblemMeta({ X_APP: ['not a key'] })).toThrow('is not a meta key');
    expect(problemMetaKeysFor('X_APP')).toBeUndefined();
  });

  test('declaring the same code twice with a different list is refused; the same list is not', () => {
    registerProblemMeta({ X_APP: ['a', 'b'] });
    expect(() => registerProblemMeta({ X_APP: ['a', 'b'] })).not.toThrow();
    expect(() => registerProblemMeta({ X_APP: ['b', 'a'] })).toThrow('already declared');
    expect(problemMetaKeysFor('X_APP')).toEqual(['a', 'b']);
  });
});

describe('wireMeta', () => {
  const KEYS = ['sessionId', 'state', 'extra'] as const;

  test('copies the declared keys that are set, and nothing else', () => {
    const out = wireMeta({ sessionId: 's1', state: 'running', secret: 'hunter2' }, KEYS);
    expect(out).toEqual({ sessionId: 's1', state: 'running' });
    expect(out !== undefined && 'secret' in out).toBe(false);
  });

  test('nothing declared is set → absent, never {}', () => {
    expect(wireMeta({ secret: 'x' }, KEYS)).toBeUndefined();
    expect(wireMeta(undefined, KEYS)).toBeUndefined();
    expect(wireMeta('meta', KEYS)).toBeUndefined();
  });

  test('nested JSON survives whole, and an own __proto__ inside it is skipped', () => {
    const nested = JSON.parse('{"__proto__":{"admin":true},"ok":[1,"two",null,{"deep":false}]}');
    const out = wireMeta({ extra: nested }, KEYS);
    expect(out).toEqual({ extra: { ok: [1, 'two', null, { deep: false }] } });
    expect(Object.getPrototypeOf((out as { extra: object }).extra)).toBe(Object.prototype);
  });

  test('one value JSON cannot carry drops the WHOLE member, never a subset', () => {
    for (const bad of [
      () => undefined,
      10n,
      new Date(0),
      new Map(),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Symbol('s'),
      new (class Row {})(),
      undefined,
    ]) {
      expect(wireMeta({ sessionId: 's1', extra: bad }, KEYS)).toBeUndefined();
      expect(wireMeta({ sessionId: 's1', extra: { nested: bad } }, KEYS)).toBeUndefined();
      expect(wireMeta({ sessionId: 's1', extra: [bad] }, KEYS)).toBeUndefined();
    }
  });

  test('a cycle drops the member rather than looping', () => {
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    expect(wireMeta({ sessionId: 's1', extra: loop }, KEYS)).toBeUndefined();
    // A value reached TWICE without a cycle is fine — only a value that contains itself is one.
    const shared = { n: 1 };
    expect(wireMeta({ extra: [shared, shared] }, KEYS)).toEqual({ extra: [{ n: 1 }, { n: 1 }] });
  });

  test('past the byte cap the member is dropped whole, at the cap it is carried', () => {
    // `{"extra":"<n>"}` is 12 bytes of frame around the string.
    const frame = '{"extra":""}'.length;
    const fits = 'x'.repeat(MAX_PROBLEM_META_BYTES - frame);
    expect(wireMeta({ extra: fits }, KEYS)).toEqual({ extra: fits });
    expect(wireMeta({ extra: `${fits}x` }, KEYS)).toBeUndefined();
    // Multi-byte: the cap is BYTES on the wire, not characters.
    expect(wireMeta({ extra: 'é'.repeat(MAX_PROBLEM_META_BYTES - frame) }, KEYS)).toBeUndefined();
  });

  test('a meta that throws on read answers nothing rather than throwing', () => {
    const hostile = new Proxy(
      {},
      {
        has: () => true,
        get: () => {
          throw new TypeError('not for you');
        },
        getOwnPropertyDescriptor: () => {
          throw new TypeError('not for you');
        },
      },
    );
    expect(wireMeta(hostile, KEYS)).toBeUndefined();
  });
});
