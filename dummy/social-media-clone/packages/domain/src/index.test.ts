// unit — pure functions, no fixtures. Every rule here is enforced twice (in the app on write, and
// as a Postgres CHECK generated from the same declaration), so a bug here is a bug in both.

import { expect, test } from 'bun:test';
import { hasRespondedCoherently, isValidHandle, isVisibleAudience, MAX_HANDLE } from './index';

test('a handle is lowercase, bounded, and never starts or ends with a separator', () => {
  expect(isValidHandle('ada')).toBe(true);
  expect(isValidHandle('ada_okonjo9')).toBe(true);

  // A URL that differs only in case is two URLs, so uppercase is refused rather than folded.
  expect(isValidHandle('Ada')).toBe(false);
  expect(isValidHandle('_ada')).toBe(false);
  expect(isValidHandle('ada_')).toBe(false);
  expect(isValidHandle('a b')).toBe(false);
  expect(isValidHandle('')).toBe(false);
  expect(isValidHandle('a'.repeat(MAX_HANDLE + 1))).toBe(false);
});

test('the audience ladder widens exactly once, at `friends`', () => {
  // `public` ignores friendship; `friends` is the only value that consults it; `private` refuses
  // everyone — the author's own case is decided by the policy, not by this function.
  expect(isVisibleAudience('public', false)).toBe(true);
  expect(isVisibleAudience('friends', true)).toBe(true);
  expect(isVisibleAudience('friends', false)).toBe(false);
  expect(isVisibleAudience('private', true)).toBe(false);
});

test('an answered friendship must record when, and a pending one must not', () => {
  const at = new Date('2026-08-11T00:00:00Z');
  expect(hasRespondedCoherently('pending', null)).toBe(true);
  expect(hasRespondedCoherently('accepted', at)).toBe(true);
  expect(hasRespondedCoherently('declined', at)).toBe(true);

  // The two states this CHECK exists to make unrepresentable.
  expect(hasRespondedCoherently('accepted', null)).toBe(false);
  expect(hasRespondedCoherently('pending', at)).toBe(false);
});
