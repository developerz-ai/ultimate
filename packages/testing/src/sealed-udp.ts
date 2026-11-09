// The UDP half of the socket seal: `Bun.udpSocket`, which `node:dgram` sends through too (measured).
// A connected socket is gated at `connect` and every send after; an unconnected one per datagram.
// A refusal surfaces as Bun's own UDP failures do: `send` throws, a `connect` rejects.

// why: Bun's `dgram.Socket#send` drops a throw when no callback is given (measured); patched below.
import dgram from 'node:dgram';
import { dialUrl } from './sealed-node-sockets';
import type { SocketGate } from './sealed-sockets';

type UdpSocketFactory = (options: unknown) => Promise<unknown>;
type Method = (...args: unknown[]) => unknown;

interface ConnectTarget {
  readonly hostname?: unknown;
  readonly port?: unknown;
}

/** The refusals this seal raised: the only errors the `dgram` patch re-emits. */
const refusals = new WeakSet<Error>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The peer a `connect` option names, as the gate's URL; `undefined` for an unconnected socket. */
const peerOf = (options: unknown): string | undefined => {
  const connect: unknown = isRecord(options) ? options['connect'] : undefined;
  if (!isRecord(connect)) return undefined;
  const target: ConnectTarget = connect;
  return typeof target.hostname === 'string'
    ? dialUrl(target.hostname, target.port, 'udp')
    : undefined;
};

/**
 * The peer a connected socket sends to, read off the socket at send time: `node:dgram`'s
 * `connect()` re-points the native socket without `Bun.udpSocket` (measured), so a peer remembered
 * from the options would miss it.
 */
const remoteOf = (socket: object): string | undefined => {
  const remote: unknown = Reflect.get(socket, 'remoteAddress');
  if (!isRecord(remote) || typeof remote['address'] !== 'string') return undefined;
  return dialUrl(remote['address'], remote['port'], 'udp');
};

/**
 * Wrap one socket's two senders. Every datagram of a `sendMany` is judged before any leaves, so a
 * refused batch sends nothing. A connected socket is judged per send: offline may have begun since.
 */
const sealSends = (socket: object, gate: SocketGate): void => {
  const send = Reflect.get(socket, 'send') as Method;
  const sendMany = Reflect.get(socket, 'sendMany') as Method;
  const judge = (target: string | undefined): void => {
    // No target: an unconnected send without an address, which Bun refuses itself.
    const refusal = target === undefined ? undefined : gate(target, 'SEND');
    if (refusal === undefined) return;
    refusals.add(refusal);
    throw refusal;
  };
  Reflect.set(socket, 'send', (...args: unknown[]): unknown => {
    judge(typeof args[2] === 'string' ? dialUrl(args[2], args[1], 'udp') : remoteOf(socket));
    return Reflect.apply(send, socket, args);
  });
  Reflect.set(socket, 'sendMany', (packets: Iterable<unknown>): unknown => {
    const list = [...packets];
    const remote = remoteOf(socket);
    if (remote !== undefined) judge(remote);
    else {
      for (let at = 0; at + 2 < list.length; at += 3) {
        const address = list[at + 2];
        if (typeof address === 'string') judge(dialUrl(address, list[at + 1], 'udp'));
      }
    }
    return Reflect.apply(sendMany, socket, [list]);
  });
};

/**
 * Bun's `dgram` hands a failed send to the callback and DROPS it without one; Node emits `error`
 * then. Without a callback, a refusal of ours is emitted as Node would, so it fails the test loudly.
 */
const sealDgramSend = (): (() => void) => {
  const send = Reflect.get(dgram.Socket.prototype, 'send') as Method;
  Reflect.set(
    dgram.Socket.prototype,
    'send',
    function sealedSend(this: dgram.Socket, ...args: unknown[]) {
      if (typeof args.at(-1) === 'function') return Reflect.apply(send, this, args);
      const reemit = (error: unknown): void => {
        if (error instanceof Error && refusals.has(error)) this.emit('error', error);
      };
      return Reflect.apply(send, this, [...args, reemit]);
    },
  );
  return () => {
    Reflect.set(dgram.Socket.prototype, 'send', send);
  };
};

/** Patch `Bun.udpSocket` and return the uninstaller, which puts back exactly what was there. */
export function installUdpSeal(gate: SocketGate): () => void {
  const restoreDgram = sealDgramSend();
  const original = Reflect.get(Bun, 'udpSocket') as UdpSocketFactory;
  const sealed: UdpSocketFactory = async (options) => {
    const peer = peerOf(options);
    if (peer !== undefined) {
      const refusal = gate(peer, 'CONNECT');
      if (refusal !== undefined) throw refusal;
    }
    const socket = await original(options);
    if (isRecord(socket)) sealSends(socket, gate);
    return socket;
  };
  Reflect.set(Bun, 'udpSocket', sealed);
  return () => {
    Reflect.set(Bun, 'udpSocket', original);
    restoreDgram();
  };
}
