// The socket half of the sealed network: `WebSocket` and `Bun.connect`, the two dials that are not
// `fetch`. Only the patching lives here; WHETHER a dial may leave is `sealed-network.ts`'s one
// gate, handed in, so fetch and sockets cannot disagree about the allow-list or the offline state.

/** A dial's verdict: the error to raise, or `undefined` to let it through to the real one. */
export type SocketGate = (url: string, method: 'WEBSOCKET' | 'CONNECT') => Error | undefined;

/** `Bun.connect`'s two option shapes, read structurally: TCP names a host, a unix socket a path. */
interface ConnectOptions {
  readonly hostname?: string;
  readonly port?: number;
  readonly unix?: string;
}

type Connect = (options: ConnectOptions) => Promise<unknown>;

/** A dial target as a URL, so the gate parses one shape. IPv6 literals need their brackets. */
const tcpUrl = (hostname: string, port: number | undefined): string => {
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return `tcp://${host}:${port ?? 0}`;
};

/**
 * Patch both dials and return the uninstaller, which puts back exactly what was there — the same
 * originals, so `globalThis.WebSocket === original` holds again. Assigned through `Reflect.set`:
 * `Bun.connect` is a writable data property, but the type declares it a namespace function.
 */
export function installSocketSeal(gate: SocketGate): () => void {
  const OriginalWebSocket = globalThis.WebSocket;
  const originalConnect = Reflect.get(Bun, 'connect') as Connect;

  // A subclass, not a wrapper function: `instanceof WebSocket`, the static `OPEN`/`CLOSED` and
  // every option a caller passes keep working. Code before `super()` may not touch `this`, and
  // does not — the refusal is thrown before the native constructor ever dials.
  class SealedWebSocket extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const refusal = gate(String(url), 'WEBSOCKET');
      if (refusal !== undefined) throw refusal;
      super(url, protocols);
    }
  }

  // A promise either way, as the real `Bun.connect` answers a dial it cannot make. A unix socket is
  // a path on this machine and is never egress.
  const sealedConnect: Connect = (options) => {
    if (options.unix === undefined && options.hostname !== undefined) {
      const refusal = gate(tcpUrl(options.hostname, options.port), 'CONNECT');
      if (refusal !== undefined) return Promise.reject(refusal);
    }
    return originalConnect(options);
  };

  Reflect.set(globalThis, 'WebSocket', SealedWebSocket);
  Reflect.set(Bun, 'connect', sealedConnect);
  return () => {
    Reflect.set(globalThis, 'WebSocket', OriginalWebSocket);
    Reflect.set(Bun, 'connect', originalConnect);
  };
}
