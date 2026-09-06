// The runtime slot is process-global and every component reaches through it, so a wrong answer
// while unset surfaces as a blank render deep in a tree rather than at the registration site.
// These cases pin the slot's answer in each state — including the two unregistered states, which
// are not the same one: no DOM is a server render, a DOM is a bug — and the error that names the fix.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from '../errors';
import { INERT_SOLID_RUNTIME } from './inert-runtime';
import { clearSolidRuntime, hasSolidRuntime, setSolidRuntime } from './runtime-slot';
import { type SolidContext, type SolidRuntime, solid } from './solid-adapter';

/** Bun's test process has no DOM, so a browser is what has to be faked, never a server. */
function withDom<T>(fn: () => T): T {
  Object.assign(globalThis, { document: {}, window: {} });
  try {
    return fn();
  } finally {
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'window');
  }
}

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

  test('solid() hands back the inert runtime off-DOM, so a server render still works', () => {
    expect(solid()).toBe(INERT_SOLID_RUNTIME);
  });

  test('solid() throws a runtime-missing error in a DOM with nothing registered', () => {
    let caught: unknown;
    withDom(() => {
      try {
        solid();
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toMatchObject({ code: UI_ERROR_CODES.runtimeMissing });
    const fix = (caught as { fix?: string }).fix ?? '';
    // The paste line is the six named imports, in the order the contract lists them — never the
    // namespace form, which registers just as well and costs 14.8 kB of unshaken solid-js.
    expect(fix).toContain(
      'setSolidRuntime({ createContext, useContext, createSignal, createMemo, createEffect, onCleanup })',
    );
    expect(fix).not.toContain('setSolidRuntime(solidRuntime)');
  });

  test('a whole solid-js namespace still registers — the contract is a subset of it', () => {
    // Type-level half: `typeof import('solid-js')` must stay assignable to `SolidRuntime`, so an
    // island written before the six-pick paste line keeps compiling. The `children` REQUIRED note
    // on `SolidContext` is what makes this line type-check at all.
    const registersNamespace = (namespace: typeof import('solid-js')): void =>
      setSolidRuntime(namespace);
    expect(typeof registersNamespace).toBe('function');
    // Runtime half: a superset object — the namespace has ~80 exports — is handed back whole.
    const superset = { ...fakeRuntime(), observable: () => {}, createResource: () => {} };
    setSolidRuntime(superset);
    expect(solid()).toBe(superset);
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
    expect(solid()).toBe(INERT_SOLID_RUNTIME);
    withDom(() => {
      expect(() => solid()).toThrow();
    });
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
