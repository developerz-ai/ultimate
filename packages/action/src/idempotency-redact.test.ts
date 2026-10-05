// The walk that decides what of an idempotent answer may rest in a store for a day. The store
// parity suite proves both stores keep its output; this one pins the walk's own edges.

import { describe, expect, test } from 'bun:test';
import { secret } from '@ultimat3/core';
import { IDEMPOTENCY_REDACT_MAX_DEPTH, restingAnswer } from './idempotency-redact';

describe('restingAnswer', () => {
  test('an answer with no secret key is the SAME reference, unflagged', () => {
    const answer = { id: 'ch_1', when: new Date(0), lines: [{ sku: 'a', qty: 1 }] };
    const resting = restingAnswer(answer);
    expect(resting.value).toBe(answer);
    expect(resting.redacted).toBe(false);
  });

  test('scalars and null pass through unflagged', () => {
    for (const value of [null, undefined, 0, 'x', true]) {
      expect(restingAnswer(value)).toEqual({ value, redacted: false });
    }
  });

  test('a key core redacts is replaced, its siblings kept, and the input left untouched', () => {
    const answer = { id: 'k1', apiKey: 'sk_live', refreshToken: 'rt', note: 'ok' };
    const resting = restingAnswer(answer);
    expect(resting).toEqual({
      value: { id: 'k1', apiKey: '[redacted]', refreshToken: '[redacted]', note: 'ok' },
      redacted: true,
    });
    expect(answer.apiKey).toBe('sk_live');
  });

  test('nested in arrays: only the path to the secret is copied', () => {
    const untouched = { sku: 'a' };
    const answer = { items: [untouched, { password: 'p' }] };
    const resting = restingAnswer(answer);
    expect(resting.value).toEqual({ items: [{ sku: 'a' }, { password: '[redacted]' }] });
    expect((resting.value as { items: unknown[] }).items[0]).toBe(untouched);
    expect(resting.redacted).toBe(true);
  });

  test('under a secret key a whole object is redacted; under another, only its secret fields', () => {
    expect(restingAnswer({ login: { password: 'p', user: 'u' } }).value).toEqual({
      login: { password: '[redacted]', user: 'u' },
    });
    expect(restingAnswer({ apiKey: { live: 'x' } }).value).toEqual({ apiKey: '[redacted]' });
  });

  test('a Secret box is redacted by value and flags the record', () => {
    expect(restingAnswer({ issued: secret('plain', 'token') })).toEqual({
      value: { issued: '[redacted]' },
      redacted: true,
    });
  });

  test('null or absent under a secret name carries nothing and is kept', () => {
    const answer = { resetToken: null, password: undefined };
    expect(restingAnswer(answer)).toEqual({ value: answer, redacted: false });
  });

  test('past the depth bound the subtree is redacted, never kept uninspected', () => {
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < IDEMPOTENCY_REDACT_MAX_DEPTH + 2; i += 1) deep = { next: deep };
    expect(restingAnswer(deep).redacted).toBe(true);
  });

  // Security review of #591: the walk must judge what the STORE will write, and `JSON.stringify`
  // calls app code the walk never saw — a `toJSON`, a getter read a second time. Fail closed.
  class Creds {
    readonly label = 'main';
    toJSON(): unknown {
      return { apiKey: 'sk_live_1' };
    }
  }

  test('a nested object with its own toJSON is redacted, never handed to the serializer', () => {
    const resting = restingAnswer({ id: 'a', creds: new Creds() });
    expect(resting).toEqual({ value: { id: 'a', creds: '[redacted]' }, redacted: true });
    expect(JSON.stringify(resting.value)).not.toContain('sk_live_1');
  });

  test('a toJSON on a plain object, an array or a function is redacted too', () => {
    const plain = { toJSON: () => ({ apiKey: 'sk_live_1' }) };
    const list = Object.assign([1], { toJSON: () => ({ apiKey: 'sk_live_1' }) });
    const fn = Object.assign(() => 1, { toJSON: () => ({ apiKey: 'sk_live_1' }) });
    for (const value of [plain, list, fn]) {
      const resting = restingAnswer({ value });
      expect(resting.redacted).toBe(true);
      expect(JSON.stringify(resting.value)).not.toContain('sk_live_1');
    }
  });

  test('a Map and a Set are redacted rather than kept live or stringified to {}', () => {
    expect(restingAnswer({ m: new Map([['apiKey', 'sk']]) })).toEqual({
      value: { m: '[redacted]' },
      redacted: true,
    });
    expect(restingAnswer({ s: new Set(['sk']) })).toEqual({
      value: { s: '[redacted]' },
      redacted: true,
    });
  });

  test('a getter is read ONCE: the stored copy holds what the walk judged', () => {
    let reads = 0;
    const answer = {
      id: 'a',
      get data(): unknown {
        reads += 1;
        return reads === 1 ? { ok: true } : { apiKey: 'sk_live_1' };
      },
    };
    const resting = restingAnswer(answer);
    expect(JSON.stringify(resting.value)).toBe('{"id":"a","data":{"ok":true}}');
    expect(resting.redacted).toBe(false);
  });

  test('a getter on an array index is read once too', () => {
    let reads = 0;
    const list: unknown[] = [];
    Object.defineProperty(list, 0, {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? 'ok' : { apiKey: 'sk_live_1' };
      },
    });
    expect(JSON.stringify(restingAnswer(list).value)).toBe('["ok"]');
  });

  test('a Date subclass that overrides toJSON is not trusted as a Date', () => {
    class Leaky extends Date {
      override toJSON(): string {
        return 'sk_live_1';
      }
    }
    expect(restingAnswer({ at: new Leaky(0) }).redacted).toBe(true);
  });

  test('plain data with a null-prototype object stays the same reference', () => {
    const bare = Object.assign(Object.create(null) as object, { a: 1 });
    const answer = { bare, list: [1, 'two', null, { at: new Date(0) }] };
    expect(restingAnswer(answer)).toEqual({ value: answer, redacted: false });
    expect(restingAnswer(answer).value).toBe(answer);
  });

  test('a cycle does not recurse forever', () => {
    const answer: Record<string, unknown> = { id: 'a' };
    answer['self'] = answer;
    expect(restingAnswer(answer)).toEqual({ value: answer, redacted: false });
  });
});
