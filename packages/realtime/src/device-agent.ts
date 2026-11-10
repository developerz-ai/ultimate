// The device's half of a `deviceSocket()`, for an agent written on Bun: dial with the bearer token,
// beat at the interval the node names, answer `request` frames, and redial on realtime's one
// jittered backoff — or at the slot a draining node's `reconnect` frame assigns.

import { reportError } from '@ultimat3/core';
import { bytesOverLimit, type DeviceInbound, decodeNodeFrame } from './device-wire';
import type { JsonValue } from './json';
import {
  defaultBackoff,
  policyDelay,
  type ReconnectBackoff,
  type Rng,
  type Scheduler,
  timeoutScheduler,
} from './thundering-herd';

/** As much of a websocket as the agent drives — Bun's `WebSocket` fits. */
export interface AgentSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

export type AgentDial = (url: string, headers: Readonly<Record<string, string>>) => AgentSocket;

/**
 * Bun's `WebSocket` takes `{ headers }` and sends them on the upgrade — the thing a browser's
 * cannot do, and why a device token rides `Authorization` rather than the URL. The DOM lib this
 * repo also loads types the constructor without that overload (`Bun.WebSocketOptions` exists only
 * when it is absent), so the one call is typed by the shape Bun really accepts.
 */
type HeaderedWebSocket = new (
  url: string,
  options: { readonly headers: Readonly<Record<string, string>> },
) => AgentSocket;

const bunDial: AgentDial = (url, headers) =>
  new (WebSocket as unknown as HeaderedWebSocket)(url, { headers });

export interface DeviceAgentOptions {
  /** `wss://app.example.com/link` — the declaration's path on the app's origin. */
  readonly url: string;
  /** Asked on every dial, so a refreshed token is the next connection's. */
  readonly token: () => string | Promise<string>;
  /** The answer to a node's `request(ctx, deviceId, frame)`. */
  readonly onRequest: (frame: JsonValue) => Promise<JsonValue> | JsonValue;
  /** What `onFrame` on the node answered, and anything else it pushes. */
  readonly onFrame?: ((frame: JsonValue) => void) | undefined;
  readonly backoff?: ReconnectBackoff | undefined;
  readonly rng?: Rng | undefined;
  readonly schedule?: Scheduler | undefined;
  readonly dial?: AgentDial | undefined;
}

export interface DeviceAgent {
  readonly connected: boolean;
  /** One frame for the node's `onFrame`. `false` when no socket is open to carry it. */
  send(frame: JsonValue): boolean;
  /** Closes for good: no redial. */
  close(): void;
}

export function deviceAgent(options: DeviceAgentOptions): DeviceAgent {
  const schedule = options.schedule ?? timeoutScheduler;
  const backoff = options.backoff ?? defaultBackoff;
  const dial = options.dial ?? bunDial;
  let socket: AgentSocket | null = null;
  let open = false;
  let closed = false;
  let attempt = 0;
  let cancelBeat: () => void = () => undefined;
  let cancelRedial: (() => void) | null = null;

  const write = (frame: DeviceInbound): boolean => {
    const text = JSON.stringify(frame);
    if (!open || socket === null || bytesOverLimit(text) !== null) return false;
    socket.send(text);
    return true;
  };

  const beat = (everyMs: number): void => {
    cancelBeat();
    cancelBeat = schedule(() => {
      write({ type: 'beat' });
      beat(everyMs);
    }, everyMs);
  };

  const redialIn = (ms: number): void => {
    if (closed || cancelRedial !== null) return;
    cancelRedial = schedule(() => {
      cancelRedial = null;
      void connect();
    }, ms);
  };

  const answer = async (id: string, frame: JsonValue): Promise<void> => {
    try {
      write({ type: 'response', id, frame: await options.onRequest(frame) });
    } catch (error) {
      // No answer is the answer: the node's deadline tells its caller, with the code that says so.
      reportError(error, { source: 'realtime', scope: { operation: 'device.agent_request' } });
    }
  };

  const receive = (current: AgentSocket, data: unknown): void => {
    if (current !== socket || typeof data !== 'string') return;
    const frame = decodeNodeFrame(data);
    if (frame === undefined) return;
    if (frame.type === 'hello') beat(frame.heartbeatMs);
    else if (frame.type === 'request') void answer(frame.id, frame.frame);
    else if (frame.type === 'frame') options.onFrame?.(frame.frame);
    else if (frame.type === 'reconnect') {
      // The node's slot, not the backoff: the spread is what keeps a fleet restart off one node.
      attempt = 0;
      cancelRedial?.();
      cancelRedial = null;
      redialIn(frame.afterMs);
      current.close(4002, 'reconnect');
    }
  };

  async function connect(): Promise<void> {
    if (closed) return;
    let current: AgentSocket;
    try {
      const token = await options.token();
      // `close()` may have landed while the token was fetched: a dial now is a socket, and a beat,
      // that nothing would ever close.
      if (closed) return;
      current = dial(options.url, { authorization: `Bearer ${token}` });
    } catch (error) {
      reportError(error, { source: 'realtime', scope: { operation: 'device.agent_dial' } });
      attempt += 1;
      redialIn(policyDelay(backoff, attempt, options.rng));
      return;
    }
    socket = current;
    current.onopen = () => {
      if (current !== socket) return;
      open = true;
      attempt = 0;
    };
    current.onmessage = (event) => receive(current, event.data);
    current.onclose = () => {
      if (current !== socket) return;
      socket = null;
      open = false;
      cancelBeat();
      attempt += 1;
      redialIn(policyDelay(backoff, attempt, options.rng));
    };
  }

  void connect();
  return {
    get connected() {
      return open;
    },
    send: (frame) => write({ type: 'frame', frame }),
    close: () => {
      closed = true;
      cancelBeat();
      cancelRedial?.();
      cancelRedial = null;
      const current = socket;
      socket = null;
      open = false;
      current?.close(1000, 'closed');
    },
  };
}
