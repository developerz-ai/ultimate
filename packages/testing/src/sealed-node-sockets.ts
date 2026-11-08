// The `node:*` half of the socket seal: `net`, `tls`, `http(s)` and `http2` all dial through
// `net.Socket#connect` (measured; none reaches `Bun.connect` or `fetch`), so that one prototype is
// the root. WHETHER a dial may leave is `sealed-network.ts`'s socket gate, handed in.

// why: `net.Socket` is the class every node:* client socket is, and the only place they all meet.
import net from 'node:net';
import type { SocketGate } from './sealed-sockets';

/** A dial target as a URL, so the gate parses one shape. IPv6 literals need their brackets. */
export const dialUrl = (hostname: string, port: unknown, scheme: 'tcp' | 'udp' = 'tcp'): string => {
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return `${scheme}://${host}:${typeof port === 'number' || typeof port === 'string' ? port : 0}`;
};

interface Target {
  readonly host?: unknown;
  readonly hostname?: unknown;
  readonly port?: unknown;
  readonly path?: unknown;
}

const isRecord = (value: unknown): value is Target => typeof value === 'object' && value !== null;

/**
 * The TCP dial `connect`'s arguments name, or `undefined` for a unix socket — a path on this
 * machine, never egress. Node's three shapes: `[options, cb]` (what `net.connect`, `tls`, `http`
 * hand it), `(options, cb)` and `(port, host?, cb)`. No host is Node's `localhost`.
 */
const tcpTarget = (args: readonly unknown[]): string | undefined => {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (isRecord(first)) {
    const host = first.host ?? first.hostname;
    if (typeof host !== 'string')
      return typeof first.path === 'string' ? undefined : 'tcp://localhost:0';
    return dialUrl(host, first.port);
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return undefined;
  return dialUrl(typeof args[1] === 'string' ? args[1] : 'localhost', first);
};

type Connect = (this: net.Socket, ...args: unknown[]) => net.Socket;

/**
 * Patch `net.Socket#connect` and return the uninstaller. A refusal is a dial in flight that fails:
 * `connecting` as the real one sets it, so `http`'s first write queues instead of failing
 * `ERR_SOCKET_CLOSED` (measured), then the `error` event a macrotask later, once every client has
 * its listener on. A throw from inside `http.get` would bypass every `error` handler the app wrote.
 */
export function installNodeSocketSeal(gate: SocketGate): () => void {
  const original = Reflect.get(net.Socket.prototype, 'connect') as Connect;
  const sealed: Connect = function sealedConnect(this: net.Socket, ...args) {
    const target = tcpTarget(args);
    const refusal = target === undefined ? undefined : gate(target, 'CONNECT');
    if (refusal === undefined) return Reflect.apply(original, this, args);
    Reflect.set(this, 'connecting', true);
    setImmediate(() => this.destroy(refusal));
    return this;
  };
  Reflect.set(net.Socket.prototype, 'connect', sealed);
  return () => {
    Reflect.set(net.Socket.prototype, 'connect', original);
  };
}
