// A web or sync pod waiting on the migrate step is ALIVE and NOT READY on its own port, the one
// its startup and liveness probes knock on, and the role's real listener takes that port after.

import { afterEach, describe, expect, test } from 'bun:test';
import { markListening, resetLifecycle } from '@ultimat3/core';
import { bindFreePorts } from '@ultimat3/testing';
import { selfSignedCertificate } from './dev-tls';
import { openBootProbe } from './serve-boot-probe';

type ProbeInput = Omit<Parameters<typeof openBootProbe>[0], 'port'>;

/**
 * The probe opened on a free port — never 0, which opens none — and the port it holds. Bound by the
 * probe itself, so a port another process took first is asked again rather than trusted.
 */
const opened = (input: ProbeInput, pair = false) =>
  bindFreePorts(
    ([port = 0]) => {
      const probe = openBootProbe({ ...input, port });
      if (probe === undefined) return expect.unreachable(`the ${input.role} role opened a probe`);
      stops.push(() => probe.stop());
      return { probe, port };
    },
    { pair },
  );

/** A port no role here ever binds: the roles asked about open nothing, so nothing listens on it. */
const UNBOUND_PORT = 1;

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  resetLifecycle();
});

describe('unit · the boot probe listener', () => {
  test('answers /healthz 200 and /readyz 503 on the role port, and every other path 503', async () => {
    const { port } = await opened({ role: 'web', hostname: '127.0.0.1' });
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
    const { probe, port } = await opened({ role: 'web', hostname: '127.0.0.1' });
    probe.stop();
    probe.stop();
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
    // A pair: PORT + 1 is the one the probe binds, so it is the one that must be free.
    const { port } = await opened({ role: 'sync', hostname: '127.0.0.1' }, true);
    expect((await fetch(`http://127.0.0.1:${String(port + 1)}/healthz`)).status).toBe(200);
  });

  test('roles probed on the metrics port, and an ephemeral boot, open none', () => {
    for (const role of ['worker', 'scheduler', 'replicator'] as const) {
      expect(openBootProbe({ role, port: UNBOUND_PORT, hostname: '127.0.0.1' })).toBeUndefined();
    }
    expect(openBootProbe({ role: 'web', port: 0, hostname: '127.0.0.1' })).toBeUndefined();
  });

  test('a TLS pair OpenSSL refuses is X_CONFIG_INVALID naming both variables, never the bytes', async () => {
    const KEY_BYTES = 'SECRETKEYBYTES';
    const pairs = [
      { cert: 'not a pem', key: 'not a pem' },
      {
        cert: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
        key: `-----BEGIN PRIVATE KEY-----\n${KEY_BYTES}\n-----END PRIVATE KEY-----\n`,
      },
    ];
    for (const tls of pairs) {
      const refused = await opened({ role: 'web', hostname: '127.0.0.1', tls }).then(
        () => undefined,
        (error: unknown) => error,
      );
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
    const { port } = await opened({ role: 'web', hostname: '127.0.0.1', tls });
    const healthz = await fetch(`https://127.0.0.1:${String(port)}/healthz`, {
      tls: { rejectUnauthorized: false },
    });
    expect(healthz.status).toBe(200);
  });
});
