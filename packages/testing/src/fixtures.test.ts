import { afterAll, beforeEach, test as bunTest, describe, expect } from 'bun:test';
import {
  clearFixtures,
  defineFixtures,
  fixtureSnapshot,
  registeredFixtures,
  requestedFixtures,
  runWithFixtures,
} from './fixtures';

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
    expect(requestedFixtures(async ({ seed, actorFor }: never) => void [seed, actorFor])).toEqual([
      'seed',
      'actorFor',
    ]);
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
      requestedFixtures(({ mail, clock: { now }, network }: never) => void [mail, now, network]),
    ).toEqual(['mail', 'clock', 'network']);
  });

  bunTest('reads past an object default in the pattern', () => {
    expect(requestedFixtures(({ clock = { now: 1 }, mail }: never) => void [clock, mail])).toEqual([
      'clock',
      'mail',
    ]);
  });

  bunTest('handles renaming and whitespace', () => {
    expect(requestedFixtures(({ seed: s, page }: never) => void [s, page])).toEqual([
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
          throw new Error('teardown exploded');
        },
      }),
    });

    // `broken` is built second, so it disposes first — `outer` must still be reached.
    const thrown = await runWithFixtures(({ outer, broken }: never) => void [outer, broken]).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(disposed).toEqual(['outer']);
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

    const thrown = await runWithFixtures(({ broken }: never) => {
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
