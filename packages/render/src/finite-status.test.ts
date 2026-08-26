// The screen itself, at its edges. `render-ssr.test.ts` and `render-stream.test.ts` prove the two
// call sites reach it; this file proves the boundary values, which neither of those can see.

import { describe, expect, test } from 'bun:test';
import { finiteStatus } from './finite-status';

describe('finiteStatus', () => {
  test('every status new Response accepts for a document passes through unchanged', () => {
    for (const status of [200, 201, 302, 404, 500, 599]) {
      expect(finiteStatus('subject', status)).toBe(status);
      expect(new Response('body', { status }).status).toBe(status);
    }
  });

  test('199 and 600 are refused, and both are what the boundary refuses too', () => {
    for (const status of [199, 600]) {
      expect(() => finiteStatus('subject', status)).toThrow(/status/);
      expect(() => new Response('body', { status })).toThrow(RangeError);
    }
  });

  // `101` is a protocol switch. `new Response` accepts it and no rendered document is one, so the
  // screen is deliberately narrower than the boundary — narrower is safe, wider is a RangeError.
  test('101 is refused even though new Response would take it', () => {
    expect(() => finiteStatus('subject', 101)).toThrow(/status/);
  });

  test('a non-finite or fractional status is refused before the range is even asked', () => {
    for (const status of [Number.NaN, Number.POSITIVE_INFINITY, 200.5]) {
      expect(() => finiteStatus('subject', status)).toThrow(/status/);
    }
  });

  test('the refusal names the subject it was given, so the fix names the call to edit', () => {
    expect(() => finiteStatus('streamResult', Number.NaN)).toThrow(/streamResult/);
  });
});
