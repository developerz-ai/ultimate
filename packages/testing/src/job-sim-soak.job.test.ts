// `worker-soak.job.test.ts`'s scenario on the shared simulated driver: ten jobs, three real workers'
// `tick()`, and the claimant of two of them killed the instant their work is recorded. Every job
// still finishes, none twice, none concurrently — with no `Bun.sleep`: the lease lapses because the
// frozen clock is moved past it. That file stays: `jobs` cannot import tier 5.

import { expect, test } from 'bun:test';
import { job, t } from '@ultimat3/jobs';
import { advanceClock, frozenNow } from './determinism';
import type { SimDecision, SimOp } from './job-sim-driver';
import { SEND_AND_ANSWER } from './job-sim-driver';
import { openSimWorld } from './job-sim-world';
import { captureNetwork, mockFetch, restoreCapturedNetwork } from './sealed-network';

const NUM_JOBS = 10;
const WORKERS = ['w1', 'w2', 'w3'];

test('N workers, two killed mid-flight: every job finishes exactly once, none orphaned', async () => {
  const executing = new Set<string>();
  const violations: string[] = [];
  const handle = job<{ n: number }>({
    tenant: 'none',
    name: 'simSoakJob',
    input: t.object({ n: t.number }),
    idempotencyKey: ({ n }) => `soak:${n}`,
    retry: { attempts: 5, backoff: 'fixed', delay: 0, jitter: false },
    run: async ({ jobId, step, input }) => {
      if (executing.has(jobId)) violations.push(`concurrent execution of ${jobId}`);
      executing.add(jobId);
      try {
        await step.run('work', async () => {
          await fetch(`https://work.example/${String(input.n)}`, { method: 'POST' });
          return 'ok';
        });
      } finally {
        executing.delete(jobId);
      }
    },
  });

  const chaos = new Set<string>();
  // Every OTHER job settles first, as in the original: a process dies with all it holds, and a run
  // whose step body ran but whose record had not landed runs again — at-least-once, not this test.
  const othersSettled = Promise.withResolvers<void>();
  let settled = 0;
  const landed = (op: SimOp): void => {
    if (op.call !== 'ack' || op.jobId === undefined || chaos.has(op.jobId)) return;
    settled += 1;
    if (settled === NUM_JOBS - chaos.size) othersSettled.resolve();
  };
  // The claimant of a chaos job dies the moment its `work` is recorded — before it can ack.
  const decide = (op: SimOp): SimDecision | Promise<SimDecision> =>
    op.call === 'put' && op.jobId !== undefined && chaos.has(op.jobId) && op.status === 'completed'
      ? othersSettled.promise.then((): SimDecision => ({ before: 'send', after: 'kill' }))
      : SEND_AND_ANSWER;

  const network = captureNetwork();
  mockFetch(/^https:\/\/work\.example\//, () => new Response('ok'));
  try {
    await using world = await openSimWorld({ seed: 1, decide, landed });
    const queued = [];
    for (let n = 1; n <= NUM_JOBS; n += 1) queued.push(await world.enqueue(handle, { n }));
    for (const one of queued.slice(0, 2)) chaos.add(one.id);

    let alive = [...WORKERS];
    for (let round = 0; round < 20; round += 1) {
      const ran = (await Promise.all(alive.map((worker) => world.tick(worker)))).flat();
      alive = alive.filter((worker) => !world.sim.isDead(worker));
      if (ran.length > 0) continue;
      const due = await world.nextDue();
      if (due === undefined) break;
      // The only legal way for a dead worker's lease to expire here: the frozen clock moves.
      advanceClock(Math.max(1, due - frozenNow().getTime()));
    }

    expect(WORKERS.filter((worker) => world.sim.isDead(worker)).length).toBeGreaterThan(0);
    const rows = await world.rows();
    expect(rows.filter((row) => row.state === 'done')).toHaveLength(NUM_JOBS);
    const work = world.effects().map((effect) => effect.key);
    expect(work).toHaveLength(NUM_JOBS);
    expect(new Set(work).size).toBe(NUM_JOBS);
    expect(violations).toEqual([]);
    expect(executing.size).toBe(0);
  } finally {
    restoreCapturedNetwork(network);
  }
});
