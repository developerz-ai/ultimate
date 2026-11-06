// The sync-client lane against a stand-in sync node on loopback: a real WebSocket server that
// answers `hello`, records subscriptions, drops every socket on demand (the bus going away), refuses
// while "down", and reports a `replay-gap`. No reference app runs NATS, so this is its proof.

import { afterEach, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import type { DrillFleet } from './drill-fleet';
import { runDrill } from './drill-run';
import type { DrillSyncSocket } from './drill-sync';
import { startDrillSync } from './drill-sync';
import { drillNamed } from './drills';
import { allowHost, resetNetwork } from './sealed-network';

const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  resetNetwork();
});

/** A yield, never a wall-clock wait: a redial is one macrotask later. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Until `done()`, a turn at a time; a bound on turns so a broken lane fails rather than hangs. */
async function until(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 5_000 && !done(); turn += 1) await tick();
  expect(done()).toBe(true);
}

function syncNode() {
  const sockets = new Set<ServerWebSocket<unknown>>();
  const subscribed: string[] = [];
  const state = { down: false, hellos: 0, refused: 0 };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, bun) {
      if (state.down) {
        state.refused += 1;
        return new Response('down', { status: 503 });
      }
      return bun.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 });
    },
    websocket: {
      open: (socket) => void sockets.add(socket),
      close: (socket) => void sockets.delete(socket),
      message(socket, raw) {
        const frame = JSON.parse(String(raw)) as { type: string; sid?: string; v: number };
        if (frame.type === 'hello') {
          state.hellos += 1;
          // A turn late, as a real node answers after its own async work: the server having READ a
          // hello is never evidence the client has its reply, and a test that waits on it races.
          const reply = JSON.stringify({ type: 'hello', v: frame.v, buildId: 'b', sessionId: 's' });
          setImmediate(() => socket.send(reply));
        }
        if (frame.type === 'subscribe') subscribed.push(frame.sid ?? '');
      },
    },
  });
  servers.push(server);
  allowHost(`127.0.0.1:${String(server.port)}`);
  return {
    url: `ws://127.0.0.1:${String(server.port)}/_x/sync`,
    state,
    subscribed,
    open: () => sockets.size,
    dropAll: () => {
      for (const socket of sockets) socket.close(1012, 'bus gone');
    },
    gap: () => {
      for (const socket of sockets) socket.send(JSON.stringify({ type: 'replay-gap', v: 3 }));
    },
  };
}

/** The lane's own socket, watched from the client side: what it has RECEIVED, frame by frame. */
function clientSide() {
  const seen = { hellos: 0, gaps: 0 };
  // Registered before the lane's listener, so by the time a wait on `seen` yields, the lane has
  // handled the same frame in the same dispatch.
  const connect = (url: string): DrillSyncSocket => {
    const socket = new WebSocket(url);
    socket.addEventListener('message', (event) => {
      const type: unknown = Reflect.get(JSON.parse(String(event.data)), 'type');
      if (type === 'hello') seen.hellos += 1;
      if (type === 'replay-gap') seen.gaps += 1;
    });
    return socket;
  };
  return { seen, connect };
}

describe('startDrillSync', () => {
  test('a dropped socket is re-dialled and resubscribed once the node is back: reconnected', async () => {
    const node = syncNode();
    const lane = startDrillSync({
      url: node.url,
      protocolVersion: 3,
      subscriptions: [{ kind: 'channel', name: 'feed', params: {} }],
      sleep: tick,
    });
    await until(() => node.subscribed.length === 1);
    node.state.down = true;
    node.dropAll();
    await until(() => node.open() === 0);
    node.state.down = false;
    await until(() => node.subscribed.length === 2);
    expect(node.state.hellos).toBe(2);
    expect(await lane.stop()).toEqual({ reconnected: true, gaps: 0 });
  });

  test('a node that never comes back leaves the client disconnected: not reconnected', async () => {
    const node = syncNode();
    const lane = startDrillSync({ url: node.url, protocolVersion: 3, sleep: tick });
    await until(() => node.state.hellos === 1);
    node.state.down = true;
    node.dropAll();
    // The client saw the drop once it re-dials and is refused.
    await until(() => node.state.refused >= 1);
    expect(await lane.stop()).toEqual({ reconnected: false, gaps: 0 });
  });

  test('every replay-gap the node reports is counted', async () => {
    const node = syncNode();
    const client = clientSide();
    const lane = startDrillSync({
      url: node.url,
      protocolVersion: 3,
      sleep: tick,
      connect: client.connect,
    });
    await until(() => client.seen.hellos === 1);
    node.gap();
    node.gap();
    // Two frames in flight: stop once the client has read both, never after a guessed turn count.
    await until(() => client.seen.gaps === 2);
    const evidence = await lane.stop();
    expect(evidence).toEqual({ reconnected: true, gaps: 2 });
  });
});

describe('runDrill with a sync lane', () => {
  test('nats-down reads the lane: sync-resumes is judged on what the client saw', async () => {
    const node = syncNode();
    const client = clientSide();
    const web = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') });
    servers.push(web);
    allowHost(`127.0.0.1:${String(web.port)}`);
    const base = `http://127.0.0.1:${String(web.port)}`;
    const modes: string[] = [];
    const fleet: DrillFleet = {
      base,
      databaseUrl: 'postgres://unused',
      proxies: new Map([
        [
          'nats',
          {
            port: 0,
            mode: { kind: 'pass' },
            set: async (mode) => {
              modes.push(mode.kind);
              // The bus refused: the node drops its sockets and refuses until it is back.
              if (mode.kind !== 'pass') await until(() => client.seen.hellos >= 1);
              node.state.down = mode.kind !== 'pass';
              if (node.state.down) node.dropAll();
            },
            counts: () => ({
              accepted: 0,
              reset: 0,
              upstreamFailed: 0,
              open: 0,
              bytesUp: 0,
              bytesDown: 0,
              held: 0,
            }),
            close: () => undefined,
          },
        ],
      ]),
      roles: new Map(),
      stop: async () => undefined,
    };
    const report = await runDrill({
      drill: drillNamed('nats-down') ?? expect.unreachable(),
      fleet,
      budgets: {
        deadlineMs: 5_000,
        promptMs: 1_000,
        recoveryMs: 4_000,
        readinessMs: 5_000,
        drainMs: 5_000,
        readiness: 'dependencies',
        phaseMs: 10,
      },
      targets: [{ method: 'GET', path: '/' }],
      sql: { rows: async () => [] },
      sync: () =>
        startDrillSync({ url: node.url, protocolVersion: 3, sleep: tick, connect: client.connect }),
      sleep: async (ms) => {
        // The recovery wait is where the client re-dials: wait until it has the node's SECOND
        // hello — what the lane judges by — not until the node has read one.
        if (ms === 4_000) await until(() => client.seen.hellos >= 2);
        else await tick();
      },
    });
    expect(modes).toEqual(['refuse', 'pass']);
    expect(report.evidence.sync).toEqual({ reconnected: true, gaps: 0 });
    expect(report.verdict.failures.map((failure) => failure.property)).not.toContain(
      'sync-resumes',
    );
  });
});
