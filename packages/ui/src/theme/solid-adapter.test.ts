// Registration mechanics for the process-global Solid runtime slot: unset by
// default, set/read/replace/clear, and the exact error thrown while unset.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from '../errors';
import {
  clearSolidRuntime,
  hasSolidRuntime,
  type SolidContext,
  type SolidRuntime,
  setSolidRuntime,
  solid,
} from './solid-adapter';

function fakeRuntime(): SolidRuntime {
  return {
    createContext: <T>(defaultValue: T): SolidContext<T> => ({
      id: Symbol(),
      defaultValue,
      Provider: () => null as never,
    }),
    useContext: <T>(context: SolidContext<T>): T => context.defaultValue,
    createSignal: <T>(value: T) => {
      let current = value;
      return [
        () => current,
        (next: T) => {
          current = next;
        },
      ] as const;
    },
    createMemo: <T>(fn: () => T) => fn,
    createEffect: () => {},
    onCleanup: () => {},
  };
}

describe('solid runtime registration', () => {
  beforeEach(() => {
    clearSolidRuntime();
  });

  afterEach(() => {
    clearSolidRuntime();
  });

  test('hasSolidRuntime is false before any registration', () => {
    expect(hasSolidRuntime()).toBe(false);
  });

  test('solid() throws a runtime-missing error when nothing is registered', () => {
    try {
      solid();
      throw new Error('expected a throw');
    } catch (error) {
      const err = error as { code?: string; fix?: string };
      expect(err.code).toBe(UI_ERROR_CODES.runtimeMissing);
      expect(err.fix).toContain('setSolidRuntime');
    }
  });

  test('setSolidRuntime registers the exact object passed in', () => {
    const runtime = fakeRuntime();
    setSolidRuntime(runtime);
    expect(hasSolidRuntime()).toBe(true);
    expect(solid()).toBe(runtime);
  });

  test('clearSolidRuntime unregisters, so hasSolidRuntime and solid() revert', () => {
    setSolidRuntime(fakeRuntime());
    clearSolidRuntime();
    expect(hasSolidRuntime()).toBe(false);
    expect(() => solid()).toThrow();
  });

  test('registering twice replaces the previous runtime, last write wins', () => {
    const first = fakeRuntime();
    const second = fakeRuntime();
    setSolidRuntime(first);
    setSolidRuntime(second);
    expect(solid()).toBe(second);
    expect(solid()).not.toBe(first);
  });
});
