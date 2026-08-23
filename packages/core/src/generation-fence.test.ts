import { describe, expect, test } from 'bun:test';
import { isUltimateError } from './errors';
import { createFence, isSuperseded } from './generation-fence';

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('createFence', () => {
  test('starts at generation 0 and bump returns the new one', () => {
    const fence = createFence('the live window');
    expect(fence.generation()).toBe(0);
    expect(fence.bump()).toBe(1);
    expect(fence.bump()).toBe(2);
    expect(fence.generation()).toBe(2);
  });

  test('guard passes while the generation the caller was issued is still current', () => {
    const fence = createFence('the live window');
    const issued = fence.generation();
    expect(() => fence.guard(issued)).not.toThrow();
  });

  test('a late answer from a superseded generation is refused, not applied', () => {
    const fence = createFence('the live window');
    const issued = fence.generation();
    fence.bump();
    const error = thrown(() => fence.guard(issued));
    expect(isSuperseded(error)).toBe(true);
    expect(isUltimateError(error) ? error.code : undefined).toBe('X_SUPERSEDED');
    expect(isUltimateError(error) ? error.meta : undefined).toEqual({
      subject: 'the live window',
      issued: 0,
      current: 1,
    });
  });

  test('the refusal is terminal — retrying superseded work produces a superseded answer', () => {
    const fence = createFence('the live window');
    fence.bump();
    const error = thrown(() => fence.guard(0));
    expect(isUltimateError(error) ? error.retry : undefined).toBe('terminal');
  });

  test('a generation from the FUTURE is refused too — the fence fails closed', () => {
    const fence = createFence('the live window');
    expect(isSuperseded(thrown(() => fence.guard(7)))).toBe(true);
  });

  test('two fences count independently', () => {
    const one = createFence('one');
    const other = createFence('other');
    one.bump();
    expect(other.generation()).toBe(0);
    expect(() => other.guard(0)).not.toThrow();
  });
});

describe('isSuperseded', () => {
  test('is false for any other throw, including a non-error', () => {
    expect(isSuperseded(new Error('nope'))).toBe(false);
    expect(isSuperseded(undefined)).toBe(false);
    expect(isSuperseded({ code: 'X_SUPERSEDED' })).toBe(false);
  });
});
