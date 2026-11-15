// `x dev`'s boot on TLS, served for real: https through the whole chain (`startDev` →
// `startRoles` → the http listener), `/_x` answering a loopback caller over it, and no HSTS — a
// dev listener must not pin every localhost port in the developer's browser to https.

import { describe, expect, test } from 'bun:test';
import { bootDevFixture } from './cmd-dev-boot-fixture';
import { selfSignedCertificate } from './dev-tls';

// The real instant: the preload freezes the clock at 2026-01-01, and TLS checks the machine's.
const pair = await selfSignedCertificate({
  names: ['localhost', '127.0.0.1', '::1'],
  now: new Date(performance.timeOrigin + performance.now()),
});
const dev = bootDevFixture('.dev-tls-serve-fixture', { tls: pair });

describe('unit · x dev --tls, served', () => {
  test('the url is https, and /_x answers a loopback caller over it with no HSTS', async () => {
    expect(dev.server.url).toStartWith('https://localhost:');
    const response = await fetch(`${dev.server.url}/_x/services?json=1`, {
      tls: { ca: pair.cert },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('strict-transport-security')).toBeNull();
  });
});
