// The runtime slot is process-global and every component reaches through it, so a wrong answer
// while unset surfaces as a blank render deep in a tree rather than at the registration site.
// These cases pin the slot's answer in each state, and pin the error that names the fix.

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
    let caught: unknown;
    try {
      solid();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: UI_ERROR_CODES.runtimeMissing });
    expect((caught as { fix?: string }).fix).toContain('setSolidRuntime');
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
