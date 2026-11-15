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
  // A fresh name per run: `redactKeys` is process-wide, and a rerun in one process must start readable.
  const key = `memoLateCustomerRef${crypto.randomUUID().replaceAll('-', '')}`;
  expect(isRedactedKey(key)).toBe(false);
  redactKeys([key]);
  expect(isRedactedKey(key)).toBe(true);
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

test('a hostile key costs linear time: a request body names its own keys', () => {
  // 20,000 capitals then one non-match took 1.2 s through the segment split's camel-hump pass.
  const keys = [`${'A'.repeat(20_000)}_KEYX`, `${'A'.repeat(20_000)}b`, `${'aB'.repeat(10_000)}x`];
  const started = performance.now();
  for (const key of keys) isRedactedKey(key);
  expect(performance.now() - started).toBeLessThan(100);
});

test('a long key still ends in its credential word: the tail decides, the cut is no word start', () => {
  expect(isRedactedKey(`${'x'.repeat(200)}AdminPin`)).toBe(true);
  expect(isRedactedKey(`${'x'.repeat(61)}pin`)).toBe(false);
});
