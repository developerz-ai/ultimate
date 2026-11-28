/**
 * The dashboard motion island's states. It renders nothing of its own around the server's page — it
 * counts up figures the server drew, brings in one notice and fades cards — so a states file, whose
 * harness hands it an EMPTY host, can show only the empty wrapper (`contact-sales.island.states.ts`
 * gives the same reason). The first paint IS the final page, and every motion ends on it, so the
 * static frame (reduced motion, scripting off, a paused page) and `idle` are one picture; the route's
 * own photograph (`x shot /dashboard`) is where the figures show.
 *
 * PURE DATA — the one import is `import type` (`X_TEST_ISLAND_STATES_NOT_PURE`). The text is a
 * literal because an island's props cross as JSON the server already translated.
 */

import { defineIslandStates } from '@ultimat3/testing';
import type { DashboardMotionProps } from './dashboard-motion.island';

const BASE = {
  locale: 'en',
  counts: { 'dashboard-posts': 12, 'dashboard-likes': 340, 'dashboard-friends': 5 },
  waiting: { text: '2 friend requests are waiting on you', href: '/friends' },
} satisfies DashboardMotionProps;

export const dashboardMotionStates = defineIslandStates({
  island: 'apps/web/app/dashboard/dashboard-motion.island.tsx',
  viewport: { width: 960, height: 360 },
  states: [
    { id: 'idle', title: 'the first paint: the server page, untouched', props: BASE },
    {
      id: 'nobody-waiting',
      title: 'no request to answer: no notice',
      props: { ...BASE, waiting: null },
    },
  ],
});
