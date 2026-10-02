import { describe, expect, test } from 'bun:test';
import type { PortProbe } from './free-port';
import { BROWSER_REFUSED_PORTS, freePort } from './free-port';

/** A listener that answers `ports` in order and records what was released, and when. */
const scripted = (ports: readonly number[]) => {
  const log: string[] = [];
  let next = 0;
  const listen = (): PortProbe => {
    const port = ports[next] ?? expect.unreachable('freePort asked for more ports than scripted');
    next += 1;
    log.push(`listen ${String(port)}`);
    return { port, stop: () => void log.push(`stop ${String(port)}`) };
  };
  return { listen, log };
};

describe('freePort', () => {
  test('a port a browser refuses to open is never handed to the app', () => {
    // 4045 was handed out on a box whose ephemeral range starts at 1024 (measured 2026-10-02):
    // the app listened, and all six tests of the file failed `net::ERR_UNSAFE_PORT`.
    const { listen } = scripted([4045, 6000, 43_397]);
    expect(freePort(listen)).toBe(43_397);
  });

  test('a refused port stays held until a usable one is found, so the OS cannot hand it back', () => {
    const { listen, log } = scripted([10_080, 6667, 51_234]);
    freePort(listen);
    expect(log).toEqual([
      'listen 10080',
      'listen 6667',
      'listen 51234',
      'stop 51234',
      'stop 10080',
      'stop 6667',
    ]);
  });

  test('an ordinary port is taken on the first ask and released', () => {
    const { listen, log } = scripted([43_397]);
    expect(freePort(listen)).toBe(43_397);
    expect(log).toEqual(['listen 43397', 'stop 43397']);
  });

  test('against the real OS it answers a port a browser will open', () => {
    const port = freePort();
    expect(port).toBeGreaterThan(0);
    expect(BROWSER_REFUSED_PORTS.has(port)).toBe(false);
  });

  test('the refused list is the unprivileged part of Chromium’s, which is all an OS can hand out', () => {
    expect([...BROWSER_REFUSED_PORTS].every((port) => port >= 1024)).toBe(true);
    expect(BROWSER_REFUSED_PORTS.has(4045)).toBe(true);
  });
});
