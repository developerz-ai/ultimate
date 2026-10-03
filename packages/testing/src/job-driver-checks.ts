// What every `JobDriver` must do, as checks over a driver: claim, ack, nack, the claim fence, lease
// expiry and the burial of a row whose lease lapsed on its final attempt. A custom `claim` that
// ignored `onExhausted` / `dropExhausted` compiled and re-claimed a poisoned row forever.
// Type-only imports: the barrel never loads `@ultimat3/jobs`.

import { expect } from 'bun:test';
import type { ClaimOptions, JobDriver, JobRecord, QueueStats } from '@ultimat3/jobs';

export interface JobDriverCheck {
  readonly name: string;
  run(driver: JobDriver): Promise<void>;
}

let minted = 0;

/** A queue and a job name of this check's own, so checks sharing one store never see each other. */
const scope = (): { readonly queue: string; readonly name: string } => {
  minted += 1;
  const tag = `${process.pid.toString(36)}-${minted.toString(36)}`;
  return { queue: `conformance-${tag}`, name: `conformance.job-${tag}` };
};

const enqueue = async (
  driver: JobDriver,
  at: { readonly queue: string; readonly name: string },
  maxAttempts: number,
  key = 'k',
): Promise<string> =>
  (
    await driver.enqueue({
      name: at.name,
      queue: at.queue,
      input: {},
      idempotencyKey: key,
      maxAttempts,
    })
  ).id;

const claim = (
  driver: JobDriver,
  queue: string,
  workerId: string,
  extra: Partial<ClaimOptions> = {},
) => driver.claim({ queues: [queue], limit: 10, visibilityTimeoutMs: 30_000, workerId, ...extra });

const statsOf = async (driver: JobDriver, queue: string): Promise<QueueStats | undefined> =>
  (await driver.stats()).find((each) => each.queue === queue);

interface Lapsed {
  readonly id: string;
  readonly queue: string;
  readonly reported: readonly (readonly JobRecord[])[];
  /** How many rows the second claim handed out. */
  readonly handed: number;
}

/**
 * Two claims, the first with a lease that has already lapsed (0 ms): the second re-claims the row
 * or, on its final attempt, buries it. `drop` names the job in `dropExhausted`.
 */
async function lapse(driver: JobDriver, maxAttempts: number, drop = false): Promise<Lapsed> {
  const at = scope();
  const id = await enqueue(driver, at, maxAttempts);
  expect(await claim(driver, at.queue, 'w1', { visibilityTimeoutMs: 0 })).toHaveLength(1);
  const reported: JobRecord[][] = [];
  const second = await claim(driver, at.queue, 'w2', {
    ...(drop ? { dropExhausted: [at.name] } : {}),
    onExhausted: (dead) => reported.push([...dead]),
  });
  return { id, queue: at.queue, reported, handed: second.length };
}

const buried = (lapsed: Lapsed): readonly (readonly [string, string])[][] =>
  lapsed.reported.map((rows) => rows.map((row) => [row.id, row.state] as const));

export const JOB_DRIVER_CHECKS: readonly JobDriverCheck[] = [
  {
    name: 'a row is claimed once, and an ack by its claim settles it',
    async run(driver) {
      const at = scope();
      const id = await enqueue(driver, at, 3);
      const [first, ...rest] = await claim(driver, at.queue, 'w1');
      expect(rest).toEqual([]);
      expect(first).toMatchObject({ id, state: 'running', claimedBy: 'w1' });
      expect(await claim(driver, at.queue, 'w2')).toEqual([]);
      expect(await driver.ack(id, { workerId: 'w1', claim: first?.claim ?? -1 })).toBe(true);
      expect(await claim(driver, at.queue, 'w2')).toEqual([]);
      expect((await statsOf(driver, at.queue))?.running ?? 0).toBe(0);
    },
  },
  {
    name: 'a live idempotency key dedupes onto the row that holds it',
    async run(driver) {
      const at = scope();
      const id = await enqueue(driver, at, 3, 'same');
      const again = await driver.enqueue({
        name: at.name,
        queue: at.queue,
        input: {},
        idempotencyKey: 'same',
        maxAttempts: 3,
      });
      expect(again).toMatchObject({ id, deduped: true });
    },
  },
  {
    name: 'an empty queue list is refused, never read as every queue or as default',
    async run(driver) {
      const refused = await Promise.resolve()
        .then(() => driver.claim({ queues: [], limit: 1, visibilityTimeoutMs: 1, workerId: 'w' }))
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(refused).toMatchObject({ code: 'X_JOB_CLAIM_QUEUES_EMPTY' });
    },
  },
  {
    name: 'a nack hands the row back, and the claim it ended can no longer settle it',
    async run(driver) {
      const at = scope();
      const id = await enqueue(driver, at, 3);
      const [first] = await claim(driver, at.queue, 'w1');
      const one = { workerId: 'w1', claim: first?.claim ?? -1 };
      expect(await driver.nack(id, { ...one, delayMs: 0 })).toBe(true);
      const [second] = await claim(driver, at.queue, 'w1');
      expect(second?.id).toBe(id);
      expect(second?.claim).toBeGreaterThan(one.claim);
      expect(await driver.ack(id, one)).toBe(false);
      expect(await driver.ack(id, { workerId: 'w1', claim: second?.claim ?? -1 })).toBe(true);
    },
  },
  {
    name: 'a dead-lettered row is counted dead and never claimed again',
    async run(driver) {
      const at = scope();
      const id = await enqueue(driver, at, 3);
      const [first] = await claim(driver, at.queue, 'w1');
      const by = { workerId: 'w1', claim: first?.claim ?? -1, delayMs: 0, deadLetter: true };
      expect(await driver.nack(id, by)).toBe(true);
      expect(await claim(driver, at.queue, 'w1')).toEqual([]);
      expect(await statsOf(driver, at.queue)).toMatchObject({ dead: 1 });
    },
  },
  {
    name: 'a lapsed lease is re-claimed, and the worker that lost it can neither renew nor settle',
    async run(driver) {
      const { id, handed } = await lapse(driver, 3);
      expect(handed).toBe(1);
      const renew = (workerId: string) =>
        driver.heartbeat(id, { visibilityTimeoutMs: 30_000, workerId });
      expect(await renew('w1')).toBe(false);
      expect(await renew('w2')).toBe(true);
    },
  },
  {
    name: 'a lease lapsed on the final attempt is buried dead, reported once, never handed out',
    async run(driver) {
      const lapsed = await lapse(driver, 1);
      expect(lapsed.handed).toBe(0);
      expect(buried(lapsed)).toEqual([[[lapsed.id, 'dead']]]);
      let again = 0;
      const third = await claim(driver, lapsed.queue, 'w3', { onExhausted: () => (again += 1) });
      expect([third.length, again]).toEqual([0, 0]);
      expect(await statsOf(driver, lapsed.queue)).toMatchObject({ dead: 1, running: 0 });
    },
  },
  {
    name: 'dropExhausted buries the named job failed, not dead',
    async run(driver) {
      const lapsed = await lapse(driver, 1, true);
      expect(lapsed.handed).toBe(0);
      expect(buried(lapsed)).toEqual([[[lapsed.id, 'failed']]]);
      expect(await statsOf(driver, lapsed.queue)).toMatchObject({ failed: 1, dead: 0 });
    },
  },
];
