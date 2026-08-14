// `evaluate.ts` is the single entry point every surface calls; policy.test.ts and
// policy-args.test.ts exercise it end to end through `can()`/combinators. This file covers
// the pure helpers `codeOf()`/`reasonOf()` directly, since nothing else asserts on them in
// isolation from a full evaluation.
import { describe, expect, test } from 'bun:test';
import { codeOf, reasonOf } from './evaluate';
import { ALLOWED, denied } from './policy';

describe('reasonOf() / codeOf()', () => {
  test('an allowed decision has no reason and no code', () => {
    expect(reasonOf(ALLOWED)).toBeNull();
    expect(codeOf(ALLOWED)).toBeNull();
  });

  test('a denied decision surfaces its reason and code', () => {
    const decision = denied('not the author', 'X_FORBIDDEN');
    expect(reasonOf(decision)).toBe('not the author');
    expect(codeOf(decision)).toBe('X_FORBIDDEN');
  });

  test('denied() defaults the code to X_FORBIDDEN when not given', () => {
    const decision = denied('no actor for post:publish');
    expect(codeOf(decision)).toBe('X_FORBIDDEN');
  });

  test('a non-default code round-trips through codeOf()', () => {
    const decision = denied('no actor for post:publish', 'X_UNAUTHENTICATED');
    expect(codeOf(decision)).toBe('X_UNAUTHENTICATED');
  });
});
