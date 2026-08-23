// Guards the one seam that keeps same-tier packages from importing each other: a registrar that
// resolved to `undefined`, or a second copy quietly winning the table, would split a kind's
// primitives across two registries and drop half of them with nothing raised.

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  hasPrimitiveRegistrar,
  type ModuleRegistrar,
  PRIMITIVE_FACTORIES,
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

/**
 * The other half of "don't invent a ninth": the factories that already exist. Prose counted them
 * ("the fourth instance of the factory rule") in three files that could not see each other, so the
 * ordinal was wrong the moment a fifth landed. This table is what a new factory is added to.
 */
describe('PRIMITIVE_FACTORIES', () => {
  test('lists every shipped factory, each over one of the eight kinds', () => {
    expect(PRIMITIVE_FACTORIES).toHaveLength(7);
    for (const entry of PRIMITIVE_FACTORIES) {
      expect(PRIMITIVE_KINDS).toContain(entry.kind);
      expect(entry.pkg.startsWith('@ultimat3/')).toBe(true);
    }
  });

  test('names the seven the framework ships, and no factory is listed twice', () => {
    expect(PRIMITIVE_FACTORIES.map((entry) => `${entry.pkg}#${entry.factory}`)).toEqual([
      '@ultimat3/ai#agent',
      '@ultimat3/ai#agentJob',
      '@ultimat3/ai#hive',
      '@ultimat3/ai#llm',
      '@ultimat3/jobs#backfill',
      '@ultimat3/jobs#purge',
      '@ultimat3/scraping#scrape',
    ]);
  });

  test('is frozen, so a caller cannot grow the vocabulary at runtime', () => {
    expect(Object.isFrozen(PRIMITIVE_FACTORIES)).toBe(true);
  });

  test('every ROW is frozen too, so a caller cannot rewrite what a factory returns', () => {
    // A frozen array holding writable rows guards the LIST while leaving every value in it open —
    // the half that would have mattered, because `kind` is what `x affected` and the manifest read
    // to decide which primitive a factory produces. `readonly` is a compile-time claim; this is the
    // caller that has no types. A module is always strict, so the write THROWS rather than being
    // dropped in silence.
    expect(PRIMITIVE_FACTORIES.filter((entry) => !Object.isFrozen(entry))).toEqual([]);
    const untyped = PRIMITIVE_FACTORIES[0] as unknown as { kind: string };
    expect(() => {
      untyped.kind = 'entity';
    }).toThrow(TypeError);
    expect(PRIMITIVE_FACTORIES[0]?.kind).toBe('action');
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
