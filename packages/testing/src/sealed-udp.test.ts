// `Bun.udpSocket` sends — and `node:dgram`, which sends through it (measured) — ask the socket gate:
// loopback and `allowHost('host:port')` pass, offline refuses all, the rest is sealed. A refusal
// surfaces as Bun's own UDP failures do: `send` throws, a `connect` that may not leave rejects.

import { afterEach, describe, expect, test } from 'bun:test';
// why: the seal must cover node:dgram, so the test drives that very module.
import dgram from 'node:dgram';
import {
  allowHost,
  resetNetwork,
  sealNetwork,
  setNetworkState,
  unsealNetwork,
} from './sealed-network';
import { testName } from './test-types';

sealNetwork();

afterEach(() => {
  resetNetwork();
});

/** TEST-NET-3: never routed. A packet to it is egress all the same. */
const ADDRESS = '203.0.113.7';

/** Bun's UDP socket HAS `Symbol.dispose` (it closes); its type omits it, so this says so, checked. */
const closing = <Socket extends object>(socket: Socket): Socket & Disposable => {
  if (!(Symbol.dispose in socket))
    return expect.unreachable('a Bun UDP socket lost Symbol.dispose');
  return socket as Socket & Disposable;
};

const codeOfThrow = (call: () => unknown): unknown => {
  try {
    call();
    return 'sent';
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
};

describe(testName('unit', 'sealed udp'), () => {
  test('a send to an address off this machine throws X_TEST_NETWORK_SEALED', async () => {
    using socket = closing(await Bun.udpSocket({}));
    expect(codeOfThrow(() => socket.send('x', 9, ADDRESS))).toBe('X_TEST_NETWORK_SEALED');
  });

  test('sendMany is refused whole when any packet would leave', async () => {
    using socket = closing(await Bun.udpSocket({}));
    const packets = ['x', 9, '127.0.0.1', 'y', 9, ADDRESS];
    expect(codeOfThrow(() => socket.sendMany(packets))).toBe('X_TEST_NETWORK_SEALED');
  });

  test('a connected socket to an address off this machine is refused at connect', async () => {
    const connecting = Bun.udpSocket({ connect: { hostname: ADDRESS, port: 9 } });
    const code = await connecting.then(
      (socket) => {
        socket.close();
        return 'connected';
      },
      (error: unknown) => (error as { code?: unknown }).code,
    );
    expect(code).toBe('X_TEST_NETWORK_SEALED');
  });

  test('the refusal names the send and opens its fix with the allowHost line', async () => {
    using socket = closing(await Bun.udpSocket({}));
    let failure: { cause?: string; fix?: string } = {};
    try {
      socket.send('x', 53, ADDRESS);
    } catch (error) {
      failure = error as { cause?: string; fix?: string };
    }
    expect(failure.cause).toContain(`SEND udp://${ADDRESS}:53`);
    expect(failure.fix).toStartWith(`allowHost('${ADDRESS}:53')`);
  });

  test('node:dgram reports the refusal through its send callback', async () => {
    const socket = dgram.createSocket('udp4');
    try {
      const code = await new Promise((done) => {
        socket.once('error', (error) => done((error as { code?: unknown }).code));
        socket.send('x', 9, ADDRESS, (error) => done(error ? Reflect.get(error, 'code') : 'sent'));
      });
      expect(code).toBe('X_TEST_NETWORK_SEALED');
    } finally {
      socket.close();
    }
  });

  test('node:dgram with no callback emits the refusal as error, never swallows it', async () => {
    const socket = dgram.createSocket('udp4');
    try {
      const code = await new Promise((done) => {
        socket.once('error', (error) => done((error as { code?: unknown }).code));
        socket.send('x', 9, ADDRESS);
      });
      expect(code).toBe('X_TEST_NETWORK_SEALED');
    } finally {
      socket.close();
    }
  });

  test('node:dgram connect() then send() is judged against the connected peer', async () => {
    const socket = dgram.createSocket('udp4');
    try {
      await new Promise<void>((done) => socket.connect(9, ADDRESS, () => done()));
      const code = await new Promise((done) => {
        socket.send('x', (error) => done(error ? Reflect.get(error, 'code') : 'sent'));
      });
      expect(code).toBe('X_TEST_NETWORK_SEALED');
    } finally {
      socket.close();
    }
  });

  test('loopback is this machine: the datagram arrives', async () => {
    const arrived = Promise.withResolvers<string>();
    using receiver = closing(
      await Bun.udpSocket({
        hostname: '127.0.0.1',
        socket: { data: (_socket, data) => arrived.resolve(String(data)) },
      }),
    );
    using sender = closing(await Bun.udpSocket({}));
    expect(sender.send('hello', receiver.port, '127.0.0.1')).toBe(true);
    expect(await arrived.promise).toBe('hello');
  });

  test('offline refuses loopback too', async () => {
    using socket = closing(await Bun.udpSocket({}));
    setNetworkState('offline');
    expect(codeOfThrow(() => socket.send('x', 9, '127.0.0.1'))).toBe('X_TEST_NETWORK_OFFLINE');
  });

  test('an allowed host reaches the REAL send, and unseal hands Bun.udpSocket back', async () => {
    const real = Bun.udpSocket;
    const sent: unknown[] = [];
    const fakeUdpSocket = async (): Promise<unknown> => ({
      send: (...args: unknown[]) => sent.push(args.slice(1)) > 0,
      sendMany: () => 0,
    });
    unsealNetwork();
    Reflect.set(Bun, 'udpSocket', fakeUdpSocket);
    try {
      sealNetwork();
      allowHost(`${ADDRESS}:9`);
      const socket = await Bun.udpSocket({});
      socket.send('x', 9, ADDRESS);
      expect(sent).toEqual([[9, ADDRESS]]);
      unsealNetwork();
      expect(Bun.udpSocket).toBe(fakeUdpSocket as unknown as typeof real);
    } finally {
      unsealNetwork();
      Reflect.set(Bun, 'udpSocket', real);
      sealNetwork();
    }
  });
});
