// The worker registry as `x deploy verify` reports it per container: N rows under one host for a
// container running N processes, only rows serving the build being verified.

import { describe, expect, test } from 'bun:test';
import type { WorkerRecord } from '@ultimat3/jobs';
import { resultData } from './deploy-verify-findings';
import { emptyTally, gradeQueues } from './deploy-verify-grade';
import { workerContainers } from './deploy-verify-processes';

const row = (id: string, host: string, extra: Partial<WorkerRecord> = {}): WorkerRecord => ({
  id,
  host,
  startedAt: 0,
  heartbeatAt: 0,
  queues: ['default'],
  concurrency: 4,
  inFlight: [],
  build: 'b2',
  ...extra,
});

describe('workerContainers', () => {
  test('a container of two processes is one host with two rows and their slots summed', () => {
    const workers = [
      row('w1', 'worker-b'),
      row('w2', 'worker-a'),
      row('w3', 'worker-a', { concurrency: 3 }),
    ];
    expect(workerContainers(workers, 'b2')).toEqual([
      { host: 'worker-a', processes: 2, slots: 7 },
      { host: 'worker-b', processes: 1, slots: 4 },
    ]);
  });

  test('draining rows and rows of another build are the roll, not this build', () => {
    const workers = [
      row('w1', 'worker-a'),
      row('w2', 'worker-a', { drainingAt: 5 }),
      row('w3', 'worker-old', { build: 'b1' }),
    ];
    expect(workerContainers(workers, 'b2')).toEqual([{ host: 'worker-a', processes: 1, slots: 4 }]);
  });
});

describe('resultData', () => {
  test('a grade read off the registry reports its containers; an ungraded one none', () => {
    const workers = [row('w1', 'worker-a'), row('w2', 'worker-a')];
    const grade = {
      ...gradeQueues({ build: 'b2', expected: ['default'], workers, depth: new Map(), idleOk: [] }),
      containers: workerContainers(workers, 'b2'),
    };
    const data = resultData('b2', 0, emptyTally(), grade);
    expect(data['queues']).toMatchObject({
      containers: [{ host: 'worker-a', processes: 2, slots: 8 }],
    });
    const bare = resultData(
      'b2',
      0,
      emptyTally(),
      gradeQueues({ build: 'b2', expected: [], workers, depth: new Map(), idleOk: [] }),
    );
    expect(bare['queues']).not.toHaveProperty('containers');
  });
});
