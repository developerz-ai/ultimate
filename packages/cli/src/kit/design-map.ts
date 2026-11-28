// The motion and effects table the kit advertises: each design need, the one `@ultimat3/*` export
// that answers it. Data, so `design-map.test.ts` can prove every subpath and symbol named here is
// actually shipped — the kit must never send an agent to an API that does not exist.

export interface DesignMapRow {
  /** What the design asks for, in the words a reference or a request uses. */
  readonly need: string;
  /** The package subpath, exactly as an app imports it. */
  readonly from: '@ultimat3/ui/motion' | '@ultimat3/effects' | '@ultimat3/ui';
  /** Value exports of that subpath, each imported by the test. */
  readonly symbols: readonly string[];
  /** The idiom, or the rule that makes it the only way. */
  readonly how: string;
}

export const DESIGN_MAP: readonly DesignMapRow[] = [
  {
    need: 'a duration or easing',
    from: '@ultimat3/ui/motion',
    symbols: ['motionTiming'],
    how: 'reads the theme’s motion scale; never a literal (`raw-motion`)',
  },
  {
    need: 'a spring',
    from: '@ultimat3/ui/motion',
    symbols: ['springLinear', 'animate'],
    how: '`gentle` · `snappy` · `bouncy`, emitted as CSS `linear()`',
  },
  {
    need: 'enter / exit (AnimatePresence)',
    from: '@ultimat3/ui/motion',
    symbols: ['Presence', 'PresenceList'],
    how: 'the node is held until its exit finishes',
  },
  {
    need: 'staggered list, reveal on scroll (whileInView)',
    from: '@ultimat3/ui/motion',
    symbols: ['stagger', 'inView'],
    how: 'one IntersectionObserver per module',
  },
  {
    need: 'scroll-linked progress (useScroll)',
    from: '@ultimat3/ui/motion',
    symbols: ['scrollLinked'],
    how: 'CSS `animation-timeline` where the browser has it',
  },
  {
    need: 'layout animation, reorder (layout / layoutId)',
    from: '@ultimat3/ui/motion',
    symbols: ['layout'],
    how: 'FLIP on transform; across routes, the `view-transition-name` mixin',
  },
  {
    need: 'a per-frame loop',
    from: '@ultimat3/ui/motion',
    symbols: ['frameLoop', 'motionAllowed', 'onMotionChange'],
    how: 'stops on reduced motion, hidden tab, offscreen, pause (`raw-frame-loop`)',
  },
  {
    need: 'a pause control (WCAG 2.2.2)',
    from: '@ultimat3/ui',
    symbols: ['MotionToggle'],
    how: 'sets `data-motion`; every loop and effect obeys it',
  },
  {
    need: 'an animated background',
    from: '@ultimat3/effects',
    symbols: ['Aurora', 'GradientOrbs', 'MosaicGrid', 'GridGlow', 'Noise'],
    how: 'CSS tier first: 0 kB JS on `site/`',
  },
  {
    need: 'a shader background',
    from: '@ultimat3/effects',
    symbols: ['ShaderBackground'],
    how: '`preset: mesh | grain | dots`; WebGL2 in an island, static frame otherwise',
  },
  {
    need: 'a card or surface that reacts',
    from: '@ultimat3/effects',
    symbols: ['SpotlightCard', 'Tilt', 'GlassSurface'],
    how: 'keyboard focus gets the same highlight; off for coarse pointers',
  },
  {
    need: 'moving text',
    from: '@ultimat3/effects',
    symbols: ['Marquee', 'TextReveal', 'CountUp', 'Shimmer'],
    how: 'one readable node; the split copy is `aria-hidden`',
  },
  {
    need: 'a canvas of your own',
    from: '@ultimat3/effects',
    symbols: ['EffectCanvas'],
    how: '`fallback` is required (`effect-without-fallback`)',
  },
];

/** The table as the `design-research` skill prints it. */
export const designMapTable = (): string =>
  [
    '| Need | Import | From | How |',
    '|---|---|---|---|',
    ...DESIGN_MAP.map(
      (row) =>
        `| ${row.need} | ${row.symbols.map((symbol) => `\`${symbol}\``).join(', ')} | \`${row.from}\` | ${row.how} |`,
    ),
  ].join('\n');
