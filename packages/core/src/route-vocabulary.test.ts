// The three vocabularies are CLOSED sets, so their members are pinned here the way
// `registrar.test.ts` pins the eight primitives: adding or removing one is a failing test that
// makes the author say so, not a silent widening five packages inherit.

import { describe, expect, test } from 'bun:test';
import { HYDRATE_STRATEGIES, OFFLINE_STRATEGIES, RENDER_MODES } from './route-vocabulary';

// The TYPE half — that each union is still `(typeof ARRAY)[number]` — is pinned in `type-pins.ts`,
// never here: `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc -b` never reads this file and a
// type-level assertion written in it cannot fail. Runtime members are what this file can prove.

describe('the route vocabulary', () => {
  test('render modes are exactly the four, in the order every fix line prints them', () => {
    expect([...RENDER_MODES]).toEqual(['static', 'isr', 'ssr', 'stream']);
  });

  test('offline strategies are exactly the three', () => {
    expect([...OFFLINE_STRATEGIES]).toEqual(['precache', 'runtime', 'network-only']);
  });

  test('hydrate strategies are exactly the four', () => {
    expect([...HYDRATE_STRATEGIES]).toEqual(['idle', 'visible', 'interaction', 'never']);
  });

  test('no member is repeated, so a Record over one has a row per member', () => {
    for (const set of [RENDER_MODES, OFFLINE_STRATEGIES, HYDRATE_STRATEGIES]) {
      expect(new Set(set).size).toBe(set.length);
    }
  });
});
