import { afterEach, test as bunTest, describe, expect } from 'bun:test';
import { clearFixtures, defineFixtures, registeredFixtures, requestedFixtures } from './fixtures';

afterEach(() => {
  clearFixtures();
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

  bunTest('handles renaming and whitespace', () => {
    expect(requestedFixtures(({ seed: s, page }: never) => void [s, page])).toEqual([
      'seed',
      'page',
    ]);
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
