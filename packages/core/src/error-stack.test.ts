// What every recorded stack reads as: the runtime's when it is whole, the header restored
// when Bun dropped it (#773), and an author-shaped stack left alone.

import { describe, expect, test } from 'bun:test';
import { failureStack } from './error-stack';

const shaped = (fields: Record<string, unknown>): Record<string, unknown> => fields;

/**
 * An error built in an async frame that awaited its own rejection and returned. Which shapes lose
 * the header is the engine's business (a concise-bodied arrow of the same code kept it, as of Bun
 * 1.4.2); this one lost it on every run, so the test below fails without the restore.
 */
const caughtAcrossAwait = async (): Promise<unknown> => {
  return await Promise.reject(new TypeError('selector moved')).catch((error: unknown) => error);
};

describe('failureStack', () => {
  test('restores the header a collection took from a real error', async () => {
    const headers: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      const thrown = await caughtAcrossAwait();
      Bun.gc(true);
      const stack = failureStack(thrown) ?? '';
      expect(stack).toContain('error-stack.test.ts');
      headers.push(stack.split('\n')[0] ?? '');
    }
    expect(headers).toEqual(Array.from({ length: 5 }, () => 'TypeError: selector moved'));
  });

  test('returns a whole stack untouched', () => {
    const error = new RangeError('too far');
    const before = error.stack;
    expect(failureStack(error)).toBe(before);
  });

  test('replaces a bare `Error` first line and keeps every frame', () => {
    const value = shaped({ name: 'TypeError', message: 'm', stack: 'Error\n    at f (a.ts:1:2)' });
    expect(failureStack(value)).toBe('TypeError: m\n    at f (a.ts:1:2)');
  });

  test('prepends the header to a stack that opens on a frame', () => {
    const value = shaped({ name: 'SyntaxError', message: 'x', stack: '    at f (a.ts:1:2)' });
    expect(failureStack(value)).toBe('SyntaxError: x\n    at f (a.ts:1:2)');
  });

  test('a message-less error keeps its name alone as the header', () => {
    const value = shaped({ name: 'AbortError', message: '', stack: 'Error\n    at f (a.ts:1:2)' });
    expect(failureStack(value)).toBe('AbortError\n    at f (a.ts:1:2)');
  });

  test('a plain `Error` with no message is already whole', () => {
    const value = shaped({ name: 'Error', message: '', stack: 'Error\n    at f (a.ts:1:2)' });
    expect(failureStack(value)).toBe('Error\n    at f (a.ts:1:2)');
  });

  test('leaves a stack its author shaped some other way', () => {
    const value = shaped({ name: 'TypeError', message: 'm', stack: 'custom trace' });
    expect(failureStack(value)).toBe('custom trace');
  });

  test('no stack, no record', () => {
    expect(failureStack('a string')).toBeUndefined();
    expect(failureStack({ name: 'TypeError', message: 'm' })).toBeUndefined();
  });
});
