// The verdict behind `x deploy verify`, pure: samples folded into a tally and a window, worker rows
// graded per queue. No socket, no database, no clock — `cmd-deploy-verify.ts` owns the waiting.

import type { WorkerRecord } from '@ultimat3/jobs';

/** One `GET /readyz`. A `null` status is a sample nothing answered: refused, reset, timed out. */
export interface Sample {
  /** Monotonic ms, when the answer arrived. */
  readonly at: number;
  readonly status: number | null;
  /** `x-ultimate-build` as answered, on any status. `null`: no header, or an empty one. */
  readonly build: string | null;
  /** Answered from a cache (`Age` > 0): a CDN's copy says nothing about the fleet behind it. */
  readonly cached: boolean;
}

/** Samples since the first good one: what the bad rate is measured over. */
export interface SinceGood {
  readonly total: number;
  readonly bad: number;
}

export interface SampleTally {
  readonly total: number;
  readonly good: number;
  /** Built with computed keys and read through `Object.hasOwn`: a server names these. */
  readonly byBuild: Readonly<Record<string, number>>;
  readonly byStatus: Readonly<Record<string, number>>;
  /** 2xx answers that named no build: what `X_DEPLOY_BUILD_UNSTAMPED` is told apart by. */
  readonly unstamped: number;
  /** When the current run of good samples began. `null`: the last sample broke it. */
  readonly goodSince: number | null;
  readonly lastAt: number | null;
  readonly cached: number;
  /** `null` until a sample was good: old answers before it are the roll, not instability. */
  readonly sinceGood: SinceGood | null;
}

/** The `byStatus` key of a sample nothing answered. */
export const UNREACHABLE = 'unreachable';

/** The label `builds` gives a row with no build: a worker from before the column. */
export const UNKNOWN_BUILD = 'unknown';

export const emptyTally = (): SampleTally => ({
  total: 0,
  good: 0,
  byBuild: {},
  byStatus: {},
  unstamped: 0,
  goodSince: null,
  lastAt: null,
  cached: 0,
  sinceGood: null,
});

const countOf = (counts: Readonly<Record<string, number>>, key: string): number =>
  Object.hasOwn(counts, key) ? (counts[key] ?? 0) : 0;

const bump = (
  counts: Readonly<Record<string, number>>,
  key: string,
): Readonly<Record<string, number>> => ({ ...counts, [key]: countOf(counts, key) + 1 });

const is2xx = (status: number | null): boolean => status !== null && status >= 200 && status < 300;

export function foldSample(tally: SampleTally, sample: Sample, build: string): SampleTally {
  const good = is2xx(sample.status) && sample.build === build && !sample.cached;
  const since = tally.sinceGood;
  return {
    total: tally.total + 1,
    good: tally.good + (good ? 1 : 0),
    byBuild: sample.build === null ? tally.byBuild : bump(tally.byBuild, sample.build),
    byStatus: bump(tally.byStatus, sample.status === null ? UNREACHABLE : String(sample.status)),
    unstamped: tally.unstamped + (is2xx(sample.status) && sample.build === null ? 1 : 0),
    // Any bad sample restarts it: an old build mid-window is a roll still in flight.
    goodSince: good ? (tally.goodSince ?? sample.at) : null,
    lastAt: sample.at,
    cached: tally.cached + (sample.cached ? 1 : 0),
    sinceGood:
      since === null
        ? good
          ? { total: 1, bad: 0 }
          : null
        : { total: since.total + 1, bad: since.bad + (good ? 0 : 1) },
  };
}

/**
 * Closed when the good run spans `windowMs` AND, since the first good sample, fewer than one sample
 * in `perWindow` (`ceil(window / interval)`) was bad. The run alone passed a fleet stuck with 10% old
 * pods 99.6% of the time: thirteen good in a row happen by chance. `--window 0` closes on the first
 * good sample: the build answered once.
 */
export const windowClosed = (tally: SampleTally, windowMs: number, perWindow: number): boolean =>
  tally.goodSince !== null &&
  tally.lastAt !== null &&
  tally.lastAt - tally.goodSince >= windowMs &&
  tally.sinceGood !== null &&
  tally.sinceGood.bad * perWindow < tally.sinceGood.total;

export type SampleFailure =
  | 'X_DEPLOY_BUILD_MISMATCH'
  | 'X_DEPLOY_BUILD_UNSTAMPED'
  | 'X_DEPLOY_UNSTABLE';

/**
 * Why a wait ended without the window closing. "The build answered" reads the header on any status:
 * a new pod answering 503 is the build, unstable, and telling that operator it never shipped would
 * send them to the wrong problem. Unstamped only when no sample named any build, because one old
 * build beside it means the header works and the build is what is missing.
 */
export function failureOf(tally: SampleTally, build: string): SampleFailure {
  if (countOf(tally.byBuild, build) > 0) return 'X_DEPLOY_UNSTABLE';
  const namedNone = Object.keys(tally.byBuild).length === 0;
  return namedNone && tally.unstamped > 0 ? 'X_DEPLOY_BUILD_UNSTAMPED' : 'X_DEPLOY_BUILD_MISMATCH';
}

/** The tally as `--json` reports it. The window's bookkeeping stays out. */
export const tallyToJson = (tally: SampleTally) => ({
  total: tally.total,
  good: tally.good,
  byBuild: { ...tally.byBuild },
  byStatus: { ...tally.byStatus },
  /** Each build's share of every sample, to three places: a stuck roll reads as its old share. */
  share: Object.fromEntries(
    Object.entries(tally.byBuild).map(([name, count]) => [
      name,
      Math.round((count / Math.max(1, tally.total)) * 1000) / 1000,
    ]),
  ),
  cached: tally.cached,
});

export interface UnservedQueue {
  readonly queue: string;
  /** Every build a live row claiming this queue runs, sorted: a stalled roll reads as one. */
  readonly builds: readonly string[];
  readonly depth: number;
}

export interface QueueGrade {
  readonly graded: boolean;
  readonly served: readonly string[];
  readonly unserved: readonly UnservedQueue[];
  /** On `--idle-ok`, no serving worker, depth 0. */
  readonly idle: readonly string[];
}

/** No `DATABASE_URL`, or a window that never closed: nothing was read, so nothing passed. */
export const UNGRADED: QueueGrade = Object.freeze({
  graded: false,
  served: [],
  unserved: [],
  idle: [],
});

export interface QueueGradeInput {
  readonly build: string;
  readonly expected: readonly string[];
  readonly workers: readonly WorkerRecord[];
  /** Work a worker would have to run now, per queue. A queue with no entry holds none. */
  readonly depth: ReadonlyMap<string, number>;
  readonly idleOk: readonly string[];
}

export function gradeQueues(input: QueueGradeInput): QueueGrade {
  const served: string[] = [];
  const unserved: UnservedQueue[] = [];
  const idle: string[] = [];
  for (const queue of input.expected) {
    const claiming = input.workers.filter((worker) => worker.queues.includes(queue));
    const serving = claiming.some(
      (worker) => worker.drainingAt === undefined && worker.build === input.build,
    );
    const depth = input.depth.get(queue) ?? 0;
    if (serving) served.push(queue);
    else if (depth === 0 && input.idleOk.includes(queue)) idle.push(queue);
    else {
      const builds = new Set(claiming.map((worker) => worker.build ?? UNKNOWN_BUILD));
      unserved.push({ queue, builds: [...builds].sort(), depth });
    }
  }
  return { graded: true, served, unserved, idle };
}
