// `x dev --host 0.0.0.0` against the real boot: every interface bound, the url it reports one this
// machine dials, and `/_x` still answering only a loopback caller over a real socket.

import { describe, expect, test } from 'bun:test';
import { bootDevFixture } from './cmd-dev-boot-fixture';

const dev = bootDevFixture('.dev-host-fixture', { hostname: '0.0.0.0' });
const portOf = (url: string): number => Number(new URL(url).port);

/** One raw request over a socket to `address`, so the peer address is a real one. */
async function statusVia(address: string, port: number, path: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  let seen = '';
  await Bun.connect({
    hostname: address,
    port,
    socket: {
      open: (socket) => {
        socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      },
      data: (_socket, chunk) => {
        seen += new TextDecoder().decode(chunk);
        const match = /^HTTP\/1\.1 (\d{3})/.exec(seen);
        if (match?.[1] !== undefined) resolve(Number(match[1]));
      },
      close: () => resolve(-1),
      error: (_socket, error) => reject(error),
    },
  });
  return promise;
}

describe('unit · x dev --host 0.0.0.0', () => {
  test('the reported url is dialable through loopback, never 0.0.0.0', () => {
    expect(new URL(dev.server.url).hostname).toBe('localhost');
    expect(portOf(dev.server.url)).toBeGreaterThan(0);
  });

  test('every socket the process opens took the one binding — sync and metrics too', () => {
    expect(new URL(dev.server.running.metricsUrl).hostname).toBe('0.0.0.0');
    expect(new URL(dev.server.running.syncUrl ?? '').hostname).toBe('0.0.0.0');
  });

  test('/_x answers a loopback peer over a real socket on the wide bind', async () => {
    expect(await statusVia('127.0.0.1', portOf(dev.server.url), '/_x/services?json=1')).toBe(200);
  });
});
