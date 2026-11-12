// When `expiresAt` buries a row, written once over a harness and run on every driver: memory
// (`driver-parity-expiry.test.ts`), Postgres (`driver-pg-expiry.job.test.ts`) and Redis
// (`driver-redis-expiry.live.test.ts`). Expiry is for work nobody started: a retry waiting out its
// backoff is a run that did, and burying it dropped work its first attempt may have half done.

import { expect, test } from 'bun:test';
import type { JobDriver, JobRecord } from './driver';

export interface ExpiryHarness {
  /** A store with no rows a scenario could mistake for its own. */
  driver(): Promise<JobDriver>;
  /** The instant the store's claim reads as now, in epoch ms. */
  now(driver: JobDriver): Promise<number>;
  /** Time passing as the store sees it. */
  elapse(driver: JobDriver, ms: number): Promise<void>;
}

const claim = (driver: JobDriver, buried: JobRecord[]) =>
  driver.claim({
    queues: ['expiry'],
    limit: 10,
    visibilityTimeoutMs: 30_000,
    workerId: 'w-expiry',
    onExhausted: (rows) => buried.push(...rows),
  });

export function driverExpiryScenarios(label: string, harness: ExpiryHarness): void {
  test(`${label}: a retry in its backoff past expiresAt is claimed and runs, never expired`, async () => {
    const driver = await harness.driver();
    const { id } = await driver.enqueue({
      name: 'expiry.job',
      queue: 'expiry',
      input: {},
      idempotencyKey: 'retried',
      maxAttempts: 3,
      expiresAt: (await harness.now(driver)) + 60_000,
    });
    const buried: JobRecord[] = [];
    const [first] = await claim(driver, buried);
    if (first === undefined) return expect.unreachable('the fresh row was claimable');
    const by = { workerId: 'w-expiry', claim: first.claim };
    expect(await driver.nack(id, { ...by, delayMs: 1_000, error: 'boom' })).toBe(true);
    await harness.elapse(driver, 120_000);
    const again = await claim(driver, buried);
    expect(again.map((row) => [row.id, row.attempt])).toEqual([[id, 2]]);
    expect(buried).toEqual([]);
  });

  test(`${label}: a row never claimed past expiresAt is still settled expired`, async () => {
    const driver = await harness.driver();
    const { id } = await driver.enqueue({
      name: 'expiry.job',
      queue: 'expiry',
      input: {},
      idempotencyKey: 'waited',
      maxAttempts: 3,
      expiresAt: (await harness.now(driver)) + 60_000,
    });
    await harness.elapse(driver, 120_000);
    const buried: JobRecord[] = [];
    expect(await claim(driver, buried)).toEqual([]);
    expect(buried.map((row) => [row.id, row.state, row.lastError])).toEqual([
      [id, 'failed', 'expired'],
    ]);
  });
}
