// The derived island budget: the number, where it came from, and the three properties it has to
// keep. Split from `modes.test.ts` because it asserts a MEASUREMENT rather than a mode rule — the
// table below is bytes off disk, and it is the only thing standing between the default and the
// four-kilobyte figure that was calibrated on an island importing no `solid-js` at all.

import { describe, expect, test } from 'bun:test';
import { hydrateRuntimeBytes } from './hydrate';
import { DEFAULT_ISLAND_JS_BYTES, defaultIslandBudget } from './modes';
import { DEFAULT_ISLAND_HYDRATE } from './route';
import { SURFACE_SPECS } from './surfaces';

describe('DEFAULT_ISLAND_JS_BYTES', () => {
  /**
   * Measured with `buildIslands` from `@ultimat3/cli`, minified, production Solid resolved, on
   * 2026-08-21. Not imported: this package may not reach tier 5, and a budget test that built a
   * bundle would be an `.e2e.` suite rather than a unit one. Restated here so the constant above
   * has a number to fail against — a budget with no test is the state that shipped a default no
   * island could meet.
   */
  const MEASURED = {
    nonSolidIsland: 875,
    solidFloor: 12_588,
    /**
     * Reconstructed, +/- ~30 B: the island it came from is committed nowhere, so unlike its three
     * neighbours this one has no reproduction. Not load-bearing — `solidFloor` and
     * `referenceAppIsland` bracket it — and kept only to show the shape between them.
     */
    trivialCounter: 13_663,
    referenceAppIsland: 17_797,
    /** `idle`. Not what an undeclared island route pays — see the row below. */
    hydrateRuntimeIdle: 615,
    /**
     * `DEFAULT_ISLAND_HYDRATE` is `'interaction'` (`route.ts:33`), so THIS is the runtime an island
     * route declaring no `hydrate` actually ships. The budget derivation used `idle` and understated
     * the worst case by 266 B; the conclusion survived, the arithmetic did not.
     */
    hydrateRuntimeDefault: 881,
  } as const;

  test('a Solid island can reach it — the property 4096 did not have', () => {
    // The floor is what `render()` costs before an author writes a line. A default below it is a
    // ceiling every JSX island fails on arrival, whatever it contains.
    expect(DEFAULT_ISLAND_JS_BYTES).toBeGreaterThan(
      MEASURED.solidFloor + MEASURED.hydrateRuntimeDefault,
    );
    expect(DEFAULT_ISLAND_JS_BYTES).toBeGreaterThan(
      MEASURED.referenceAppIsland + MEASURED.hydrateRuntimeDefault,
    );
  });

  test('it is still a ceiling — headroom over the real island, not a blank cheque', () => {
    const spent = MEASURED.referenceAppIsland + MEASURED.hydrateRuntimeDefault;
    // Under 2x, so a second copy of the same island is refused rather than waved through, which is
    // the shape of the defect this check exists for: `three` and `three/webgpu` bundled twice.
    expect(DEFAULT_ISLAND_JS_BYTES).toBeLessThan(spent * 2);
    expect(DEFAULT_ISLAND_JS_BYTES % 1024).toBe(0);
  });

  test('the derived ceiling is the surface baseline plus the allowance, per surface', () => {
    // Relative, never absolute: `site/` starts at 0 and `app/` at 14kb, so one number would be
    // either a ceiling `app/` fails on arrival or one `site/` can never reach.
    for (const surface of ['site', 'app'] as const) {
      const bytes = SURFACE_SPECS[surface].jsBaselineBytes + DEFAULT_ISLAND_JS_BYTES;
      expect(defaultIslandBudget(surface)).toBe(`${bytes / 1024}kb`);
    }
    expect(defaultIslandBudget('site')).toBe('20kb');
    expect(defaultIslandBudget('app')).toBe('34kb');
  });

  test('the non-Solid island the old default was calibrated on still fits, with room', () => {
    // Not a regression guard on 875 B — a statement that raising the number did not stop the
    // cheapest shape from being cheap. It is the *calibration* that was wrong, not the island.
    expect(MEASURED.nonSolidIsland).toBeLessThan(DEFAULT_ISLAND_JS_BYTES);
    expect(MEASURED.trivialCounter).toBeLessThan(DEFAULT_ISLAND_JS_BYTES);
  });

  test('the runtime the derivation adds is the one an undeclared island route really ships', () => {
    // The pair that drifted: the comment added `idle` (615) while `route.ts:253` gives an island
    // route with no `hydrate` the `interaction` runtime (881). Derived here rather than restated,
    // so changing `DEFAULT_ISLAND_HYDRATE` reds this instead of silently understating the budget.
    const directive = {
      islandId: 'i1',
      moduleId: 'm',
      strategy: DEFAULT_ISLAND_HYDRATE,
      entry: '/islands/x-abc.js',
      props: {},
    } as const;

    expect(hydrateRuntimeBytes([directive])).toBe(MEASURED.hydrateRuntimeDefault);
    expect(MEASURED.hydrateRuntimeDefault).toBeGreaterThan(MEASURED.hydrateRuntimeIdle);
  });
});
