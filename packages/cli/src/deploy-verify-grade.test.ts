// The grading behind `x deploy verify`, over plain samples and worker rows: no socket, no database.

import { describe, expect, test } from 'bun:test';
import type { WorkerRecord } from '@ultimat3/jobs';
import type { SampleTally } from './deploy-verify-grade';
import {
  emptyTally,
  failureOf,
  foldSample,
  gradeQueues,
  tallyToJson,
  windowClosed,
} from './deploy-verify-grade';

const BUILD = 'b-new';

/** `[at, status, build, cached?]` per sample; a `null` status is a sample nothing answered. */
const tallyOf = (
  ...samples: readonly (readonly [number, number | null, string | null, boolean?])[]
): SampleTally =>
  samples.reduce(
    (tally, [at, status, build, cached]) =>
      foldSample(tally, { at, status, build, cached: cached === true }, BUILD),
    emptyTally(),
  );

/** Samples every 5 s from 0: `true` the new build, `false` an old one, all 200. */
const rollOf = (...good: readonly boolean[]): SampleTally =>
  tallyOf(...good.map((isNew, index) => [index * 5_000, 200, isNew ? BUILD : 'b-old'] as const));

const row = (over: Partial<WorkerRecord> = {}): WorkerRecord => ({
  id: 'w1',
  host: 'pod-1',
  startedAt: 0,
  heartbeatAt: 0,
  queues: ['mail'],
  concurrency: 1,
  inFlight: [],
  build: BUILD,
  ...over,
});

const grade = (input: {
  readonly expected?: readonly string[];
  readonly workers?: readonly WorkerRecord[];
  readonly depth?: Readonly<Record<string, number>>;
  readonly idleOk?: readonly string[];
}) =>
  gradeQueues({
    build: BUILD,
    expected: input.expected ?? ['mail'],
    workers: input.workers ?? [],
    depth: new Map(Object.entries(input.depth ?? {})),
    idleOk: input.idleOk ?? [],
  });

describe('the window', () => {
  test('closes once the good samples span it', () => {
    expect(windowClosed(tallyOf([0, 200, BUILD], [5, 200, BUILD]), 10, 2)).toBe(false);
    expect(windowClosed(tallyOf([0, 200, BUILD], [5, 200, BUILD], [10, 200, BUILD]), 10, 2)).toBe(
      true,
    );
  });

  test('an old build mid-window restarts it: the mix of a roll is not stability', () => {
    const mixed = tallyOf([0, 200, BUILD], [5, 200, 'b-old'], [10, 200, BUILD]);
    expect(windowClosed(mixed, 10, 2)).toBe(false);
    expect(
      windowClosed(
        tallyOf([0, 200, BUILD], [5, 200, 'b-old'], [10, 200, BUILD], [20, 200, BUILD]),
        10,
        2,
      ),
    ).toBe(true);
  });

  test('a 503 mid-window restarts it, even from the right build', () => {
    expect(windowClosed(tallyOf([0, 200, BUILD], [5, 503, BUILD], [10, 200, BUILD]), 10, 2)).toBe(
      false,
    );
  });

  test('a sample nothing answered restarts it', () => {
    expect(windowClosed(tallyOf([0, 200, BUILD], [5, null, null], [10, 200, BUILD]), 10, 2)).toBe(
      false,
    );
  });

  test('a 2xx with the wrong build, or none, is not a good sample', () => {
    expect(tallyOf([0, 200, 'b-old'], [1, 200, null]).good).toBe(0);
    expect(windowClosed(tallyOf([0, 200, null]), 0, 1)).toBe(false);
  });

  // A fleet stuck partway: 13 good in a row happen by chance, so a run alone is not stability.
  test('a fleet stuck with old pods does not close: the bad rate since the first good is bounded', () => {
    const stuck = [true, true, true, false, false, ...Array<boolean>(13).fill(true)];
    // 13 good span 60 s, but 2 old of 18 is over one per 12 samples.
    expect(windowClosed(rollOf(...stuck), 60_000, 12)).toBe(false);
    // Only enough good answers after it dilute the two old ones below the bound.
    expect(windowClosed(rollOf(...stuck, ...Array<boolean>(6).fill(true)), 60_000, 12)).toBe(false);
    expect(windowClosed(rollOf(...stuck, ...Array<boolean>(7).fill(true)), 60_000, 12)).toBe(true);
  });

  test('old answers before the first good one are the roll, not instability', () => {
    const roll = [false, false, false, false, ...Array<boolean>(13).fill(true)];
    expect(windowClosed(rollOf(...roll), 60_000, 12)).toBe(true);
  });

  test('a cached answer is bad, even naming the build: a CDN is not the fleet', () => {
    const cached = tallyOf([0, 200, BUILD, true], [5, 200, BUILD, true]);
    expect(cached.good).toBe(0);
    expect(windowClosed(cached, 0, 1)).toBe(false);
    expect(tallyToJson(cached).cached).toBe(2);
  });

  test('--window 0 is a value: the build answered once', () => {
    expect(windowClosed(tallyOf([0, 200, BUILD]), 0, 1)).toBe(true);
    expect(windowClosed(emptyTally(), 0, 1)).toBe(false);
  });
});

describe('the tally', () => {
  test('counts by build and by status, and says when nothing answered', () => {
    const json = tallyToJson(
      tallyOf(
        [0, 200, BUILD],
        [1, 200, 'b-old'],
        [2, 503, 'b-old'],
        [3, null, null],
        [4, 301, null],
      ),
    );
    expect(json).toEqual({
      total: 5,
      good: 1,
      byBuild: { [BUILD]: 1, 'b-old': 2 },
      byStatus: { '200': 2, '503': 1, '301': 1, unreachable: 1 },
      share: { [BUILD]: 0.2, 'b-old': 0.4 },
      cached: 0,
    });
  });

  test('a build the server names `__proto__` is a count, not a prototype', () => {
    const json = tallyToJson(tallyOf([0, 200, '__proto__'], [1, 200, '__proto__']));
    expect(Object.entries(json.byBuild)).toEqual([['__proto__', 2]]);
  });
});

describe('the failure class', () => {
  test('never the build, with another one answering: mismatch', () => {
    expect(failureOf(tallyOf([0, 200, 'b-old']), BUILD)).toBe('X_DEPLOY_BUILD_MISMATCH');
  });

  test('nothing answered at all: mismatch, because no sample carried the build', () => {
    expect(failureOf(tallyOf([0, null, null]), BUILD)).toBe('X_DEPLOY_BUILD_MISMATCH');
    expect(failureOf(emptyTally(), BUILD)).toBe('X_DEPLOY_BUILD_MISMATCH');
  });

  test('a 2xx with no header and no build ever named: unstamped', () => {
    expect(failureOf(tallyOf([0, 200, null]), BUILD)).toBe('X_DEPLOY_BUILD_UNSTAMPED');
    expect(failureOf(tallyOf([0, 503, null], [1, 200, null]), BUILD)).toBe(
      'X_DEPLOY_BUILD_UNSTAMPED',
    );
  });

  test('an old build beside an unstamped answer is a mismatch: a build did answer', () => {
    expect(failureOf(tallyOf([0, 200, null], [1, 200, 'b-old']), BUILD)).toBe(
      'X_DEPLOY_BUILD_MISMATCH',
    );
  });

  test('a non-2xx with no header stamps nothing: a proxy 502 is not an unstamped app', () => {
    expect(failureOf(tallyOf([0, 502, null]), BUILD)).toBe('X_DEPLOY_BUILD_MISMATCH');
  });

  test('the build answered and the window never closed: unstable', () => {
    expect(failureOf(tallyOf([0, 200, BUILD], [1, 503, 'b-old']), BUILD)).toBe('X_DEPLOY_UNSTABLE');
    expect(failureOf(tallyOf([0, 503, BUILD]), BUILD)).toBe('X_DEPLOY_UNSTABLE');
  });
});

describe('the queues', () => {
  test('a serving row of this build serves its queue', () => {
    expect(grade({ workers: [row()] })).toEqual({
      graded: true,
      served: ['mail'],
      unserved: [],
      idle: [],
    });
  });

  test('no row at all leaves the queue unserved, named, with no build to show', () => {
    expect(grade({}).unserved).toEqual([{ queue: 'mail', builds: [], depth: 0 }]);
  });

  test('a row of the previous build serves nothing, and names itself: a stalled roll', () => {
    const graded = grade({ workers: [row({ build: 'b-old' })], depth: { mail: 3 } });
    expect(graded.served).toEqual([]);
    expect(graded.unserved).toEqual([{ queue: 'mail', builds: ['b-old'], depth: 3 }]);
  });

  test('a draining row of this build serves nothing', () => {
    const graded = grade({ workers: [row({ drainingAt: 5 })] });
    expect(graded.served).toEqual([]);
    expect(graded.unserved[0]?.builds).toEqual([BUILD]);
  });

  test('a row that names no build (a worker from before the column) serves nothing', () => {
    const { build: _build, ...unnamed } = row();
    const graded = grade({ workers: [unnamed] });
    expect(graded.served).toEqual([]);
    expect(graded.unserved[0]?.builds).toEqual(['unknown']);
  });

  test('a row serving another queue does not serve this one', () => {
    expect(grade({ workers: [row({ queues: ['other'] })] }).served).toEqual([]);
  });

  test('--idle-ok with depth 0 passes as idle', () => {
    const graded = grade({ idleOk: ['mail'], depth: { mail: 0 } });
    expect(graded).toEqual({ graded: true, served: [], unserved: [], idle: ['mail'] });
    // A queue `stats()` has no row for holds nothing: depth 0 by absence.
    expect(grade({ idleOk: ['mail'] }).idle).toEqual(['mail']);
  });

  test('--idle-ok with depth 1 fails: the pool has work and no worker', () => {
    const graded = grade({ idleOk: ['mail'], depth: { mail: 1 } });
    expect(graded.idle).toEqual([]);
    expect(graded.unserved).toEqual([{ queue: 'mail', builds: [], depth: 1 }]);
  });

  test('--idle-ok does not exempt a queue with an old worker and work waiting', () => {
    const graded = grade({
      idleOk: ['mail'],
      depth: { mail: 1 },
      workers: [row({ build: 'b-old' })],
    });
    expect(graded.unserved[0]?.builds).toEqual(['b-old']);
  });

  test('a served queue on --idle-ok is served, not idle', () => {
    const graded = grade({ idleOk: ['mail'], workers: [row()] });
    expect(graded.served).toEqual(['mail']);
    expect(graded.idle).toEqual([]);
  });
});
