/**
 * unit — no socket. `problemError` reading a server's refusal: the title when this realm registered
 * none for the code, and the delay a 429 or 503 named — with no package's error table loaded, the
 * way an island that never imports `@ultimat3/http` meets an http refusal.
 */

import { describe, expect, test } from 'bun:test';
import { MAX_REMOTE_TITLE_LENGTH, problemError } from './client-problem';
import { clientTransport } from './client-transport';
import { statedDelayMs } from './error-retry';
import { retryDecision } from './retry';

const URL = '/api/posts';
const refusal = (body: Record<string, unknown>): string =>
  JSON.stringify({ code: 'X_REMOTE_ONLY_CODE', cause: 'c', fix: 'f', ...body });

describe('problemError — the title', () => {
  test('takes the body title for a code this realm never registered', () => {
    const error = problemError(429, refusal({ title: 'rate limit exhausted for this key' }), URL);
    expect(error.title).toBe('rate limit exhausted for this key');
    expect(error.message).toContain('rate limit exhausted for this key');
  });

  test('the registry wins where it has one: a server cannot retitle a code this realm owns', () => {
    const error = problemError(504, refusal({ code: 'X_TIMEOUT', title: 'something else' }), URL);
    expect(error.title).toBe('operation exceeded its deadline');
  });

  test('a missing, empty or non-string title falls back to the humanised code', () => {
    for (const title of [undefined, '', '   ', 42, { html: '<b>' }]) {
      expect(problemError(400, refusal({ title }), URL).title).toBe('remote only code');
    }
  });

  test('format characters are stripped: no bidi override or zero-width reorders what is shown', () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE, U+200B ZERO WIDTH SPACE, U+2066 LEFT-TO-RIGHT ISOLATE.
    const title = 'rate\u202E limit\u200B exhausted\u2066';
    expect(problemError(429, refusal({ title }), URL).title).toBe('rate limit exhausted');
    // A title made of nothing BUT format characters is blank, and falls back.
    expect(problemError(400, refusal({ title: '\u200B\u202E' }), URL).title).toBe(
      'remote only code',
    );
  });

  test('the cut lands on a code-point boundary, never inside a surrogate pair', () => {
    const emoji = '\u{1F600}';
    const title = emoji.repeat(MAX_REMOTE_TITLE_LENGTH + 5);
    const shown = problemError(400, refusal({ title }), URL).title;
    expect([...shown].length).toBe(MAX_REMOTE_TITLE_LENGTH);
    expect([...shown].every((char) => char === emoji)).toBe(true);
  });

  test('the title is display text: one line, length-capped', () => {
    const long = 'x'.repeat(MAX_REMOTE_TITLE_LENGTH * 3);
    expect(problemError(400, refusal({ title: long }), URL).title.length).toBe(
      MAX_REMOTE_TITLE_LENGTH,
    );
    // A control character becomes a space BEFORE the cap, so the cap is the length shown: a
    // newline escaped after cutting rendered as two characters, and 100 of them came out at 180.
    expect(problemError(400, refusal({ title: 'a\nb<script>' }), URL).title).toBe('a b<script>');
    const newlines = problemError(400, refusal({ title: `${'\n'.repeat(100)}x`.repeat(3) }), URL);
    expect([...newlines.title].length).toBeLessThanOrEqual(MAX_REMOTE_TITLE_LENGTH);
    expect(newlines.title).toBe('x x x');
  });
});

describe('problemError — the stated delay', () => {
  test('a 429 that named a delay is retry-after, and a retry waits exactly that', () => {
    const error = problemError(429, refusal({}), URL, 2);
    expect(error.retry).toBe('retry-after');
    expect(error.meta?.['retryAfterSeconds']).toBe(2);
    const policy = {
      attempts: 3,
      base: 50,
      max: 60_000,
      factor: 2,
      curve: 'exponential' as const,
      jitter: 'none' as const,
    };
    // Random pinned at 0: the floor alone — the spread on top is `jitterStatedDelay`'s, tested there.
    expect(retryDecision(policy, 1, error, () => 0).delayMs).toBe(2_000);
  });

  test('the transport reads the header off the response', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response(refusal({ title: 'rate limit exhausted for this key' }), {
        status: 429,
        headers: { 'content-type': 'application/problem+json', 'retry-after': '3' },
      });
    const error = await clientTransport({ method: 'GET', url: URL, fetchImpl }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toMatchObject({
      code: 'X_REMOTE_ONLY_CODE',
      title: 'rate limit exhausted for this key',
      retry: 'retry-after',
      meta: { retryAfterSeconds: 3 },
    });
  });
});

describe('problemError — a delay only the header may state', () => {
  // The framework's server never puts `retryAfterSeconds` in a problem body: `registerProblemMeta`
  // refuses framework codes, and whenever an error carries the key `@ultimat3/http` writes the
  // `Retry-After` header from it (exposed cross-origin by its CORS default). A body value is
  // therefore never the server's statement — and it must not drive the wait.
  test('a body retryAfterSeconds with no header is dropped, and states nothing', () => {
    const error = problemError(429, refusal({ meta: { retryAfterSeconds: 3_600 } }), URL);
    expect(error.meta?.['retryAfterSeconds']).toBeUndefined();
    expect(statedDelayMs(error)).toBeUndefined();
    // And it cannot flip an unregistered code's class: no header, so the status rule alone.
    expect(error.retry).toBe('retryable');
  });

  test('the header wins over a body value, which is never copied', () => {
    const error = problemError(429, refusal({ meta: { retryAfterSeconds: 3_600 } }), URL, 2);
    expect(error.meta?.['retryAfterSeconds']).toBe(2);
    expect(error.retry).toBe('retry-after');
  });
});
