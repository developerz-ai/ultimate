// The confirm timer, and the one thing it may never do: reject into a `void`.
//
// `setInterval(() => { void this.#confirm(); })` handed every failure to nobody. `#confirm` awaits
// the write chain, which rejects the moment the socket is gone, so a run of them was four unhandled
// rejections and — with no handler installed anywhere — exit code 1 on an otherwise clean shutdown.
// The half that mattered more was silent: `stats().failure` stayed `null`, so `/readyz` reported the
// replicator live while `confirmed_flush_lsn` stopped advancing and WAL piled up on the primary.

import { expect, test } from 'bun:test';
import { BrokenWriteWalsender, feedOver } from './pg-replication-fixture';

/** Bounded poll on real timers: the confirm interval is one, so nothing here can be microtasks. */
async function waitUntil(done: () => boolean, label: string): Promise<void> {
  for (let tick = 0; tick < 200; tick += 1) {
    if (done()) return;
    await Bun.sleep(5);
  }
  expect.unreachable(`timed out waiting for ${label}`);
}

test('a confirm that keeps failing ends the stream instead of the process', async () => {
  // Installed by the TEST and never by the package: what is being asserted is that nothing here
  // produces one, and a rejection Bun reports is a process this framework did not choose to end.
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    const server = new BrokenWriteWalsender();
    const feed = feedOver(() => Promise.resolve(server), { statusIntervalMs: 1 });
    await feed.start({ onChange: () => undefined });
    // A live stream reports no failure, which is exactly what made the old behaviour dangerous.
    expect(feed.stats().failure).toBeNull();
    expect(feed.stats().confirmFailures).toBe(0);

    await waitUntil(() => feed.stats().failure !== null, 'the stream to record its failure');

    const stats = feed.stats();
    expect(stats.confirmFailures).toBeGreaterThanOrEqual(3);
    // The operator's half: `/readyz` can now see that the slot is not being confirmed.
    expect(stats.failure).toContain('standby status updates failed in a row');
    expect(rejections).toEqual([]);

    await feed.stop().catch(() => undefined);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('one confirm that lands clears the run, so a healthy stream is never killed by history', async () => {
  const server = new BrokenWriteWalsender();
  const feed = feedOver(() => Promise.resolve(server), { statusIntervalMs: 1 });
  await feed.start({ onChange: () => undefined });

  await waitUntil(() => feed.stats().confirmFailures > 0, 'the first confirm to fail');
  expect(feed.stats().confirmFailures).toBeGreaterThan(0);

  await feed.stop().catch(() => undefined);
  // A restart is a fresh count: a lifetime total would eventually kill a stream that is fine.
  const restarted = feedOver(() => Promise.resolve(new BrokenWriteWalsender()), {
    statusIntervalMs: 60_000,
  });
  await restarted.start({ onChange: () => undefined });
  expect(restarted.stats().confirmFailures).toBe(0);
  await restarted.stop().catch(() => undefined);
});
