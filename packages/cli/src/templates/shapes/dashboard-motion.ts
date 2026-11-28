// `--shape dashboard`'s motion: one island on `/dashboard` that enter-animates what the server
// already painted. A tips panel opens and closes through `Presence`, the stat tiles and the table
// rows arrive in order through `stagger` once `inView` says they are on screen, and opening the
// panel slides what sits below it through `layout` (FLIP, transform only). Every timing is a rung
//
// of the motion scale; under reduced motion each call finishes at once (`motionTiming`).

import type { GeneratedFile } from '../naming';
import type { ShapeEdit } from './overlay';

const DIR = 'apps/web/app/dashboard';
const PAGE = `${DIR}/page.tsx`;
const ISLAND = 'dashboard-motion';

const THEME_ISLAND =
  "const ThemeSwitch = island({ src: '../../shared/theme-toggle.island.tsx', props: ['locale'] });";
const HEADER =
  "        <PageHeader title={t('app.dashboard.title')} description={t('app.dashboard.subtitle')} />\n";

/** What the page hands the island: three strings, already translated — a `t` cannot travel. */
export const MOTION_KEYS = {
  'app.dashboard.motionOpen': 'Show tips',
  'app.dashboard.motionClose': 'Hide tips',
  'app.dashboard.motionNote': 'Tiles and rows arrive in order as they scroll into view.',
} as const;

/** The page's two edits: declare the island above `defineRoute`, and place it under the header. */
export const dashboardMotionEdits = (): readonly ShapeEdit[] => [
  {
    path: PAGE,
    find: THEME_ISLAND,
    replace: `${THEME_ISLAND}
// The motion island: named by specifier too. Its three props are the exact keys of
// \`DashboardMotionProps\`.
const MotionPanel = island({
  src: './${ISLAND}.island.tsx',
  props: ['open', 'close', 'note'],
});`,
  },
  {
    path: PAGE,
    find: HEADER,
    replace: `${HEADER}        <MotionPanel
          open={t('app.dashboard.motionOpen')}
          close={t('app.dashboard.motionClose')}
          note={t('app.dashboard.motionNote')}
        >
          <Button variant="secondary" size="sm">
            {t('app.dashboard.motionOpen')}
          </Button>
        </MotionPanel>
`,
  },
  // Measured, never guessed: the theme toggle's island is 35,964 B and this one 40,875 B under
  // Bun 1.4.4 (Solid, the ui runtime slot, Button, Presence, stagger, inView and layout), and the
  // two share no chunk, so the route loads 76,839 B. The base scaffold's 60kb held one island.
  {
    path: PAGE,
    find: "  budget: { js: '60kb' },",
    replace: "  budget: { js: '78kb' },",
  },
  {
    path: `${DIR}/page.test.ts`,
    find: "expect(page.config.budget.js).toBe('60kb');",
    replace: "expect(page.config.budget.js).toBe('78kb');",
  },
  {
    path: PAGE,
    find: '  AreaChart,\n',
    replace: '  AreaChart,\n  Button,\n',
  },
];

const source =
  (): string => `// DashboardMotion: the dashboard's motion, and the second module of this route a browser
// downloads. The server painted everything; this reveals it, never builds it.
//
//   Presence  a tips panel enters and exits, the node held until its exit has played
//   inView    nothing starts until its list is on screen, one observer for the page
//   stagger   the tiles, then the rows, each a beat after the last
//   layout    opening the panel slides what sits below it (FLIP, transform only)
//
// Named by SPECIFIER from the page, never by import (axiom 6). Timing is the motion scale's:
// \`snappy\` and \`gentle\` are springs, and under reduced motion every call finishes at once.

import { mountOver } from '@ultimat3/render/client';
import { Button, setSolidRuntime } from '@ultimat3/ui';
import { inView, layout, type MotionFrame, Presence, stagger } from '@ultimat3/ui/motion';
import type { JSX } from 'solid-js';
import {
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  onCleanup,
  onMount,
  useContext,
} from 'solid-js';
import { render } from 'solid-js/web';
import styles from './${ISLAND}.module.scss';

export interface DashboardMotionProps {
  /** Already translated: this runs in the browser, where \`t()\`'s catalog is not. */
  readonly open: string;
  readonly close: string;
  readonly note: string;
}

const ARRIVE: readonly MotionFrame[] = [
  { opacity: 0, y: '0.75rem' },
  { opacity: 1, y: 0 },
];

/** The whole page, asked through its root element: that is what a test's DOM and a browser share. */
const page = (): Element => document.documentElement;

/** A stat tile is two levels above its figure: \`StatTile\` hands a test only the number's hook. */
const tileOf = (figure: Element): Element => figure.parentElement?.parentElement ?? figure;

/** What the server rendered that arrives in order: the tiles, then the table's rows. */
function lists(): readonly (readonly Element[])[] {
  const tiles = [...page().querySelectorAll('[data-stat]')].map(tileOf);
  const rows = [...page().querySelectorAll('tbody tr')];
  return [tiles, rows].filter((items) => items.length > 0);
}

/** Each list waits until it is on screen, then staggers in. Returns the stop. */
function revealLists(): () => void {
  const stops = lists().map((items) =>
    inView(
      items[0]?.parentElement ?? page(),
      () => {
        stagger(items, ARRIVE, { easing: 'gentle' });
      },
      { amount: 0.1 },
    ),
  );
  return () => {
    for (const stop of stops) stop();
  };
}

/** Everything the panel pushes down: the tiles and the sections under it. */
const flowing = (): readonly Element[] => [
  ...lists().flat(),
  ...page().querySelectorAll('section'),
];

function DashboardMotion(props: DashboardMotionProps): JSX.Element {
  const [shown, setShown] = createSignal(false);
  onMount(() => onCleanup(revealLists()));
  const toggle = (): void => {
    layout(flowing(), () => setShown(!shown()), { duration: 'fast', easing: 'snappy' });
  };
  return (
    <div class={styles.panel}>
      <Button variant="secondary" size="sm" aria-expanded={shown()} onClick={toggle}>
        {shown() ? props.close : props.open}
      </Button>
      <Presence when={shown()} easing="snappy" class={styles.note}>
        <p>{props.note}</p>
      </Presence>
    </div>
  );
}

/**
 * The one export the hydration runtime calls. \`setSolidRuntime\` first: \`@ultimat3/ui\` reaches the
 * reactive graph through the runtime an entry registers. \`mountOver\` clears the server's button
 * for the live render and puts it back if the render throws.
 */
export function mount(el: HTMLElement, props: DashboardMotionProps): () => void {
  setSolidRuntime({
    createContext,
    useContext,
    createSignal,
    createMemo,
    createEffect,
    onCleanup,
    createRoot,
  });
  return mountOver(el, (root) => render(() => <DashboardMotion {...props} />, root));
}
`;

const style =
  (): string => `// Semantic tokens only; the motion itself is script, so no keyframe or transition lives here.
@use '@ultimat3/ui/tokens' as tokens;

.panel {
  display: grid;
  gap: tokens.space(3);
  justify-items: start;
}

.note {
  padding: tokens.space(3) tokens.space(4);
  border: 1px solid tokens.role('line');
  border-radius: tokens.radius('md');
  background: tokens.role('surface');
  color: tokens.role('fg');
}
`;

const states =
  (): string => `// The states \`${ISLAND}\` can be photographed in. PURE DATA: the one import is \`import type\`.
import { defineIslandStates } from '@ultimat3/testing';
import type { DashboardMotionProps } from './${ISLAND}.island';

export const dashboardMotionStates = defineIslandStates({
  island: '${DIR}/${ISLAND}.island.tsx',
  states: [
    {
      id: 'closed',
      title: 'the first paint: the panel is shut and the page below it is where the server put it',
      props: {
        open: 'Show tips',
        close: 'Hide tips',
        note: 'Tiles and rows arrive in order as they scroll into view.',
      } satisfies DashboardMotionProps,
    },
  ],
});
`;

const test =
  (): string => `// The motion island the browser runs: built with \`buildIslands\`, mounted over the server's button,
// and driven. What it pins: the panel is Presence's (absent until opened, held through its exit),
// and the page's own tiles are read by the stagger without throwing under a DOM with no
// IntersectionObserver or WAAPI — where \`inView\` and \`animate\` finish at once.
import { join } from 'node:path';
import { buildIslands } from '@ultimat3/cli';
import { describeIslandState, expect, test } from '@ultimat3/testing';
import { dashboardMotionStates } from './${ISLAND}.island.states';

const island = {
  build: buildIslands,
  root: join(import.meta.dir, '..', '..', '..', '..'),
  shell: '<button type="button">Show tips</button>',
};

describeIslandState(dashboardMotionStates, 'closed', island, (mounted) => {
  test('mount replaces the shell with the live control, panel shut', () => {
    expect(mounted().text('button')).toBe('Show tips');
    expect(mounted().find('[data-presence]')).toBeNull();
    expect(mounted().code).not.toMatch(/\\bReact\\b/);
  });

  test('a click opens the panel through Presence, and the label says what the next click does', () => {
    expect(mounted().fire('button', 'click')).toBe(true);
    expect(mounted().text('button')).toBe('Hide tips');
    expect(mounted().text('[data-presence]')).toBe(
      'Tiles and rows arrive in order as they scroll into view.',
    );
  });
});
`;

/** The island, its stylesheet, its states and its test. */
export const dashboardMotionFiles = (): readonly GeneratedFile[] => [
  { path: `${DIR}/${ISLAND}.island.tsx`, contents: source() },
  { path: `${DIR}/${ISLAND}.module.scss`, contents: style() },
  { path: `${DIR}/${ISLAND}.island.states.ts`, contents: states() },
  { path: `${DIR}/${ISLAND}.island.test.ts`, contents: test() },
];
