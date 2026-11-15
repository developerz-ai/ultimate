// A web or sync pod waiting on the migrate step is ALIVE and NOT READY on its own port, the one
// its startup and liveness probes knock on, and the role's real listener takes that port after.

import { afterEach, describe, expect, test } from 'bun:test';
import { markListening, resetLifecycle } from '@ultimat3/core';
import { selfSignedCertificate } from './dev-tls';
import { openBootProbe } from './serve-boot-probe';

/** A port the kernel just handed out and took back: free, and not 0, which opens no probe. */
function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const { port } = server;
  server.stop(true);
  if (port === undefined) return expect.unreachable('the kernel handed out a port');
  return port;
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  resetLifecycle();
});

describe('unit · the boot probe listener', () => {
  test('answers /healthz 200 and /readyz 503 on the role port, and every other path 503', async () => {
    const port = freePort();
    const probe = openBootProbe({ role: 'web', port, hostname: '127.0.0.1' });
    if (probe === undefined) return expect.unreachable('the web role opened a probe');
    stops.push(() => probe.stop());
    const base = `http://127.0.0.1:${String(port)}`;
    const healthz = await fetch(`${base}/healthz`);
    expect(healthz.status).toBe(200);
    expect(((await healthz.json()) as { role: string }).role).toBe('web');
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    const page = await fetch(`${base}/posts`);
    expect(page.status).toBe(503);
    expect(page.headers.get('retry-after')).toBe('5');
  });

  test('stop() frees the port at once for the real listener, and twice is harmless', async () => {
    const port = freePort();
    const probe = openBootProbe({ role: 'web', port, hostname: '127.0.0.1' });
    probe?.stop();
    probe?.stop();
    const real = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('served') });
    // Announced as every framework listener is, so the test seal lets this process call itself.
    const unmark = markListening(real.url.origin);
    stops.push(() => {
      unmark();
      real.stop(true);
    });
    expect(await (await fetch(`http://127.0.0.1:${String(port)}/`)).text()).toBe('served');
  });

  test('the sync role holds the sync port, PORT + 1', async () => {
    const port = freePort();
    const probe = openBootProbe({ role: 'sync', port: port - 1, hostname: '127.0.0.1' });
    if (probe === undefined) return expect.unreachable('the sync role opened a probe');
    stops.push(() => probe.stop());
    expect((await fetch(`http://127.0.0.1:${String(port)}/healthz`)).status).toBe(200);
  });

  test('roles probed on the metrics port, and an ephemeral boot, open none', () => {
    for (const role of ['worker', 'scheduler', 'replicator'] as const) {
      expect(openBootProbe({ role, port: freePort(), hostname: '127.0.0.1' })).toBeUndefined();
    }
    expect(openBootProbe({ role: 'web', port: 0, hostname: '127.0.0.1' })).toBeUndefined();
  });

  test('a TLS pair OpenSSL refuses is X_CONFIG_INVALID naming both variables, never the bytes', () => {
    const KEY_BYTES = 'SECRETKEYBYTES';
    const pairs = [
      { cert: 'not a pem', key: 'not a pem' },
      {
        cert: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
        key: `-----BEGIN PRIVATE KEY-----\n${KEY_BYTES}\n-----END PRIVATE KEY-----\n`,
      },
    ];
    for (const tls of pairs) {
      let refused: unknown;
      try {
        stops.push(
          openBootProbe({ role: 'web', port: freePort(), hostname: '127.0.0.1', tls })?.stop ??
            (() => {}),
        );
      } catch (error) {
        refused = error;
      }
      expect(refused).toMatchObject({ code: 'X_CONFIG_INVALID' });
      const text = JSON.stringify(refused) + String(refused);
      expect(text).toContain('TLS_CERT');
      expect(text).toContain('TLS_KEY');
      expect(text).not.toContain(KEY_BYTES);
      expect(text).not.toContain('not a pem');
    }
  });

  test('a valid pair serves the probe over TLS', async () => {
    const tls = await selfSignedCertificate({ names: ['127.0.0.1'], now: new Date() });
    const port = freePort();
    const probe = openBootProbe({ role: 'web', port, hostname: '127.0.0.1', tls });
    if (probe === undefined) return expect.unreachable('the web role opened a probe');
    stops.push(() => probe.stop());
    const healthz = await fetch(`https://127.0.0.1:${String(port)}/healthz`, {
      tls: { rejectUnauthorized: false },
    });
    expect(healthz.status).toBe(200);
  });
});
