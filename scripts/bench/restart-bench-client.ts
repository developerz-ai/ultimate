// One simulated client for the 50k-socket forced-restart benchmark. Deliberately mirrors what a
// real client does on an unscheduled disconnect (thundering-herd.ts's own framing): there is no
// server-sent `reconnect` frame to obey — the process just died — so recovery is `backoffDelay`
// alone, exactly like a browser tab that lost its socket to a crash instead of a graceful drain.

import { backoffDelay, decode, encode, PROTOCOL_VERSION } from '@ultimat3/realtime';
import { beginSeqEpoch, newSeqCounters, recordSeq, type SeqCounters } from './restart-bench-seq';
import { BENCH_SID, BENCH_TOPIC, type BenchProbeRow } from './restart-bench-shared';

export interface ClientStats {
  readonly index: number;
  attempts: number;
  /** Refused-by-AcceptBudget count before this client's first-ever hello (the ramp phase). */
  shedRamp: number;
  /** Refused-by-AcceptBudget count from the first hello onward (every later reconnect, incl. the
   * forced-restart recovery) — kept apart from `shedRamp` so a phase's DB-load proxy is not
   * inflated by attempts that belong to a different phase. */
  shedRestart: number;
  firstHelloAt: number | null;
  helloAt: number | null;
  lastCloseAt: number | null;
  alive: boolean;
  lastSeenSeq: number;
  /**
   * Holes in the probe sequence this client received, per connection. `patchAfterOpenAt` below
   * times the FIRST delivery on a socket, which proves reachability and nothing else — a channel
   * topic carries no cursor, so a patch dropped on the way out is unrecoverable and a
   * first-delivery timer cannot see one. This is the half that can.
   */
  seq: SeqCounters;
  /**
   * When the *first* patch arrived on the connection this client currently holds — cleared on every
   * open, so after the forced restart it reads "first delivery on the reconnected socket". Recording
   * the *latest* patch instead is the one mistake this field exists to prevent: the probe keeps
   * firing until the orchestrator stops it, so a last-seen timestamp converges on the end of the
   * measurement window for every client at once, and reports the window length dressed up as a
   * recovery time.
   */
  patchAfterOpenAt: number | null;
}

export function newClientStats(index: number): ClientStats {
  return {
    index,
    attempts: 0,
    shedRamp: 0,
    shedRestart: 0,
    firstHelloAt: null,
    helloAt: null,
    lastCloseAt: null,
    alive: false,
    lastSeenSeq: 0,
    seq: newSeqCounters(),
    patchAfterOpenAt: null,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function connect(url: string, signal: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const ws = new WebSocket(url);
    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onError = () => {
      cleanup();
      reject(new Error('connect failed'));
    };
    const cleanup = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
  });
}

/** Resolves once the socket closes (for any reason). Never rejects — a close is not a failure. */
function closed(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.addEventListener('close', () => resolve(), { once: true });
  });
}

function handleMessage(stats: ClientStats, data: string | Uint8Array): void {
  const frame = decode(typeof data === 'string' ? data : new TextDecoder().decode(data));
  if (frame.type === 'hello') {
    const now = Date.now();
    stats.helloAt = now;
    if (stats.firstHelloAt === null) stats.firstHelloAt = now;
    return;
  }
  if (frame.type === 'patch' && frame.sid === BENCH_TOPIC) {
    // The seq is scoped to ONE connection, never compared across two: the probe counter resets to
    // zero on every fresh server process, so a swarm-wide "greater than the last one seen" would
    // read the restart itself as a lost frame. `beginSeqEpoch` on every open is what makes the
    // remaining holes mean the only thing left they can mean — a frame this node sent nowhere.
    const row = frame.patches[0]?.row as BenchProbeRow | undefined;
    if (row) {
      const seq = recordSeq(stats.seq, row.seq);
      if (seq !== null) stats.lastSeenSeq = seq;
      stats.patchAfterOpenAt ??= Date.now();
    }
  }
}

/**
 * Runs until `signal` aborts. Each pass: connect (subject to the server's `AcceptBudget`, which
 * answers a plain HTTP 503 the WS handshake surfaces only as a generic connect failure — a real
 * browser has no more information than that either), hello, subscribe, then wait for the close that
 * eventually comes (a forced-restart kill, or the benchmark's own teardown).
 */
export async function runClient(
  url: string,
  stats: ClientStats,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    stats.attempts += 1;
    let ws: WebSocket;
    try {
      ws = await connect(url, signal);
    } catch {
      if (stats.firstHelloAt === null) stats.shedRamp += 1;
      else stats.shedRestart += 1;
      await sleep(backoffDelay(Math.min(stats.attempts, 12)), signal);
      continue;
    }
    stats.alive = true;
    stats.patchAfterOpenAt = null; // this socket has delivered nothing yet
    beginSeqEpoch(stats.seq); // ...and its publisher may be a different process than the last one
    ws.addEventListener('message', (event: MessageEvent) => {
      handleMessage(stats, event.data as string | Uint8Array);
    });
    ws.send(
      encode({
        type: 'hello',
        v: PROTOCOL_VERSION,
        buildId: 'bench-client',
        sessionId: null,
        actorId: null,
      }),
    );
    ws.send(
      encode({
        type: 'subscribe',
        v: PROTOCOL_VERSION,
        op: 'add',
        sid: BENCH_SID,
        target: { kind: 'topic', topic: BENCH_TOPIC },
      }),
    );
    await closed(ws);
    stats.alive = false;
    stats.lastCloseAt = Date.now();
    if (signal.aborted) return;
    await sleep(backoffDelay(0), signal); // fresh disconnect: a real client restarts its own count
    stats.attempts = 0;
  }
}
