// After the cooldown ONE read probes a replica that was parked; the rest take the primary until the
// probe answers. The private breaker this replaced let every concurrent read try the replica until
// one failed — a wider blast on a replica still down. Core's `breaker()` is the machine now.

import { describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { recordingClient } from './fake';
import { replicatedClient } from './replica-client';
import { withReplicaReads } from './replica-scope';
import { sql } from './sql';

function fakeClock(): Clock & { advance(ms: number): void } {
  let ms = 0;
  return {
    now: () => new Date(ms),
    monotonic: () => ms,
    advance: (by) => {
      ms += by;
    },
  };
}

describe('replica breaker · one probe', () => {
  test('past the cooldown one concurrent read reaches the replica, the rest the primary', async () => {
    const primary = recordingClient();
    const replica = recordingClient();
    let down = true;
    let attempts = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const flaky: typeof replica = {
      ...replica,
      query: async (fragment) => {
        attempts += 1;
        if (down) return Promise.reject(new TypeError('connection refused'));
        await held;
        return replica.query(fragment);
      },
    };
    const clock = fakeClock();
    const client = replicatedClient(primary, flaky, { clock, breakerCooldownMs: 1_000 });
    for (let n = 0; n < 3; n += 1) await withReplicaReads(() => client.query(sql`select 1`));
    expect([attempts, client.stats.parked]).toEqual([3, true]);

    clock.advance(1_000);
    down = false;
    const reads = withReplicaReads(() =>
      Promise.all(Array.from({ length: 5 }, () => client.query(sql`select 1`))),
    );
    await Promise.resolve();
    release();
    await reads;
    expect(attempts).toBe(4);
    expect(client.stats.replica).toBe(1);
    // The probe answered: the next read is the replica's again.
    await withReplicaReads(() => client.query(sql`select 1`));
    expect(client.stats.replica).toBe(2);
  });
});
