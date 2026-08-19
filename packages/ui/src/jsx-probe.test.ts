// TEST-ONLY module, tested for the one thing a harness must never do: damage the process it runs
// in. `probe()` writes a global every `.tsx` in the run reads, so what it does to a binding that
// was already there — and what a second, nested probe does to the first — is a correctness
// question, not a style one.

import { afterEach, describe, expect, test } from 'bun:test';
import { probe, renderNodes, unprobe } from './jsx-probe';

const react = (): unknown => Reflect.get(globalThis, 'React');

const installed = (): boolean =>
  typeof (react() as { createElement?: unknown } | undefined)?.createElement === 'function';

/** The property as the process held it before this file ran, restored between tests so one
 * failure cannot decide the next test's starting state. */
const before = Object.getOwnPropertyDescriptor(globalThis, 'React');

afterEach(() => {
  if (before === undefined) Reflect.deleteProperty(globalThis, 'React');
  else Object.defineProperty(globalThis, 'React', before);
});

describe('probe / unprobe', () => {
  test('installs a classic factory a component can be called through', () => {
    probe();
    try {
      expect(installed()).toBe(true);
      const component = (p: Record<string, unknown>): unknown => p['children'];
      expect(renderNodes(component, { children: null })).toEqual([]);
    } finally {
      unprobe();
    }
  });

  test('hands back the React binding the process already had', () => {
    const original = { createElement: (): string => 'someone else', own: true };
    Object.defineProperty(globalThis, 'React', {
      value: original,
      configurable: true,
      writable: true,
      enumerable: true,
    });
    probe();
    expect(react()).not.toBe(original);
    unprobe();
    // Deleting the property outright destroyed a binding the harness did not create — invisible
    // here, and a torn-down React in whatever else shares the process.
    expect(react()).toBe(original);
  });

  test('removes the property entirely when there was none to begin with', () => {
    Reflect.deleteProperty(globalThis, 'React');
    probe();
    expect('React' in globalThis).toBe(true);
    unprobe();
    expect('React' in globalThis).toBe(false);
  });

  test('nests: the factory survives until the LAST unprobe', () => {
    Reflect.deleteProperty(globalThis, 'React');
    probe();
    probe();
    unprobe();
    // Two suites in one file both install and both tear down; the inner teardown used to leave
    // every component after it compiling against nothing.
    expect(installed()).toBe(true);
    unprobe();
    expect('React' in globalThis).toBe(false);
  });

  test('an unbalanced unprobe touches nothing', () => {
    const original = { createElement: (): string => 'someone else' };
    Object.defineProperty(globalThis, 'React', {
      value: original,
      configurable: true,
      writable: true,
      enumerable: true,
    });
    unprobe();
    expect(react()).toBe(original);
  });
});
