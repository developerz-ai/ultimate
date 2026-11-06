// A drill's sync-client lane: one socket on the sync node, opened with the protocol's `hello`,
// holding the subscriptions it is handed and re-dialling whenever it drops, as a page's socket
// does. It counts what `sync-resumes` judges — whether the client is back once the fault cleared,
// and every `replay-gap` the node reported — and never decides anything itself.

import { finiteCount } from '@ultimat3/core';
import type { DrillEvidence } from './drill-verdict';

export type DrillSyncEvidence = NonNullable<DrillEvidence['sync']>;

/** The part of a `WebSocket` the lane uses; the real one satisfies it, a test hands in its own. */
export interface DrillSyncSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
}

export interface DrillSyncOptions {
  /** `ws://…/_x/sync` on the sync role. */
  readonly url: string;
  /** `@ultimat3/realtime`'s `PROTOCOL_VERSION`, handed in: this file loads no realtime module. */
  readonly protocolVersion: number;
  /** Each a `subscribe` frame's `target`, re-sent on every `hello`, as a page resubscribes. */
  readonly subscriptions?: readonly unknown[] | undefined;
  /** Between a drop and the next dial. */
  readonly redialMs?: number | undefined;
  readonly connect?: ((url: string) => DrillSyncSocket) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface DrillSyncLane {
  /** Stop re-dialling, close the socket, and answer what the lane saw. */
  stop(): Promise<DrillSyncEvidence>;
}

const typeOf = (data: unknown): string | undefined => {
  if (typeof data !== 'string') return undefined;
  try {
    const frame: unknown = JSON.parse(data);
    const type =
      typeof frame === 'object' && frame !== null ? Reflect.get(frame, 'type') : undefined;
    return typeof type === 'string' ? type : undefined;
  } catch {
    return undefined;
  }
};

/** Dial `url` and keep a socket on it until `stop()`. */
export function startDrillSync(options: DrillSyncOptions): DrillSyncLane {
  const redialMs = finiteCount('startDrillSync', 'redialMs', options.redialMs ?? 250);
  const connect = options.connect ?? ((url: string): DrillSyncSocket => new WebSocket(url));
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const v = finiteCount('startDrillSync', 'protocolVersion', options.protocolVersion, 1);
  let stopping = false;
  let gaps = 0;
  /** The current socket has had the node's `hello`: the client is connected and subscribed. */
  let live = false;
  let socket: DrillSyncSocket | undefined;

  const dial = (): void => {
    if (stopping) return;
    live = false;
    const current = connect(options.url);
    socket = current;
    current.addEventListener('open', () => {
      current.send(
        JSON.stringify({ type: 'hello', v, buildId: '', sessionId: null, actorId: null }),
      );
    });
    current.addEventListener('message', (event) => {
      const type = typeOf(event.data);
      if (type === 'replay-gap') gaps += 1;
      if (type !== 'hello') return;
      live = true;
      for (const [index, target] of (options.subscriptions ?? []).entries()) {
        current.send(
          JSON.stringify({
            type: 'subscribe',
            v,
            op: 'add',
            sid: `drill-${String(index)}`,
            target,
          }),
        );
      }
    });
    let gone = false;
    const drop = (): void => {
      if (gone || socket !== current) return;
      gone = true;
      live = false;
      if (!stopping) void sleep(redialMs).then(dial);
    };
    current.addEventListener('close', drop);
    current.addEventListener('error', drop);
  };

  dial();
  return {
    async stop() {
      stopping = true;
      const reconnected = live;
      socket?.close();
      return { reconnected, gaps };
    },
  };
}
