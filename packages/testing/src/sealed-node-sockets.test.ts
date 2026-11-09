// `node:net`, `node:tls`, `node:http(s)` and `node:http2` dial through `net.Socket#connect`, never
// `Bun.connect` or `fetch` (measured), so an address literal reached the internet past the seal. The
// gate is the socket one: loopback and `allowHost` pass, offline refuses all, the rest is sealed.

import { afterEach, describe, expect, test } from 'bun:test';
// why: the seal must cover the node:* client modules an app or a vendor SDK dials through.
import http from 'node:http';
// why: as above — the HTTP/2 client.
import http2 from 'node:http2';
// why: as above — the HTTPS client.
import https from 'node:https';
// why: as above — the root every one of them dials through.
import net from 'node:net';
// why: as above — the TLS client.
import tls from 'node:tls';
import {
  allowHost,
  mockFetch,
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

interface Emitter {
  once(event: string, listener: (value: unknown) => void): unknown;
}

/** TEST-NET-3: never routed, and a literal, so no DNS seal stands in front of the dial. */
const ADDRESS = '203.0.113.7';

/** The first `error` or `connect`/`response` the dial emits: a refusal is an EVENT, as a real one is. */
const verdictOf = (emitter: Emitter): Promise<unknown> =>
  new Promise((done) => {
    emitter.once('error', (error) => done((error as { code?: unknown }).code));
    for (const event of ['connect', 'secureConnect', 'response']) {
      emitter.once(event, () => done('dialled'));
    }
  });

const paths: readonly (readonly [string, () => Emitter])[] = [
  ['net.connect', () => net.connect({ host: ADDRESS, port: 80 })],
  ['net.createConnection', () => net.createConnection(80, ADDRESS)],
  ['net.Socket#connect', () => new net.Socket().connect(80, ADDRESS)],
  ['tls.connect', () => tls.connect({ host: ADDRESS, port: 443 })],
  ['http.get', () => http.get(`http://${ADDRESS}/`)],
  ['http.request', () => http.request(`http://${ADDRESS}/`).end()],
  ['https.get', () => https.get(`https://${ADDRESS}/`)],
  ['https.request', () => https.request(`https://${ADDRESS}/`).end()],
  ['http2.connect', () => http2.connect(`https://${ADDRESS}`)],
];

describe(testName('unit', 'sealed node sockets'), () => {
  for (const [label, dial] of paths) {
    test(`${label} to an address literal is refused with X_TEST_NETWORK_SEALED`, async () => {
      expect(await verdictOf(dial())).toBe('X_TEST_NETWORK_SEALED');
    });
  }

  test('the refusal names the dial and opens its fix with the allowHost line', async () => {
    const socket = net.connect({ host: ADDRESS, port: 25 });
    const error = await new Promise<{ cause?: string; fix?: string }>((done) => {
      socket.once('error', (failure) => done(failure as { cause?: string; fix?: string }));
    });
    expect(error.cause).toContain(`CONNECT tcp://${ADDRESS}:25`);
    expect(error.fix).toStartWith(`allowHost('${ADDRESS}:25')`);
  });

  test('a mockFetch route does not answer node:http, so its host is refused, never dialled', async () => {
    mockFetch('http://vendor.example/*', () => new Response('{}'));
    expect(await verdictOf(http.get('http://vendor.example/v1'))).toBe('X_TEST_NETWORK_SEALED');
  });

  test('loopback is this machine and dials for real', async () => {
    using server = Bun.serve({ port: 0, fetch: () => new Response('here') });
    const request = http.get(`http://127.0.0.1:${server.port}/`);
    expect(await verdictOf(request)).toBe('dialled');
    request.destroy();
  });

  test('a unix socket is a path on this machine, never egress', async () => {
    const socket = net.connect('/nonexistent/ultimate-sealed.sock');
    expect(await verdictOf(socket)).toBe('ENOENT');
  });

  test('offline refuses loopback too', async () => {
    setNetworkState('offline');
    expect(await verdictOf(net.connect({ host: '127.0.0.1', port: 9 }))).toBe(
      'X_TEST_NETWORK_OFFLINE',
    );
  });

  test('an allowed host reaches the REAL connect, and unseal hands it back', async () => {
    const real = net.Socket.prototype.connect;
    const dialled: unknown[] = [];
    function fakeConnect(this: net.Socket, ...args: unknown[]): net.Socket {
      dialled.push(args[0]);
      return this;
    }
    unsealNetwork();
    Reflect.set(net.Socket.prototype, 'connect', fakeConnect);
    try {
      sealNetwork();
      allowHost(`${ADDRESS}:80`);
      new net.Socket().connect(80, ADDRESS);
      expect(dialled).toEqual([80]);
      unsealNetwork();
      expect(net.Socket.prototype.connect).toBe(fakeConnect as unknown as typeof real);
    } finally {
      unsealNetwork();
      Reflect.set(net.Socket.prototype, 'connect', real);
      sealNetwork();
    }
  });
});
