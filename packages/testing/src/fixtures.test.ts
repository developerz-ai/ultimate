import { afterAll, beforeEach, test as bunTest, describe, expect } from 'bun:test';
import type { FixtureBag } from './fixtures';
import {
  clearFixtures,
  defineFixtures,
  fixtureSnapshot,
  registeredFixtures,
  requestedFixtures,
  runWithFixtures,
} from './fixtures';

/**
 * The annotation on a body `requestedFixtures` only ever READS — it parses `body.toString()` and
 * never calls it, so the parameter's type is not part of what is under test. It only has to admit
 * the PATTERNS under test, which is why the values are objects: two of them destructure a nested
 * one (`clock: { now }`) and one defaults to one (`clock = { now: 1 }`). `never` was the previous
 * answer and could do neither — destructuring `never` types every binding `never`, so nothing is
 * assignable to it and nothing can be read out of it.
 */
interface ProbeBag {
  readonly seed: unknown;
  readonly actorFor: unknown;
  readonly mail: unknown;
  readonly network: unknown;
  readonly page: unknown;
  /** The one name a pattern below reaches INTO, so it is the one with a shape. */
  readonly clock: { readonly now: unknown };
}

// The registry is process-global and the preload filled it. Hand it back, or every file that
// runs after this one loses `clock`, `seed` and the rest — a load-order flake, not a failure.
const preloaded = fixtureSnapshot();

beforeEach(() => {
  clearFixtures();
});

afterAll(() => {
  clearFixtures();
  defineFixtures(preloaded);
});

describe('requestedFixtures', () => {
  bunTest('reads the destructured names so unused fixtures are never built', () => {
    expect(
      requestedFixtures(async ({ seed, actorFor }: ProbeBag) => void [seed, actorFor]),
    ).toEqual(['seed', 'actorFor']);
  });

  bunTest('returns nothing for a body that takes no fixtures', () => {
    // The distinction that matters: `async () => {` opens a body, not a pattern. Reading the
    // first `{` naively would return the body's first statement as a fixture name.
    expect(requestedFixtures(async () => void 0)).toEqual([]);
    expect(requestedFixtures(() => void 0)).toEqual([]);
  });

  // Stopping at the first `}` truncates the pattern, and the names AFTER a nested object are the
  // ones lost — silently, so the fixture is never built and the body reads `undefined`, which is
  // the exact failure this module's own header says it exists to prevent.
  bunTest('reads past a nested object in the pattern', () => {
    expect(
      requestedFixtures(({ mail, clock: { now }, network }: ProbeBag) => void [mail, now, network]),
    ).toEqual(['mail', 'clock', 'network']);
  });

  bunTest('reads past an object default in the pattern', () => {
    expect(
      requestedFixtures(({ clock = { now: 1 }, mail }: ProbeBag) => void [clock, mail]),
    ).toEqual(['clock', 'mail']);
  });

  bunTest('handles renaming and whitespace', () => {
    expect(requestedFixtures(({ seed: s, page }: ProbeBag) => void [s, page])).toEqual([
      'seed',
      'page',
    ]);
  });
});

describe('fixtureTest teardown', () => {
  // Disposal is what stops one file's ambient driver reaching the next, so it has to hold when a
  // disposer itself fails — otherwise one broken fixture re-opens the leak for all of them.
  bunTest('a throwing disposer does not strand the fixtures built before it', async () => {
    const disposed: string[] = [];
    defineFixtures({
      outer: () => ({ [Symbol.dispose]: () => void disposed.push('outer') }),
      broken: () => ({
        [Symbol.dispose]: () => {
          // Recorded BEFORE the throw, so the list pins the ORDER as well as the survival:
          // asserting only `['outer']` passes just as well when teardown runs in build order,
          // which is the opposite of what this seam promises.
          disposed.push('broken');
          throw new Error('teardown exploded');
        },
      }),
    });

    // `broken` is built second, so it disposes first — `outer` must still be reached.
    const thrown = await runWithFixtures(
      ({ outer, broken }: FixtureBag) => void [outer, broken],
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(disposed).toEqual(['broken', 'outer']);
    expect((thrown as Error).message).toBe('teardown exploded');
  });

  bunTest('the body’s failure wins over a teardown failure', async () => {
    defineFixtures({
      broken: () => ({
        [Symbol.dispose]: () => {
          throw new Error('teardown exploded');
        },
      }),
    });

    const thrown = await runWithFixtures(({ broken }: FixtureBag) => {
      void broken;
      throw new Error('the assertion that actually broke');
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((thrown as Error).message).toBe('the assertion that actually broke');
  });
});

describe('defineFixtures', () => {
  bunTest('merges rather than replaces, so packages can register independently', () => {
    defineFixtures({ a: () => 1 });
    defineFixtures({ b: () => 2 });
    expect(registeredFixtures()).toEqual(['a', 'b']);
  });

  bunTest('a later registration of the same name wins', () => {
    defineFixtures({ a: () => 1 });
    defineFixtures({ a: () => 2 });
    expect(registeredFixtures()).toEqual(['a']);
  });
});
