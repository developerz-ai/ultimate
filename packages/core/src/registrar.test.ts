// Guards the one seam that keeps same-tier packages from importing each other: a registrar that
// resolved to `undefined`, or a second copy quietly winning the table, would split a kind's
// primitives across two registries and drop half of them with nothing raised.

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  hasPrimitiveRegistrar,
  type ModuleRegistrar,
  PRIMITIVE_KINDS,
  primitiveRegistrar,
  type RegisteredPrimitive,
  registerPrimitiveRegistrar,
  resetPrimitiveRegistrars,
} from './registrar';

const noop: ModuleRegistrar = () => [];

const asQuery = (name: string): RegisteredPrimitive => ({ kind: 'query', name });

beforeEach(() => {
  resetPrimitiveRegistrars();
});

describe('registerPrimitiveRegistrar', () => {
  test('a kind is unresolvable until its owner announces one', () => {
    expect(hasPrimitiveRegistrar('query')).toBe(false);
    registerPrimitiveRegistrar('query', noop);
    expect(hasPrimitiveRegistrar('query')).toBe(true);
  });

  test('re-announcing the same function is a no-op', () => {
    registerPrimitiveRegistrar('query', noop);
    expect(() => registerPrimitiveRegistrar('query', noop)).not.toThrow();
    expect(primitiveRegistrar('query')).toBe(noop);
  });

  test('a second, different registrar for one kind is X_REGISTRAR_CONFLICT', () => {
    registerPrimitiveRegistrar('query', noop);
    const other: ModuleRegistrar = () => [];
    let code = '';
    try {
      registerPrimitiveRegistrar('query', other);
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe('X_REGISTRAR_CONFLICT');
  });

  test('kinds are independent', () => {
    registerPrimitiveRegistrar('query', noop);
    expect(hasPrimitiveRegistrar('action')).toBe(false);
  });
});

describe('the eight primitives', () => {
  /**
   * The rule that says "don't invent a ninth" is documented in four places and, until this
   * assertion, enforced in none — a ninth member of the union compiled like any other. This is
   * the build error. If a capability seems to need a new kind, it arrives as a factory over an
   * existing primitive instead: `llm()` returns an `action`, which is why a model call carries
   * every action projection without a ninth entry here.
   */
  test('are exactly these eight — a ninth is a design error, not a feature', () => {
    expect([...PRIMITIVE_KINDS]).toEqual([
      'action',
      'entity',
      'job',
      'mutator',
      'policy',
      'query',
      'route',
      'task',
    ]);
  });

  test('every one of them is a registrable kind, and each resolves only its own', () => {
    for (const kind of PRIMITIVE_KINDS) {
      resetPrimitiveRegistrars();
      registerPrimitiveRegistrar(kind, noop);
      const resolved = PRIMITIVE_KINDS.filter(hasPrimitiveRegistrar);
      expect(resolved).toEqual([kind]);
    }
  });
});

describe('primitiveRegistrar', () => {
  test('returns the announced registrar, and its results carry the registered names', () => {
    const registrar: ModuleRegistrar = (module) => Object.keys(module).map(asQuery);
    registerPrimitiveRegistrar('action', registrar);
    expect(primitiveRegistrar('action')({ a: 1, b: 2 })).toEqual([asQuery('a'), asQuery('b')]);
  });

  test('throws X_REGISTRAR_MISSING with an installable fix rather than returning undefined', () => {
    let thrown: { code: string; fix: string } | undefined;
    try {
      primitiveRegistrar('query');
    } catch (error) {
      thrown = error as { code: string; fix: string };
    }
    expect(thrown?.code).toBe('X_REGISTRAR_MISSING');
    expect(thrown?.fix).toBe('bun add @ultimat3/query');
  });
});
