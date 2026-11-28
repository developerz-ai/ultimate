// A reference's measurements as framework vocabulary: `tokens.proposal.json` (a `defineTheme`
// argument) and `motion-map.json` (each animation as a `@ultimat3/ui/motion` call or effects entry).
//
// Durations and easings snap through the motion scale the shipped guards use
// (`templates/motion-scale.ts`), so research and the gate agree on what "base" means. Pure.

import type { Extraction, ObservedMotion } from './design-extract';
import {
  clusterPalette,
  type PaletteCluster,
  proposeColors,
  type ThemeTables,
  withNearestRoles,
} from './design-map-colors';
import type { DurationToken, EasingToken } from './templates/motion-scale';
import { snapDuration, snapEasing } from './templates/motion-scale';

export type { PaletteCluster, ThemeTables } from './design-map-colors';
export { clusterPalette } from './design-map-colors';

/**
 * `@ultimat3/ui`'s radius rungs in px, the ones a measured corner can mean. Not imported: the CLI
 * does not depend on `@ultimat3/ui`, and its barrel exports no radius table. `design-map.test.ts`
 * holds these to the canonical `_radius.scss`.
 */
export const RADIUS_RUNGS = { sm: 4, md: 8, lg: 12, xl: 16 } as const;
type RadiusRung = keyof typeof RADIUS_RUNGS;

/** The `defineTheme` argument `tokens.proposal.json` holds. */
export interface DesignProposal {
  readonly colors?: {
    readonly light?: Record<string, string>;
    readonly dark?: Record<string, string>;
  };
  readonly radius?: Partial<Record<RadiusRung, string>>;
  readonly motion?: MotionProposal;
}

export interface MotionProposal {
  readonly duration?: Partial<Record<Exclude<DurationToken, 'instant'>, string>>;
  readonly easing?: Partial<Record<EasingToken, string>>;
}

/** Corners past a rung's reach (a pill, a circle) are not a radius scale. */
const RADIUS_MAX = 64;

export function proposeRadius(
  radii: readonly { readonly px: number; readonly count: number }[],
): Partial<Record<RadiusRung, string>> {
  const best = new Map<RadiusRung, { px: number; count: number }>();
  for (const radius of radii) {
    if (radius.px <= 0 || radius.px > RADIUS_MAX) continue;
    let rung: RadiusRung = 'sm';
    let gap = Number.POSITIVE_INFINITY;
    for (const [name, px] of Object.entries(RADIUS_RUNGS) as [RadiusRung, number][]) {
      if (Math.abs(px - radius.px) < gap) {
        rung = name;
        gap = Math.abs(px - radius.px);
      }
    }
    const held = best.get(rung);
    if (held === undefined || radius.count > held.count) best.set(rung, radius);
  }
  return Object.fromEntries([...best].map(([rung, radius]) => [rung, `${String(radius.px)}px`]));
}

/** CSS's easing keywords as the control points they are. */
/** A Map: the key is a page's easing string, and `'constructor'` must miss, not hit a prototype. */
const KEYWORD_CURVES: ReadonlyMap<string, readonly number[]> = new Map([
  ['ease', [0.25, 0.1, 0.25, 1]],
  ['ease-in', [0.42, 0, 1, 1]],
  ['ease-out', [0, 0, 0.58, 1]],
  ['ease-in-out', [0.42, 0, 0.58, 1]],
]);

/** A curve's four control points, or `undefined` for `linear`, `steps()`, `linear()` and `other`. */
export function easingPoints(easing: string): readonly number[] | undefined {
  const keyword = KEYWORD_CURVES.get(easing);
  if (keyword !== undefined) return keyword;
  const match = /^cubic-bezier\(([^)]*)\)$/.exec(easing);
  if (match === null) return undefined;
  const points = (match[1] ?? '').split(',').map((part) => Number(part.trim()));
  return points.length === 4 && points.every(Number.isFinite) ? points : undefined;
}

/** A `linear()` with many stops is how a spring is written in CSS. */
const isSpring = (easing: string): boolean =>
  easing.startsWith('linear(') && easing.split(',').length >= 4;

const curveText = (points: readonly number[]): string => `cubic-bezier(${points.join(', ')})`;

/** How far a curve may overshoot: past it a `y` is a page's typo or a probe, not a tempo. */
const CURVE_Y_LIMIT = 10;
const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/;

/**
 * A curve `defineTheme` will take as written: x values in [0, 1], every point a plain decimal (a
 * page's `1.23e+23` prints as exponent notation, which no CSS curve pattern accepts) and no `y`
 * past `CURVE_Y_LIMIT`. Anything else is dropped from the proposal, never repaired.
 */
const isProposableCurve = (points: readonly number[]): boolean => {
  const [x1, y1, x2, y2] = points;
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return false;
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return false;
  if (Math.abs(y1) > CURVE_Y_LIMIT || Math.abs(y2) > CURVE_Y_LIMIT) return false;
  return points.every((point) => PLAIN_DECIMAL.test(String(point)));
};

/** The weighted median: what most of the page actually waits. */
function median(values: readonly { readonly value: number; readonly weight: number }[]): number {
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const half = sorted.reduce((sum, entry) => sum + entry.weight, 0) / 2;
  let seen = 0;
  for (const entry of sorted) {
    seen += entry.weight;
    if (seen >= half) return entry.value;
  }
  return sorted.at(-1)?.value ?? 0;
}

/**
 * The tempo: each rung the page's durations snap to, set to their weighted median; each easing
 * token, set to the curve the page used most for it. A loop's period is not a tempo, and a curve
 * whose x values leave [0, 1] is one CSS — and `defineTheme` — refuses.
 */
export function proposeMotion(motion: readonly ObservedMotion[]): MotionProposal {
  const timed = motion.filter((m) => m.trigger !== 'loop' && m.durationMs > 0);
  const durations = new Map<string, { value: number; weight: number }[]>();
  const curves = new Map<string, Map<string, number>>();
  for (const m of timed) {
    const rung = snapDuration(m.durationMs);
    durations.set(rung, [...(durations.get(rung) ?? []), { value: m.durationMs, weight: m.count }]);
    const points = easingPoints(m.easing);
    if (points === undefined) continue;
    if (!isProposableCurve(points)) continue;
    const token = snapEasing(points);
    const text = curveText(points);
    const counts = curves.get(token) ?? new Map<string, number>();
    counts.set(text, (counts.get(text) ?? 0) + m.count);
    curves.set(token, counts);
  }
  const duration = Object.fromEntries(
    [...durations].map(([rung, values]) => [rung, `${String(Math.round(median(values)))}ms`]),
  );
  const easing = Object.fromEntries(
    [...curves].map(([token, counts]) => [
      token,
      [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '',
    ]),
  );
  return {
    ...(Object.keys(duration).length === 0 ? {} : { duration }),
    ...(Object.keys(easing).length === 0 ? {} : { easing }),
  };
}

export interface MotionMapEntry {
  readonly module: '@ultimat3/ui/motion' | '@ultimat3/effects';
  /** A name the module exports — `animate`, `inView`, `Marquee`, … */
  readonly name: string;
  readonly observed: (Omit<ObservedMotion, 'count'> & { readonly count: number }) | null;
  readonly duration?: Exclude<DurationToken, 'instant'> | undefined;
  readonly easing?: EasingToken | undefined;
  readonly why: string;
}

const LAYOUT_PROPERTIES = new Set([
  'width',
  'height',
  'top',
  'left',
  'right',
  'bottom',
  'margin',
  'padding',
]);

function entryFor(m: ObservedMotion): Omit<MotionMapEntry, 'observed' | 'duration' | 'easing'> {
  if (isSpring(m.easing)) {
    return {
      module: '@ultimat3/ui/motion',
      name: 'springLinear',
      why: 'a linear() curve is a spring',
    };
  }
  if (m.trigger === 'loop') {
    const marquee = m.properties.some((p) => p === 'transform' || p.startsWith('translate'));
    return marquee
      ? { module: '@ultimat3/effects', name: 'Marquee', why: 'an endless transform is a marquee' }
      : { module: '@ultimat3/effects', name: 'Shimmer', why: 'an endless paint loop is a shimmer' };
  }
  if (m.trigger === 'scroll') {
    return m.durationMs === 0
      ? { module: '@ultimat3/ui/motion', name: 'scrollLinked', why: 'driven by a scroll timeline' }
      : { module: '@ultimat3/ui/motion', name: 'inView', why: 'started as it scrolled into view' };
  }
  if (m.properties.some((p) => LAYOUT_PROPERTIES.has(p))) {
    return {
      module: '@ultimat3/ui/motion',
      name: 'layout',
      why: 'animates a layout property: FLIP it with transforms instead',
    };
  }
  if (m.trigger === 'hover' || m.trigger === 'state') {
    return {
      module: '@ultimat3/ui/motion',
      name: 'motionTiming',
      why: `a ${m.trigger} transition`,
    };
  }
  return { module: '@ultimat3/ui/motion', name: 'animate', why: 'an entrance animation' };
}

/** Every distinct observed animation, then the effects the page's paint implies. */
export function motionMap(extraction: Extraction): MotionMapEntry[] {
  const entries: MotionMapEntry[] = extraction.motion.map((m) => {
    const points = easingPoints(m.easing);
    return {
      ...entryFor(m),
      observed: m,
      ...(m.durationMs > 0 && m.trigger !== 'loop' ? { duration: snapDuration(m.durationMs) } : {}),
      ...(points === undefined ? {} : { easing: snapEasing(points) }),
    };
  });
  if (extraction.backdrop.count > 0) {
    entries.push({
      module: '@ultimat3/effects',
      name: 'GlassSurface',
      observed: null,
      why: `${String(extraction.backdrop.count)} element(s) use backdrop-filter`,
    });
  }
  if (extraction.canvases > 0) {
    entries.push({
      module: '@ultimat3/effects',
      name: 'EffectCanvas',
      observed: null,
      why: `${String(extraction.canvases)} visible canvas element(s) — a drawn background`,
    });
  }
  return entries;
}

export interface DesignMapping {
  readonly proposal: DesignProposal;
  readonly palette: { readonly light: PaletteCluster[]; readonly dark: PaletteCluster[] };
  readonly motionMap: MotionMapEntry[];
}

/**
 * Both schemes' captures as one mapping. Colours need `tables` — without them (no `@ultimat3/ui`
 * to resolve) the proposal carries no colours, because nothing could check their contrast.
 */
export function mapDesign(
  captures: { readonly light: Extraction; readonly dark: Extraction },
  tables: ThemeTables | undefined,
): DesignMapping {
  const palette = {
    light: clusterPalette(captures.light.colors),
    dark: clusterPalette(captures.dark.colors),
  };
  const light = tables === undefined ? {} : proposeColors(palette.light, 'light', tables);
  const dark = tables === undefined ? {} : proposeColors(palette.dark, 'dark', tables);
  const colors = {
    ...(Object.keys(light).length === 0 ? {} : { light }),
    ...(Object.keys(dark).length === 0 ? {} : { dark }),
  };
  const radius = proposeRadius([...captures.light.radii, ...captures.dark.radii]);
  const motion = proposeMotion(captures.light.motion);
  return {
    proposal: {
      ...(Object.keys(colors).length === 0 ? {} : { colors }),
      ...(Object.keys(radius).length === 0 ? {} : { radius }),
      ...(Object.keys(motion).length === 0 ? {} : { motion }),
    },
    palette: {
      light:
        tables === undefined
          ? palette.light.slice(0, 16)
          : withNearestRoles(palette.light, 'light', tables),
      dark:
        tables === undefined
          ? palette.dark.slice(0, 16)
          : withNearestRoles(palette.dark, 'dark', tables),
    },
    motionMap: motionMap(captures.light),
  };
}
