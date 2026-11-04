// After the cooldown ONE read probes a replica that was parked; the rest take the primary until the
// probe answers. The private breaker this replaced let every concurrent read try the replica until
// one failed — a wider blast on a replica still down. Core's `breaker()` is the machine now.
//
// CI run 41714452760, job `gate`, part `unit-3` (the `unit` step, shard 3 of 3) was red, and this
// package's replica work was suspected of it. It was not: the repo's own shard algorithm
// (`packages/cli/src/verify-shard.ts`, the pure round-robin CI uses — `ci.yml` passes no
// `--timings`) over the gate's own discovery (`discoverTests(root, undefined, 'unit')`) puts THIS
// file in shard 1 of 3 and its sibling `packages/db/src/replica-client.test.ts` in shard 2 of 3 —
// neither in the red part. An index is a snapshot of a corpus every added test file shifts, so the
// shard — re-derivable from the algorithm above — is the claim that carries.
//
// The red part's failing test's own name is NOT recorded here: run 41714452760's job log is not
// reachable from this checkout and no artifact of it exists in the tree (no file in the repo
// mentions the run id). The two facts a reader can re-derive are the shard split above and the
// assertions below.
//
// The gateway half of the same breaker wave (`39-core-breaker.md`) keeps ONE breaker per provider
// by memoising the app's factory answer per provider name (`packages/ai/src/gateway-providers.ts`),
// which is what makes the STREAM path's two asks for a provider's breaker answer with the same
// one; `packages/ai/src/gateway-breaker.test.ts` pins it. The REPLICA router never had that
// shape: it holds ONE `gate` and settles every ticket on it, which the tests below now hold in
// place.

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

  /**
   * The probe's TICKET is settled by the breaker that issued it. A probe that FAILS reopens THAT
   * breaker, so the replica is parked again at once and the next read does not take the probe
   * slot. Settled against a different breaker, the issuer would stay half-open with its probe
   * spent, and the next read would go to the replica as a second probe — the wider blast this
   * file's first test exists to prevent.
   */
  test('a probe that fails reopens the breaker that issued it, so the next read stays on the primary', async () => {
    const primary = recordingClient();
    const replica = recordingClient();
    let down = true;
    let attempts = 0;
    const flaky: typeof replica = {
      ...replica,
      query: async (fragment) => {
        attempts += 1;
        if (down) return Promise.reject(new TypeError('connection refused'));
        return replica.query(fragment);
      },
    };
    const clock = fakeClock();
    const client = replicatedClient(primary, flaky, { clock, breakerCooldownMs: 1_000 });
    for (let n = 0; n < 3; n += 1) await withReplicaReads(() => client.query(sql`select 1`));
    expect([attempts, client.stats.parked]).toEqual([3, true]);

    // Past the cooldown the next read IS the probe — and the replica is still down.
    clock.advance(1_000);
    await withReplicaReads(() => client.query(sql`select 1`));
    expect(attempts).toBe(4);
    // The probe failed, so the breaker that issued it is OPEN again — not half-open with a
    // spent probe. A breaker that does not reopen would let this next read take the probe slot.
    expect(client.stats.parked).toBe(true);

    await withReplicaReads(() => client.query(sql`select 1`));
    // It never reached the replica: the breaker is open, so the read went to the primary.
    expect(attempts).toBe(4);
  });

  /**
   * The one probe is ONE read, decided before the first await: the routing asks the breaker for
   * its ticket, and the breaker hands out exactly one. Five reads started together therefore
   * reach the replica once and the primary four times — never the replica five times.
   */
  test('five reads started together reach the replica exactly once', async () => {
    const primary = recordingClient();
    const replica = recordingClient();
    let down = true;
    let attempts = 0;
    const flaky: typeof replica = {
      ...replica,
      query: async (fragment) => {
        attempts += 1;
        if (down) return Promise.reject(new TypeError('connection refused'));
        return replica.query(fragment);
      },
    };
    const clock = fakeClock();
    const client = replicatedClient(primary, flaky, { clock, breakerCooldownMs: 1_000 });
    for (let n = 0; n < 3; n += 1) await withReplicaReads(() => client.query(sql`select 1`));
    expect(client.stats.parked).toBe(true);

    clock.advance(1_000);
    down = false;
    // No await between the starts: every read asks the breaker before the first one answers.
    const reads = withReplicaReads(() =>
      Promise.all(Array.from({ length: 5 }, () => client.query(sql`select 1`))),
    );
    await reads;

    // Three parked attempts, then ONE probe. The other four went to the primary.
    expect(attempts).toBe(4);
    expect(client.stats.replica).toBe(1);
    expect(client.stats.primary).toBe(7);
  });
});
