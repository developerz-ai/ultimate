// The motion scale a guard (and `x design research`) snaps a literal onto: `@ultimat3/ui/tokens`'
// durations in ms and easings as control points, and the two functions that answer "which token is
// this closest to". One module, two readers: the shipped guards embed `MOTION_SCALE_SOURCE` into
// the file they emit (a guard imports nothing but types), and D1 imports the typed API directly.
// `motion-scale.test.ts` runs the embedded text against the typed functions, so they cannot drift,
// and `scaffold-guards-style.test.ts` holds both to the token package's own SCSS.

/** `@ultimat3/ui/tokens`' duration scale, in ms. `instant` is no motion at all and is never a snap. */
export const MOTION_DURATIONS = [
  ['instant', 0],
  ['fast', 120],
  ['base', 220],
  ['slow', 400],
  ['slower', 640],
] as const;

/** `@ultimat3/ui/tokens`' easing curves: the control points, comma-joined, to the token's name. */
export const MOTION_EASINGS = {
  '0.16,1,0.3,1': 'out',
  '0.5,0,0.75,0': 'in',
  '0.65,0,0.35,1': 'in-out',
  '0.34,1.56,0.64,1': 'spring',
} as const;

export type DurationToken = (typeof MOTION_DURATIONS)[number][0];
export type EasingToken = (typeof MOTION_EASINGS)[keyof typeof MOTION_EASINGS];

/** The step a duration means: exact where it is one, the nearest where it is not. */
export function snapDuration(ms: number): Exclude<DurationToken, 'instant'> {
  let best: Exclude<DurationToken, 'instant'> = 'base';
  let gap = Number.POSITIVE_INFINITY;
  for (const [name, at] of MOTION_DURATIONS) {
    // A time someone wrote is never repaired to nothing.
    if (name === 'instant') continue;
    if (Math.abs(at - ms) < gap) {
      best = name;
      gap = Math.abs(at - ms);
    }
  }
  return best;
}

/** The curve a `cubic-bezier(…)` means: exact where it is one, the nearest control points where not. */
export function snapEasing(points: string | readonly number[]): EasingToken {
  const given =
    typeof points === 'string' ? points.split(',').map((part) => Number(part.trim())) : [...points];
  let best: EasingToken = 'out';
  let gap = Number.POSITIVE_INFINITY;
  for (const [curve, name] of Object.entries(MOTION_EASINGS)) {
    const distance = curve
      .split(',')
      .reduce((sum, value, index) => sum + (Number(value) - (given[index] ?? Number.NaN)) ** 2, 0);
    if (distance < gap) {
      best = name;
      gap = distance;
    }
  }
  return best;
}

/**
 * The same scale and functions as TypeScript text for a guard file to carry, types and all. It is
 * written out and not derived from the functions above (`motion-scale.test.ts` holds the two
 * equal): a function's `toString()` is erased JavaScript, which an app's strict `tsc` would refuse.
 */
export const MOTION_SCALE_SOURCE = `/** \`@ultimat3/ui/tokens\`' duration scale, in ms. */
export const DURATIONS: readonly (readonly [string, number])[] = [
  ['instant', 0],
  ['fast', 120],
  ['base', 220],
  ['slow', 400],
  ['slower', 640],
];
/** \`@ultimat3/ui/tokens\`' easing curves, as the control points each one is. */
export const EASINGS: Readonly<Record<string, string>> = {
  '0.16,1,0.3,1': 'out',
  '0.5,0,0.75,0': 'in',
  '0.65,0,0.35,1': 'in-out',
  '0.34,1.56,0.64,1': 'spring',
};

/** The step a duration means: exact where it is one, the nearest where it is not. */
const durationFor = (ms: number): string => {
  let best = 'base';
  let gap = Number.POSITIVE_INFINITY;
  for (const [name, at] of DURATIONS) {
    // \`instant\` is no motion at all; a time someone wrote is never repaired to nothing.
    if (name === 'instant') continue;
    if (Math.abs(at - ms) < gap) {
      best = name;
      gap = Math.abs(at - ms);
    }
  }
  return best;
};

/** The curve a \`cubic-bezier(…)\` means: exact where it is one, the nearest control points where not. */
const easingFor = (curve: string): string => {
  const given = curve.split(',').map((part) => Number(part.trim()));
  let best = 'out';
  let gap = Number.POSITIVE_INFINITY;
  for (const [points, name] of Object.entries(EASINGS)) {
    const distance = points
      .split(',')
      .reduce((sum, value, index) => sum + (Number(value) - (given[index] ?? Number.NaN)) ** 2, 0);
    if (distance < gap) {
      best = name;
      gap = distance;
    }
  }
  return best;
};
`;
