// The pure half of `boot-large-app.bench.ts`: the generated resources' names, what the fixture is
// counted as, and how a set of boots is reduced to one figure. Split from the harness so the shape
// is tested without generating an app or booting one.

import { median } from './boot-vs-files-shape';

/** The plan's large app: the reference app plus 150 generated resources, ~5,000 TS files. */
export const DEFAULT_RESOURCES = 150;

/** `bench-r007` — zero-padded, so the generated slices sort in the order they were made. */
export const resourceName = (index: number): string => `bench-r${String(index).padStart(3, '0')}`;

/** What the fixture is, so a figure names the app it was taken on. */
export interface AppShape {
  readonly resources: number;
  /** Every `.ts`/`.tsx` file outside `node_modules` — the count the plan's "5k files" is. */
  readonly tsFiles: number;
  readonly entities: number;
  readonly actions: number;
  readonly queries: number;
  readonly jobs: number;
  readonly routes: number;
  readonly islands: number;
}

/** The manifest's list lengths that `AppShape` reports; a list that is absent counts 0. */
export function manifestCounts(
  manifest: unknown,
): Pick<AppShape, 'entities' | 'actions' | 'queries' | 'jobs' | 'routes'> {
  const length = (key: string): number => {
    if (typeof manifest !== 'object' || manifest === null) return 0;
    const list: unknown = (manifest as Record<string, unknown>)[key];
    return Array.isArray(list) ? list.length : 0;
  };
  return {
    entities: length('entities'),
    actions: length('actions'),
    queries: length('queries'),
    jobs: length('jobs'),
    routes: length('routes'),
  };
}

/** A path the counts include: TypeScript, and never anything under a `node_modules`. */
export const countsAsSource = (path: string): boolean =>
  /\.tsx?$/.test(path) && !path.split('/').includes('node_modules');

/** One boot: wall clock from spawn to the first 200 on `/`, and the process group's peak RSS. */
export interface Boot {
  readonly toFirst200Ms: number;
  readonly peakRssMb: number;
}

/** The figure a set of boots reports: the median of each, and every run beside it. */
export interface BootSummary {
  readonly medianMs: number;
  readonly medianPeakRssMb: number;
  readonly runs: readonly Boot[];
}

export function summarise(runs: readonly Boot[]): BootSummary {
  return {
    medianMs: median(runs.map((run) => run.toFirst200Ms)),
    medianPeakRssMb: median(runs.map((run) => run.peakRssMb)),
    runs,
  };
}

/** Whether a median met its target — the plan's done-when, stated beside the figure. */
export const verdict = (medianMs: number, targetMs: number): 'met' | 'missed' =>
  medianMs < targetMs ? 'met' : 'missed';
