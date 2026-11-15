// A self-signed certificate built from WebCrypto alone, and Bun's TLS stack serving it: the only
// proof a hand-written X.509 is right is a real handshake that verifies against it.

import { afterAll, describe, expect, test } from 'bun:test';
// why: a trust anchor's own signature is never checked by a handshake; X509Certificate checks it.
import { createPublicKey, X509Certificate } from 'node:crypto';
import { chmod, rm, stat } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { markListening, resetLifecycle } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { certificateNames, devCertificate, selfSignedCertificate } from './dev-tls';

const STATE = join(import.meta.dir, '..', `.dev-tls-fixture-${process.pid}`);
afterAll(async () => {
  await rm(STATE, { recursive: true, force: true });
  await rm(`${STATE}-mode`, { recursive: true, force: true });
});

/**
 * The real instant, never the preload's frozen one: a TLS client checks validity against the
 * machine's clock, and a certificate minted at the frozen 2026-01-01 has expired on it.
 */
const wallClock = (): Date => new Date(performance.timeOrigin + performance.now());

/** One HTTPS request whose client VERIFIES the chain against `ca`, then the body. */
async function handshake(input: {
  cert: string;
  key: string;
  ca: string;
  url: (port: number) => string;
}): Promise<string> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: input.cert, key: input.key },
    fetch: () => new Response('ok'),
  });
  // This process's own socket: announced, so the test network seal lets the dial through.
  const target = input.url(server.port ?? 0);
  const unmark = markListening(new URL(target).origin);
  try {
    const response = await fetch(target, {
      tls: { ca: input.ca, rejectUnauthorized: true },
    });
    return await response.text();
  } finally {
    unmark();
    server.stop(true);
  }
}

describe('unit · x dev --tls: a local certificate with no dependency and no openssl', () => {
  test('Bun serves it, and a client verifying against it completes the handshake on localhost', async () => {
    const pair = await selfSignedCertificate({
      names: ['localhost', '127.0.0.1', '::1'],
      now: wallClock(),
    });
    expect(pair.cert).toStartWith('-----BEGIN CERTIFICATE-----\n');
    expect(pair.key).toStartWith('-----BEGIN PRIVATE KEY-----\n');
    const line = await handshake({
      ...pair,
      ca: pair.cert,
      url: (port) => `https://localhost:${port}/`,
    });
    expect(line).toBe('ok');
  });

  test('an address the certificate does not carry fails verification — the SAN is real', async () => {
    const pair = await selfSignedCertificate({ names: ['localhost'], now: wallClock() });
    const outcome = handshake({
      ...pair,
      ca: pair.cert,
      url: (port) => `https://127.0.0.1:${port}/`,
    });
    const refusal = await outcome.then(
      () => 'served',
      (error: unknown) => (error as { code?: string }).code,
    );
    expect(refusal).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
  });

  test('cached under the state dir: a second ask for the same names is the same certificate', async () => {
    const first = await devCertificate({ stateDir: STATE, names: ['localhost'], now: wallClock() });
    const again = await devCertificate({ stateDir: STATE, names: ['localhost'], now: wallClock() });
    expect(again.cert).toBe(first.cert);
    expect(first.certPath).toBe(join(STATE, 'tls', 'cert.pem'));
    expect(await Bun.file(first.certPath).text()).toBe(first.cert);
    expect((await Bun.file(join(STATE, 'tls', 'key.pem')).stat()).mode & 0o077).toBe(0);
  });

  test('a new name, or a certificate near its end, is regenerated rather than served', async () => {
    const base = await devCertificate({ stateDir: STATE, names: ['localhost'], now: wallClock() });
    const wider = await devCertificate({
      stateDir: STATE,
      names: ['localhost', '192.168.1.5'],
      now: wallClock(),
    });
    expect(wider.cert).not.toBe(base.cert);
    const later = new Date(wallClock().getTime() + 400 * 86_400_000);
    const renewed = await devCertificate({
      stateDir: STATE,
      names: ['localhost', '192.168.1.5'],
      now: later,
    });
    expect(renewed.cert).not.toBe(wider.cert);
  });
});

describe("unit · the cached key is this user's alone", () => {
  test('.x/tls is 0700, and a cached key readable by others is replaced, never served', async () => {
    const state = `${STATE}-mode`;
    const first = await devCertificate({ stateDir: state, names: ['localhost'], now: wallClock() });
    expect((await stat(join(state, 'tls'))).mode & 0o777).toBe(0o700);
    // What a umask-0002 editor save, a copy or a `git stash pop` leaves behind.
    await chmod(join(state, 'tls', 'key.pem'), 0o644);
    const again = await devCertificate({ stateDir: state, names: ['localhost'], now: wallClock() });
    expect(again.cert).not.toBe(first.cert);
    expect((await stat(join(state, 'tls', 'key.pem'))).mode & 0o777).toBe(0o600);
  });
});

describe('unit · the certificate is well-formed X.509, not merely accepted', () => {
  test('its signature verifies under its own key, and it carries every name it was asked for', async () => {
    const pair = await selfSignedCertificate({
      names: ['localhost', '::1', '10.1.2.3'],
      now: wallClock(),
    });
    const parsed = new X509Certificate(pair.cert);
    expect(parsed.verify(createPublicKey(pair.key))).toBe(true);
    expect(parsed.subjectAltName).toBe(
      'DNS:localhost, IP Address:0:0:0:0:0:0:0:1, IP Address:10.1.2.3',
    );
  });
});

describe('unit · the names a bind needs its certificate to carry', () => {
  test('loopback always; a specific address beside it; a wildcard adds nothing to dial', () => {
    expect(certificateNames('localhost')).toEqual(['localhost', '127.0.0.1', '::1']);
    expect(certificateNames('0.0.0.0')).toEqual(['localhost', '127.0.0.1', '::1']);
    expect(certificateNames('::')).toEqual(['localhost', '127.0.0.1', '::1']);
    expect(certificateNames('192.168.1.5')).toEqual([
      'localhost',
      '127.0.0.1',
      '::1',
      '192.168.1.5',
    ]);
  });
});

describe('unit · an http listener given tls serves https, and counts it as secure', () => {
  const route: Route = {
    method: 'GET',
    path: '/page',
    meta: { name: 'tls.page', auth: 'public' },
    handler: () => new Response('page'),
  };

  async function served(tls: boolean): Promise<Response> {
    const pair = await selfSignedCertificate({ names: ['localhost'], now: wallClock() });
    const server = httpServer({
      routes: [route],
      role: 'web',
      config: defineHttpConfig({
        port: 0,
        hostname: 'localhost',
        dev: false,
        rateLimit: { scope: 'process' },
        ...(tls ? { tls: { cert: pair.cert, key: pair.key } } : {}),
      }),
    }).start();
    try {
      expect(server.url()).toStartWith(tls ? 'https://localhost:' : 'http://localhost:');
      return await fetch(`${server.url()}/page`, { tls: { ca: pair.cert } });
    } finally {
      await server.stop();
      resetLifecycle();
    }
  }

  test('a direct TLS socket with no proxy is https: HSTS goes out, no header consulted', async () => {
    const response = await served(true);
    expect(await response.text()).toBe('page');
    expect(response.headers.get('strict-transport-security')).toStartWith('max-age=');
  });

  test('the same server without tls is plaintext, and sends no HSTS — as before', async () => {
    const response = await served(false);
    expect(await response.text()).toBe('page');
    expect(response.headers.get('strict-transport-security')).toBeNull();
  });
});
