// A publish refused because the bus is AWAY, waited out in the handler. It used to end the run on
// the spot: the feed stopped, the lock was released and the takeover loop restarted from `lastLsn`
// — a whole restart cycle, and `/readyz` false, for every two-second NATS restart.

import { describe, expect, test } from 'bun:test';
import { formatLsn } from './changefeed';
import { TransportUnavailableError } from './errors';
import type { Transport } from './fanout';
import { InProcessTransport } from './fanout';
import { PUBLISH_RETRY_DELAYS_MS } from './replicator';
import { change, rig, turns } from './replicator-rig-fixture';

/** A bus that is AWAY for the next `blips` publishes — the coded refusal a NATS restart gives. */
const blipping = (blips: number): Transport & { published: string[]; attempts: number } => {
  const inner = new InProcessTransport();
  const bus = {
    name: 'blipping',
    shared: inner.shared,
    published: [] as string[],
    attempts: 0,
    subscribe: inner.subscribe.bind(inner),
    close: () => inner.close(),
    onReconnect: () => inner.onReconnect(),
    publish: async (_subject: string, payload: string): Promise<void> => {
      bus.attempts += 1;
      if (bus.attempts <= blips) {
        throw new TransportUnavailableError({
          transport: 'nats',
          reason: 'the client is reconnecting to the bus',
        });
      }
      bus.published.push(payload);
    },
  };
  return bus;
};

// A publish refused because the bus is away used to end the run on the spot: the feed stopped, the
// lock was released and the takeover loop restarted from `lastLsn` — a whole restart cycle, and
// `/readyz` false, for every two-second NATS restart.
describe('a bus that is away for a moment', () => {
  test('is waited out in the handler: same envelope, no restart, still running', async () => {
    const bus = blipping(2);
    const { feed, lock, timers, replicator } = rig(bus);
    await replicator.start();

    const delivering = feed.deliver(change(7));
    await turns();
    // The first retry is waiting on its timer, and the run is intact meanwhile.
    expect(timers.delays).toEqual(PUBLISH_RETRY_DELAYS_MS.slice(0, 1));
    expect(replicator.running).toBe(true);
    timers.fire();
    await turns();
    timers.fire();
    await delivering;
    await turns();

    expect(timers.delays).toEqual(PUBLISH_RETRY_DELAYS_MS.slice(0, 2));
    expect(bus.published).toHaveLength(1);
    expect(bus.attempts).toBe(3);
    expect(replicator.running).toBe(true);
    const stats = replicator.stats();
    expect([stats.published, stats.restarts, stats.failure]).toEqual([1, 0, null]);
    expect(lock.released).toBe(0);
    expect(feed.stops).toBe(0);
    await replicator.stop();
  });

  test('is bounded: past the last retry the run ends and the takeover loop takes it, as before', async () => {
    const bus = blipping(Number.POSITIVE_INFINITY);
    const { feed, timers, replicator } = rig(bus);
    await replicator.start();

    void feed.deliver(change(7)).catch(() => undefined);
    for (const _delay of PUBLISH_RETRY_DELAYS_MS) {
      await turns();
      timers.fire();
    }
    await turns();

    expect(bus.attempts).toBe(PUBLISH_RETRY_DELAYS_MS.length + 1);
    expect(replicator.running).toBe(false);
    expect(replicator.stats().failure ?? '').toContain(formatLsn(7));
    // The retries, then the restart's own base wait.
    expect(timers.delays).toEqual([...PUBLISH_RETRY_DELAYS_MS, 100]);
    // A few attempts over about two seconds: a blip, never a stall.
    expect(PUBLISH_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(2_500);
    await replicator.stop();
  });

  test('a run that ended during the wait publishes nothing when the timer fires', async () => {
    const bus = blipping(1);
    const { feed, timers, replicator } = rig(bus);
    await replicator.start();

    void feed.deliver(change(7)).catch(() => undefined);
    await turns();
    await replicator.stop();
    timers.fire();
    await turns();

    expect(bus.attempts).toBe(1);
    expect(bus.published).toEqual([]);
  });

  test('a refusal that is not the bus being away is not retried', async () => {
    const inner = new InProcessTransport();
    const bus: Transport = {
      name: 'oversize',
      shared: inner.shared,
      subscribe: inner.subscribe.bind(inner),
      close: () => inner.close(),
      onReconnect: () => inner.onReconnect(),
      // The library's own refusal for a change over `max_payload`: retrying it cannot help.
      publish: () => Promise.reject(new RangeError('payload exceeds max_payload')),
    };
    const { feed, timers, replicator } = rig(bus);
    await replicator.start();

    await feed.deliver(change(7)).catch(() => undefined);
    await turns();

    expect(replicator.running).toBe(false);
    expect(timers.delays).toEqual([100]);
    await replicator.stop();
  });
});
