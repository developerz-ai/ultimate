// `/readyz` answers from a cached probe, and starts at most one new probe per
// `READINESS_PROBE_MIN_MS`: production saw `select $1` as the most-called statement (38,195 in 26 h).

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock, readinessChecks, UltimateError } from '@ultimat3/core';
import { probedReadinessCheck, READINESS_PROBE_MIN_MS } from './runtime-services';

const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
});

/** Lets the probe's settled promise run its `.then`/`.finally`. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
};

describe('unit · the database readiness check is coalesced on the clock', () => {
  test('10 readiness reads within one interval send one ping', async () => {
    const clock = frozenClock();
    let pings = 0;
    const ping = async (): Promise<void> => {
      pings += 1;
    };
    releases.push(probedReadinessCheck('database', ping, { clock }));
    // The boot's own ping proved the pool: the first interval sends none.
    for (let read = 0; read < 10; read += 1) readinessChecks();
    await settle();
    expect(pings).toBe(0);
    clock.advance(READINESS_PROBE_MIN_MS);
    for (let read = 0; read < 10; read += 1) {
      readinessChecks();
      await settle();
      clock.advance(50);
    }
    expect(pings).toBe(1);
    expect(READINESS_PROBE_MIN_MS).toBe(1_000);
  });

  test('a failed ping is the next answer, and the interval after it pings again', async () => {
    const clock = frozenClock();
    let healthy = true;
    let pings = 0;
    releases.push(
      probedReadinessCheck(
        'database',
        async () => {
          pings += 1;
          if (!healthy)
            await Promise.reject(
              new UltimateError({ code: 'X_DB_UNAVAILABLE', cause: 'pool closed', fix: 'x dev' }),
            );
        },
        { clock },
      ),
    );
    healthy = false;
    clock.advance(READINESS_PROBE_MIN_MS);
    expect(readinessChecks()['database']).toBe('ok');
    await settle();
    expect(readinessChecks()['database']).toBe('failing');
    healthy = true;
    clock.advance(READINESS_PROBE_MIN_MS);
    readinessChecks();
    await settle();
    expect(readinessChecks()['database']).toBe('ok');
    expect(pings).toBe(2);
  });
});
