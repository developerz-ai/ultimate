// The seq counter driven end to end: real WebSocket clients against a real `sync` node, restarted
// under them. `.live.` because it binds a port and drives real reconnect timers, and the gate runs
// that suite serially — a sharded unit worker would race it for both.

import { describe, expect, test } from 'bun:test';
import {
  AcceptBudget,
  ChannelHub,
  createSyncNode,
  InProcessTransport,
  LiveQueryRegistry,
  RingChangeBuffer,
  SocketRegistry,
  type SyncNode,
} from '@ultimat3/realtime/server';
import { type ClientStats, newClientStats, runClient } from './restart-bench-client';
import { summarizeSeq } from './restart-bench-seq';
import { BENCH_TOPIC } from './restart-bench-shared';

const CLIENTS = 24;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until `predicate` holds, counting attempts rather than reading a deadline off the clock —
 * the test preload freezes `Date.now()`, so an elapsed-time loop here either spins forever or exits
 * on its first pass. Answers the predicate either way; the caller asserts on state, never on time.
 */
async function waitFor(predicate: () => boolean, attempts = 400, everyMs = 25): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return true;
    await sleep(everyMs);
  }
  return predicate();
}

interface BenchNode {
  readonly hub: ChannelHub;
  readonly port: number;
  /** The publisher's own counter — resets to zero here exactly as it does per server process. */
  publish(): Promise<number>;
  /** Burns a sequence number without publishing it: one frame the swarm can never receive. */
  skip(): void;
  stop(): Promise<void>;
}

/** Binds `open`, retrying a bounded number of times — the restart rebinds a port just released. */
async function listenWithRetry<T>(open: () => T, attempts = 100): Promise<T> {
  for (let i = 0; i < attempts - 1; i += 1) {
    try {
      return open();
    } catch {
      await sleep(50);
    }
  }
  return open();
}

async function startNode(port: number): Promise<BenchNode> {
  const sockets = new SocketRegistry();
  const transport = new InProcessTransport();
  const hub = new ChannelHub({ transport, sockets });
  hub.guard('bench.>', () => true);
  const node: SyncNode = createSyncNode({
    hub,
    registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
    transport,
    buildId: 'bench-seq-test',
    sockets,
    accept: new AcceptBudget({ perSecond: 500, burst: 2000 }),
  });
  await node.start();
  const server = await listenWithRetry(() =>
    Bun.serve({
      port,
      fetch: (request, bunServer) => node.fetch(request, bunServer),
      websocket: node.websocket,
    }),
  );
  let seq = 0;
  return {
    hub,
    // Bun types `port` as optional because a unix-socket server has none. This one bound TCP, so
    // the fallback is unreachable — and if it ever were not, dialling port 0 fails the subscribe
    // wait loudly rather than passing on an unconnected swarm.
    port: server.port ?? port,
    publish: async (): Promise<number> => {
      seq += 1;
      await hub.publish(BENCH_TOPIC, { seq });
      return seq;
    },
    skip: (): void => {
      seq += 1;
    },
    stop: async (): Promise<void> => {
      server.stop(true);
      await node.stop();
    },
  };
}

interface Swarm {
  readonly stats: readonly ClientStats[];
  readonly runs: readonly Promise<void>[];
  readonly abort: AbortController;
}

function startSwarm(port: number): Swarm {
  const stats = Array.from({ length: CLIENTS }, (_, i) => newClientStats(i));
  const abort = new AbortController();
  const url = `ws://127.0.0.1:${port}/_x/sync`;
  return { stats, runs: stats.map((s) => runClient(url, s, abort.signal)), abort };
}

/** Aborts first, then closes the sockets: a client parked in `await closed(ws)` needs both. */
async function stopSwarm(swarm: Swarm, node: BenchNode): Promise<void> {
  swarm.abort.abort();
  await node.stop();
  await Promise.allSettled(swarm.runs);
}

const subscribed = (node: BenchNode): boolean => node.hub.subscriberCount(BENCH_TOPIC) === CLIENTS;

const allReceived = (swarm: Swarm, count: number): boolean =>
  swarm.stats.every((s) => s.seq.received >= count);

describe('live · restart-bench seq accounting over real sockets', () => {
  test('every frame delivered is zero gaps, and a node restart under the swarm is still zero', async () => {
    let node = await startNode(0);
    const port = node.port;
    const swarm = startSwarm(port);
    try {
      expect(await waitFor(() => subscribed(node))).toBe(true);
      for (let i = 0; i < 8; i += 1) await node.publish();
      expect(await waitFor(() => allReceived(swarm, 8))).toBe(true);

      const beforeRestart = summarizeSeq(swarm.stats.map((s) => s.seq));
      expect(beforeRestart.observers).toBe(CLIENTS);
      expect(beforeRestart.received).toBe(CLIENTS * 8);
      expect(beforeRestart.missing).toBe(0);
      expect(beforeRestart.gapEvents).toBe(0);
      expect(beforeRestart.duplicates).toBe(0);
      expect(beforeRestart.epochs).toBe(CLIENTS);

      // The restart: this node's publisher counter dies with it and the next one starts at 1, which
      // is the exact stream a naive "greater than the last one seen" counter reads as a lost frame.
      await node.stop();
      node = await startNode(port);
      expect(await waitFor(() => subscribed(node))).toBe(true);
      for (let i = 0; i < 8; i += 1) await node.publish();
      expect(await waitFor(() => allReceived(swarm, 16))).toBe(true);

      const afterRestart = summarizeSeq(swarm.stats.map((s) => s.seq));
      expect(afterRestart.received).toBe(CLIENTS * 16);
      expect(afterRestart.missing).toBe(0);
      expect(afterRestart.gapEvents).toBe(0);
      expect(afterRestart.rewinds).toBe(0);
      // Two connections each, so the second epoch re-anchored rather than measuring back to the
      // first — the one fact that makes `missing` mean "lost" instead of "restarted".
      expect(afterRestart.epochs).toBe(CLIENTS * 2);
    } finally {
      await stopSwarm(swarm, node);
    }
  }, 60_000);

  test('a frame the node never sends is counted, once per client', async () => {
    const node = await startNode(0);
    const swarm = startSwarm(node.port);
    try {
      expect(await waitFor(() => subscribed(node))).toBe(true);
      await node.publish();
      await node.publish();
      node.skip(); // seq 3 exists to the publisher and reaches nobody
      await node.publish();
      await node.publish();
      expect(await waitFor(() => allReceived(swarm, 4))).toBe(true);

      const summary = summarizeSeq(swarm.stats.map((s) => s.seq));
      expect(summary.received).toBe(CLIENTS * 4);
      expect(summary.missing).toBe(CLIENTS);
      expect(summary.gapEvents).toBe(CLIENTS);
      expect(summary.clientsWithGaps).toBe(CLIENTS);
    } finally {
      await stopSwarm(swarm, node);
    }
  }, 60_000);
});
