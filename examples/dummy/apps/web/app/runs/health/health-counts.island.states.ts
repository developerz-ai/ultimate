/**
 * The counts island's states. It renders no markup of its own — it counts up the figures a server
 * page drew — so a states file, which hands the harness an EMPTY host, can photograph nothing but
 * the empty wrapper: `x shot` refuses that as "mounted and rendered nothing"
 * (`contact-sales.island.states.ts` gives the same reason). The first paint IS the final figure
 * and the count only ever ends on it, so the static frame (reduced motion, scripting off, a paused
 * page) and `idle` are one picture; the route's own photograph (`x shot /runs/health`) is where it shows.
 *
 * PURE DATA — the one import is `import type` (`X_TEST_ISLAND_STATES_NOT_PURE`).
 */

import { defineIslandStates } from '@ultimat3/testing';
import type { HealthCountsProps } from './health-counts.island';

const BASE = {
  locale: 'en',
  counts: { 'runs-total': 3, 'runs-failed': 1 },
} satisfies HealthCountsProps;

export const healthCountsStates = defineIslandStates({
  island: 'apps/web/app/runs/health/health-counts.island.tsx',
  viewport: { width: 560, height: 160 },
  states: [
    { id: 'idle', title: 'the first paint: the server figures, untouched', props: BASE },
    {
      id: 'empty',
      title: 'no figure the page drew: nothing to count',
      note: 'an unknown stat is skipped, so a wrapper with no matching tile mounts and stays empty',
      props: { ...BASE, counts: {} },
    },
  ],
});
