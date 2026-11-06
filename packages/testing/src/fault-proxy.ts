// A TCP proxy in front of one real service, with the fault switchable mid-run: what `x drill` puts
// between an app's roles and its Postgres, Redis and NATS. Bun's own sockets, no container and no
// kernel rule — so a drill runs the same on a laptop and a free CI runner. The faults are the
// outages this plan reproduced by hand: an unanswered path, a slow one, a reset, a refusal.

import { assert, finiteCount, MAX_TIMER_MS } from '@ultimat3/core';
import type { Socket, TCPSocketListener } from 'bun';

/**
 * `blackhole` accepts and never answers — a node loss, where the server is healthy and the path is
 * not. Bytes that arrive meanwhile are HELD, never dropped, and cross once the mode lets them.
 */
export type FaultMode =
  | { readonly kind: 'pass' }
  | { readonly kind: 'delay'; readonly ms: number }
  | { readonly kind: 'blackhole' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'refuse' };

export type FaultModeKind = FaultMode['kind'];

export const FAULT_MODE_KINDS: readonly FaultModeKind[] = [
  'pass',
  'delay',
  'blackhole',
  'reset',
  'refuse',
];

export interface FaultProxyCounts {
  /** Connections the proxy accepted and dialled through. */
  readonly accepted: number;
  /** Connections cut: by a `reset` or `refuse`, or accepted under `reset`. */
  readonly reset: number;
  /** Connections whose dial to the real service failed. */
  readonly upstreamFailed: number;
  /** Connections open right now. */
  readonly open: number;
  readonly bytesUp: number;
  readonly bytesDown: number;
  /** Bytes held by a `blackhole`, not yet delivered. */
  readonly held: number;
}

export interface FaultProxy {
  /** The loopback port the app dials instead of the service's. Kept across a `refuse`. */
  readonly port: number;
  readonly mode: FaultMode;
  /** Switch the fault. Takes effect on the next byte; held bytes are re-judged under `mode`. */
  set(mode: FaultMode): Promise<void>;
  counts(): FaultProxyCounts;
  /** Cut every connection and stop listening. Idempotent. */
  close(): void;
}

export interface FaultProxyOptions {
  readonly target: { readonly hostname: string; readonly port: number };
  readonly mode?: FaultMode | undefined;
  /** Listen here rather than on a port of the OS's choosing. */
  readonly port?: number | undefined;
  /** How a `delay` waits. A test injects a gate it opens; a drill takes the wall clock's. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

type Direction = 'up' | 'down';

/** A socket's unsent bytes, flushed on `drain`: a write the kernel half-took is never lost. */
interface Outbox {
  readonly queue: Uint8Array[];
}

interface Pair {
  readonly client: Socket<Leg>;
  upstream: Socket<Leg> | undefined;
  /** Client bytes that arrived before the dial landed. */
  readonly early: Uint8Array[];
  readonly held: Map<Direction, Uint8Array[]>;
  /** Per direction, the delivery a `delay` chains on, so order survives the wait. */
  readonly chain: Map<Direction, Promise<void>>;
}

interface Leg {
  pair: Pair | undefined;
  readonly out: Outbox;
}

const LOOPBACK = '127.0.0.1';

/** The mode, screened: a `delay` of NaN would arm `setTimeout(…, 0)` and drill nothing. */
export function screenFaultMode(mode: FaultMode): FaultMode {
  assert(
    FAULT_MODE_KINDS.includes(mode.kind),
    `faultProxy was given the mode ${JSON.stringify(mode.kind)}, which is none of ${FAULT_MODE_KINDS.join(', ')}`,
    "proxy.set({ kind: 'blackhole' })   # one of pass, delay, blackhole, reset, refuse",
  );
  if (mode.kind === 'delay') {
    finiteCount('faultProxy', 'delay ms', mode.ms);
    assert(
      mode.ms <= MAX_TIMER_MS,
      `faultProxy delay ms is ${String(mode.ms)}, past the longest a timer holds`,
      "proxy.set({ kind: 'blackhole' })   # a delay no timer can hold is a blackhole; say so",
    );
  }
  return mode;
}

function send(socket: Socket<Leg>, bytes: Uint8Array): void {
  const out = socket.data.out;
  if (out.queue.length > 0) {
    out.queue.push(bytes);
    return;
  }
  const written = socket.write(bytes);
  if (written < bytes.length) out.queue.push(bytes.subarray(Math.max(0, written)));
}

function flush(socket: Socket<Leg>): void {
  const queue = socket.data.out.queue;
  while (queue.length > 0) {
    const head = queue[0];
    if (head === undefined) return;
    const written = socket.write(head);
    if (written < head.length) {
      queue[0] = head.subarray(Math.max(0, written));
      return;
    }
    queue.shift();
  }
}

/** `{ target }` behind a loopback port whose fault `set` switches. */
export async function faultProxy(options: FaultProxyOptions): Promise<FaultProxy> {
  let mode = screenFaultMode(options.mode ?? { kind: 'pass' });
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const pairs = new Set<Pair>();
  const counts = { accepted: 0, reset: 0, upstreamFailed: 0, bytesUp: 0, bytesDown: 0 };
  let closed = false;

  const heldBytes = (): number => {
    let total = 0;
    for (const pair of pairs) {
      for (const chunks of pair.held.values()) {
        for (const chunk of chunks) total += chunk.length;
      }
    }
    return total;
  };

  const cut = (pair: Pair): void => {
    if (!pairs.delete(pair)) return;
    counts.reset += 1;
    pair.client.terminate();
    pair.upstream?.terminate();
  };

  const write = (pair: Pair, direction: Direction, bytes: Uint8Array): void => {
    if (!pairs.has(pair)) return;
    if (direction === 'down') {
      send(pair.client, bytes);
      return;
    }
    if (pair.upstream === undefined) pair.early.push(bytes);
    else send(pair.upstream, bytes);
  };

  /** One chunk, judged by the mode in force NOW — so a byte a delay held re-meets a blackhole. */
  const route = (pair: Pair, direction: Direction, bytes: Uint8Array): void => {
    if (!pairs.has(pair)) return;
    if (mode.kind === 'blackhole') {
      pair.held.get(direction)?.push(bytes);
      return;
    }
    if (mode.kind === 'delay') {
      const timer = sleep(mode.ms);
      const previous = pair.chain.get(direction) ?? Promise.resolve();
      const next = Promise.all([previous, timer]).then(() => {
        // A switch to blackhole while this waited holds it; a pass writes it.
        if (mode.kind === 'blackhole') pair.held.get(direction)?.push(bytes);
        else write(pair, direction, bytes);
      });
      pair.chain.set(direction, next);
      return;
    }
    write(pair, direction, bytes);
  };

  const dial = (pair: Pair): void => {
    void Bun.connect<Leg>({
      hostname: options.target.hostname,
      port: options.target.port,
      socket: {
        open(upstream) {
          upstream.data = { pair, out: { queue: [] } };
          if (!pairs.has(pair)) {
            upstream.terminate();
            return;
          }
          pair.upstream = upstream;
          for (const bytes of pair.early.splice(0)) send(upstream, bytes);
        },
        data(_upstream, chunk) {
          counts.bytesDown += chunk.length;
          // Copied: the runtime reuses the chunk's buffer once this handler returns.
          route(pair, 'down', Uint8Array.from(chunk));
        },
        drain: flush,
        close() {
          if (pairs.delete(pair)) pair.client.end();
        },
        error() {
          if (pairs.delete(pair)) pair.client.end();
        },
      },
    }).catch(() => {
      counts.upstreamFailed += 1;
      if (pairs.delete(pair)) pair.client.terminate();
    });
  };

  const listen = (port: number): TCPSocketListener<Leg> =>
    Bun.listen<Leg>({
      hostname: LOOPBACK,
      port,
      socket: {
        open(client) {
          client.data = { pair: undefined, out: { queue: [] } };
          if (mode.kind === 'reset' || mode.kind === 'refuse') {
            counts.reset += 1;
            client.terminate();
            return;
          }
          const pair: Pair = {
            client,
            upstream: undefined,
            early: [],
            held: new Map([
              ['up', []],
              ['down', []],
            ]),
            chain: new Map(),
          };
          client.data.pair = pair;
          pairs.add(pair);
          counts.accepted += 1;
          dial(pair);
        },
        data(client, chunk) {
          counts.bytesUp += chunk.length;
          const pair = client.data.pair;
          if (pair !== undefined) route(pair, 'up', Uint8Array.from(chunk));
        },
        drain: flush,
        close(client) {
          const pair = client.data.pair;
          if (pair !== undefined && pairs.delete(pair)) pair.upstream?.end();
        },
        error(client) {
          const pair = client.data.pair;
          if (pair !== undefined && pairs.delete(pair)) pair.upstream?.terminate();
        },
      },
    });

  let listener: TCPSocketListener<Leg> | undefined = listen(
    finiteCount('faultProxy', 'port', options.port ?? 0),
  );
  const port = listener.port;
  if (mode.kind === 'refuse') {
    listener.stop(true);
    listener = undefined;
  }

  return {
    port,
    get mode() {
      return mode;
    },
    async set(next: FaultMode): Promise<void> {
      assert(
        !closed,
        'faultProxy.set() was called after close(), so there is no proxy to switch',
        'faultProxy({ target }) again — close() is final',
      );
      mode = screenFaultMode(next);
      if (mode.kind === 'reset' || mode.kind === 'refuse') {
        for (const pair of [...pairs]) cut(pair);
      }
      if (mode.kind === 'refuse') {
        listener?.stop(true);
        listener = undefined;
        return;
      }
      // Back from a refusal: listening again on the SAME port, where every role still dials.
      if (listener === undefined) listener = listen(port);
      if (mode.kind === 'blackhole') return;
      for (const pair of pairs) {
        for (const [direction, chunks] of pair.held) {
          for (const bytes of chunks.splice(0)) route(pair, direction, bytes);
        }
      }
    },
    counts: () => ({ ...counts, open: pairs.size, held: heldBytes() }),
    close(): void {
      if (closed) return;
      closed = true;
      for (const pair of [...pairs]) cut(pair);
      listener?.stop(true);
      listener = undefined;
    },
  };
}

/**
 * `url` re-pointed at a proxy on loopback: scheme, credentials, database and query kept, since the
 * proxy forwards bytes and the service still authenticates them. One rewriter for every service.
 */
export function throughFaultProxy(url: string, port: number): string {
  const parsed = new URL(url);
  parsed.hostname = LOOPBACK;
  parsed.port = String(port);
  return parsed.toString();
}

/** Where a service URL points: what `faultProxy({ target })` dials. */
export function faultTarget(url: string): { readonly hostname: string; readonly port: number } {
  const parsed = new URL(url);
  const fallback = DEFAULT_PORTS.get(parsed.protocol);
  const port = parsed.port === '' ? fallback : Number.parseInt(parsed.port, 10);
  assert(
    port !== undefined,
    `${parsed.protocol}// names no port and has no default this proxy knows`,
    'TEST_DATABASE_URL=postgres://ultimate:ultimate@127.0.0.1:5432/postgres   # name the port in the URL',
  );
  return { hostname: parsed.hostname, port };
}

const DEFAULT_PORTS: ReadonlyMap<string, number> = new Map([
  ['postgres:', 5432],
  ['postgresql:', 5432],
  ['redis:', 6379],
  ['nats:', 4222],
]);
