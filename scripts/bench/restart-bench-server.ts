// Child process for the 50k-socket forced-restart benchmark (docs/idea/14-roadmap.md, "Open at
// 1.0.0"). Boots one real `sync` node — the actual shipped `createSyncNode`/`listenSyncNode`, the
// real `AcceptBudget`, the real `ChannelHub` — over `Bun.serve`, plus two bench-only routes the
// orchestrator uses to drive a consistency probe. Never imported: this is a measurement harness,
// not a package, and it is not part of `x verify`.
//
// Run standalone: `bun run scripts/bench/restart-bench-server.ts --port 39191`. Prints `READY
// <port>` on stdout once listening; the orchestrator kills this process with SIGKILL to simulate a
// crash, which is the whole point — there is no graceful-shutdown path here on purpose.

import {
  AcceptBudget,
  ChannelHub,
  createSyncNode,
  InProcessTransport,
  LiveQueryRegistry,
  RingChangeBuffer,
  SocketRegistry,
} from '@ultimat3/realtime';
import { BENCH_TOPIC } from './restart-bench-shared';

function parsePort(argv: readonly string[]): number {
  const flag = argv.indexOf('--port');
  const raw = flag >= 0 ? argv[flag + 1] : undefined;
  const port = raw ? Number(raw) : Number(process.env['BENCH_PORT'] ?? '');
  if (!Number.isInteger(port) || port <= 0) {
    console.error('restart-bench-server: --port <n> is required');
    process.exit(1);
  }
  return port;
}

/**
 * Binds `open`, retrying briefly on `EADDRINUSE`.
 *
 * Not defensive padding: with tens of thousands of loopback clients and an `ip_local_port_range`
 * that covers the whole port space, one of those client sockets can be holding this server's port
 * as its *ephemeral source* port at the moment the post-kill server boots. Failing there loses the
 * entire measurement several minutes in, having proved nothing about the framework. The wait is
 * bounded and shows up in the orchestrator's "new server ready Nms after kill" line, so a retry can
 * never quietly flatter the restart number.
 */
async function listenWithRetry<T>(open: () => T, deadlineMs: number): Promise<T> {
  const start = Date.now();
  for (;;) {
    try {
      return open();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'EADDRINUSE' || Date.now() - start >= deadlineMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

if (import.meta.main) {
  const port = parsePort(process.argv.slice(2));
  const sockets = new SocketRegistry();
  const transport = new InProcessTransport();
  const hub = new ChannelHub({ transport, sockets });
  hub.guard('bench.>', () => true);
  const node = createSyncNode({
    hub,
    registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
    transport,
    buildId: `bench-${process.pid}`,
    sockets,
    // Shipped default (see thundering-herd.ts): 500/s sustained, burst 2000. The benchmark measures
    // recovery *under this exact ceiling* — raising it here would measure a different framework.
    accept: new AcceptBudget({ perSecond: 500, burst: 2000 }),
  });
  await node.start();

  let publishSeq = 0;

  const server = await listenWithRetry(
    () =>
      Bun.serve({
        port,
        async fetch(request, bunServer) {
          const url = new URL(request.url);
          if (url.pathname === '/bench/ready') {
            return Response.json({ ready: node.ready, sockets: node.sockets.count });
          }
          if (url.pathname === '/bench/publish' && request.method === 'POST') {
            publishSeq += 1;
            const seq = publishSeq;
            void hub.publish(BENCH_TOPIC, { seq });
            return Response.json({ seq });
          }
          // Awaited, not `??`-defaulted: `node.fetch` is async now — the credential is decided
          // before `server.upgrade`, so a refused one never costs a websocket — and a promise is
          // never nullish, so the old fallback was dead code that turned every non-upgrade path
          // into a 200 with a `[object Promise]` body.
          return await node.fetch(request, bunServer);
        },
        websocket: node.websocket,
      }),
    10_000,
  );

  // Line-oriented on purpose: the orchestrator reads stdout looking for exactly this prefix.
  console.log(`READY ${server.port}`);
}
