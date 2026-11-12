// Single responsibility: pins the WORK the redaction verdict costs — the credential regex runs once
// per distinct key, the memo is bounded, and memoising changed no verdict (`redactKeys` included).
import { afterEach, expect, spyOn, test } from 'bun:test';
import { CREDENTIAL_NAME, isRedactedKey, REDACTION_MEMO_SIZE, redactKeys } from './logger-redact';

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** Count the regex's runs. A key on the exact-name list never reaches it, so probes avoid those. */
function countRegex(): { readonly calls: () => number } {
  const spy = spyOn(CREDENTIAL_NAME, 'test');
  spies.push(spy);
  return { calls: () => spy.mock.calls.length };
}

test('the credential regex runs once per distinct key, however often the key is asked', () => {
  const regex = countRegex();
  for (let i = 0; i < 5; i += 1) {
    isRedactedKey('memoProbeOrderId');
    isRedactedKey('memoProbeResetToken');
  }
  expect(regex.calls()).toBe(2);
});

test('memoising changed no verdict: the first answer and every later one agree', () => {
  const cases: readonly (readonly [string, boolean])[] = [
    ['memoVerdictPassword', true],
    ['memo_verdict_reset_token', true],
    ['MEMO-VERDICT-DATABASE-URL', true],
    ['memoVerdictIdempotencyToken', false],
    ['memoVerdictMaxTokens', false],
    ['memoVerdictCacheKey', false],
  ];
  for (const [key, verdict] of cases) {
    expect([key, isRedactedKey(key)]).toEqual([key, verdict]);
    expect([key, isRedactedKey(key)]).toEqual([key, verdict]);
  }
});

test('redactKeys() overrules a verdict already memoised as readable', () => {
  expect(isRedactedKey('memoLateCustomerRef')).toBe(false);
  redactKeys(['memoLateCustomerRef']);
  expect(isRedactedKey('memoLateCustomerRef')).toBe(true);
});

test('the memo is bounded: past its size the oldest verdict is asked again, not kept forever', () => {
  // A key is caller data (a request body's own keys reach `redactFields`), so an unbounded memo
  // is a memory leak an attacker sizes.
  expect(REDACTION_MEMO_SIZE).toBe(4096);
  isRedactedKey('memoBoundFirst');
  for (let i = 0; i < REDACTION_MEMO_SIZE; i += 1) isRedactedKey(`memoBoundFill${i}`);
  const regex = countRegex();
  isRedactedKey('memoBoundFirst');
  expect(regex.calls()).toBe(1);
});
