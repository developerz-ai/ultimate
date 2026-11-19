// `jobs.concurrency` and `jobs.maxInFlight` as per-CONTAINER totals: a supervised worker child's
// share of each (`ULTIMATE_CHILD=i/N`), the serial-queue rule, and an unsupervised boot unchanged.

import { afterEach, describe, expect, test } from 'bun:test';
import { JOBS_CONCURRENCY_DEFAULT } from '@ultimat3/core';
import { DEFAULT_QUEUE, resetJobs } from '@ultimat3/jobs';
import { workerConfigOf, workerOptionsFor } from './runtime-jobs';
import { childSlots, childWorkerShare } from './runtime-jobs-share';

afterEach(() => resetJobs());

const shares = (total: number, count: number): number[] =>
  Array.from({ length: count }, (_, index) => childSlots(total, { index, count }));

describe('childSlots', () => {
  test('a total at or above the child count is split, remainder to the lowest indices', () => {
    expect(shares(8, 2)).toEqual([4, 4]);
    expect(shares(10, 4)).toEqual([3, 3, 2, 2]);
    expect(shares(3, 2)).toEqual([2, 1]);
  });

  test('a total below the child count is served only by children with index < total', () => {
    // `concurrency: 1` across two children: ONE slot in the container, so the queue stays serial.
    expect(shares(1, 2)).toEqual([1, 0]);
    expect(shares(2, 4)).toEqual([1, 1, 0, 0]);
  });

  test('the shares always sum to the container total', () => {
    for (const total of [1, 2, 3, 7, 8, 13]) {
      for (const count of [1, 2, 3, 4, 8]) {
        expect(shares(total, count).reduce((sum, slots) => sum + slots, 0)).toBe(total);
      }
    }
  });
});

describe('childWorkerShare', () => {
  test('one number for every queue becomes a table of this child’s slots', () => {
    const share = childWorkerShare({
      queues: ['banks', 'mail'],
      concurrency: 3,
      maxInFlight: undefined,
      child: { index: 1, count: 2 },
    });
    expect(share).toEqual({ concurrency: { banks: 1, mail: 1 } });
  });

  test('a table is read per queue, an unnamed queue at the framework default', () => {
    const share = childWorkerShare({
      queues: ['banks', 'serial', 'other'],
      concurrency: { banks: 4, serial: 1 },
      maxInFlight: undefined,
      child: { index: 1, count: 2 },
    });
    expect(share.concurrency).toEqual({
      banks: 2,
      serial: 0,
      other: JOBS_CONCURRENCY_DEFAULT / 2,
    });
  });

  test('an inherited key is not a queue’s total (read by own key)', () => {
    const share = childWorkerShare({
      queues: ['constructor'],
      concurrency: {},
      maxInFlight: undefined,
      child: { index: 0, count: 2 },
    });
    expect(share.concurrency).toEqual({ constructor: JOBS_CONCURRENCY_DEFAULT / 2 });
  });

  test('maxInFlight is split too; a child past it claims nothing at all', () => {
    const input = { queues: ['banks'], concurrency: 8, maxInFlight: 1 } as const;
    expect(childWorkerShare({ ...input, child: { index: 0, count: 2 } })).toEqual({
      concurrency: { banks: 4 },
      maxInFlight: 1,
    });
    expect(childWorkerShare({ ...input, child: { index: 1, count: 2 } })).toEqual({
      concurrency: { banks: 0 },
    });
    expect(
      childWorkerShare({ ...input, maxInFlight: 5, child: { index: 1, count: 2 } }).maxInFlight,
    ).toBe(2);
  });
});

describe('workerOptionsFor, supervised', () => {
  test('ULTIMATE_CHILD splits the configured slots across the served queues', () => {
    const config = {
      ...workerConfigOf(undefined, { ULTIMATE_CHILD: '1/2', WORKER_QUEUES: undefined }),
      queues: ['banks', 'serial'],
      concurrency: { banks: 4, serial: 1 },
      maxInFlight: 6,
    };
    expect(config.child).toEqual({ index: 1, count: 2 });
    const options = workerOptionsFor(config);
    expect(options.queues).toEqual(['banks', 'serial']);
    expect(options.concurrency).toEqual({ banks: 2, serial: 0 });
    expect(options.maxInFlight).toBe(3);
  });

  test('a child with nothing configured shares the default queue at the default slots', () => {
    const options = workerOptionsFor(workerConfigOf(undefined, { ULTIMATE_CHILD: '0/2' }));
    expect(options.concurrency).toEqual({ [DEFAULT_QUEUE]: JOBS_CONCURRENCY_DEFAULT / 2 });
  });
});

describe('workerOptionsFor, unsupervised', () => {
  test('no ULTIMATE_CHILD: the slots reach jobWorker exactly as configured', () => {
    const base = workerConfigOf(undefined, {});
    expect(base.child).toBeUndefined();
    const config = { ...base, queues: ['banks'], concurrency: { banks: 1 }, maxInFlight: 1 };
    const options = workerOptionsFor(config);
    expect(options.concurrency).toEqual({ banks: 1 });
    expect(options.maxInFlight).toBe(1);
    expect('concurrency' in workerOptionsFor(base)).toBe(false);
  });
});
