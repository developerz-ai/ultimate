// `/healthz` and `/readyz` answer outside the pipeline — no auth, no rate limit — so their body is
// what an unauthenticated stranger reads. The verdict is everyone's; the build id, the in-flight
// count and the names of the dependencies behind readiness are for a peer the app listed.
import { describe, expect, test } from 'bun:test';
import type { HealthReport } from '@ultimat3/core';
import { defineHttpConfig, type HttpConfigInput } from './config';
import { disclosesHealthDetail, healthBody } from './health-disclosure';

const report: HealthReport = {
  state: 'ready',
  ready: true,
  uptimeMs: 1234,
  inflight: 7,
  buildId: 'build-9',
  checks: { database: 'ok', redis: 'failing' },
  registered: 2,
};

const asks = (
  socketAddress: string | null,
  input: HttpConfigInput = {},
  headers: Record<string, string> = {},
): boolean =>
  disclosesHealthDetail({
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, ...input }),
    headers: new Headers(headers),
    socketAddress,
  });

describe('healthBody', () => {
  test('a stranger gets the verdict and nothing that describes the deployment', () => {
    const body = healthBody(report, 'web', false);
    expect(body).toEqual({ state: 'ready', ready: true, role: 'web' });
    const wire = JSON.stringify(body);
    for (const withheld of ['build-9', 'inflight', 'database', 'redis', 'uptimeMs', 'registered']) {
      expect(wire).not.toContain(withheld);
    }
  });

  test('an allow-listed peer gets the whole report', () => {
    expect(healthBody(report, 'web', true)).toEqual({ ...report, role: 'web' });
  });
});

describe('disclosesHealthDetail', () => {
  test('by default only the box itself is told', () => {
    expect(asks('127.0.0.1')).toBe(true);
    expect(asks('::1')).toBe(true);
    expect(asks('::ffff:127.0.0.1')).toBe(true);
    for (const stranger of ['10.42.0.7', '172.17.0.1', '203.0.113.9', 'not-an-address', '', null]) {
      expect(asks(stranger)).toBe(false);
    }
  });

  test('an app lists a class or an exact address, and an empty list tells nobody', () => {
    expect(asks('10.42.0.7', { healthDetailPeers: ['loopback', 'private'] })).toBe(true);
    expect(asks('203.0.113.9', { healthDetailPeers: ['loopback', 'private'] })).toBe(false);
    expect(asks('203.0.113.9', { healthDetailPeers: ['203.0.113.9'] })).toBe(true);
    expect(asks('203.0.113.10', { healthDetailPeers: ['203.0.113.9'] })).toBe(false);
    expect(asks('127.0.0.1', { healthDetailPeers: [] })).toBe(false);
  });

  // A proxy on this box makes every caller's socket loopback. With the proxy declared, the
  // caller it names must be listed too; without it, the header is the caller's own word.
  test('behind a declared proxy the forwarded caller must be listed as well as the socket', () => {
    const proxied: HttpConfigInput = { trustProxy: true, trustedProxyHops: 1 };
    expect(asks('127.0.0.1', proxied, { 'x-forwarded-for': '203.0.113.9' })).toBe(false);
    expect(asks('127.0.0.1', proxied, { 'x-forwarded-for': '127.0.0.1' })).toBe(true);
    expect(asks('127.0.0.1', proxied)).toBe(true);
    // A direct caller forging the header gains nothing: its socket is not listed.
    expect(asks('10.42.0.7', proxied, { 'x-forwarded-for': '127.0.0.1' })).toBe(false);
    // Undeclared, the header is not read at all — it can neither grant nor withhold.
    expect(asks('203.0.113.9', {}, { 'x-forwarded-for': '127.0.0.1' })).toBe(false);
  });
});

describe('healthDetailPeers is screened where it is declared', () => {
  const refused = (value: unknown): { code?: string; fix?: string } => {
    try {
      defineHttpConfig({ rateLimit: { scope: 'process' }, healthDetailPeers: value as never });
    } catch (error) {
      return error as { code?: string; fix?: string };
    }
    return {};
  };

  test('an entry that is neither an address class nor an address literal is X_CONFIG_INVALID', () => {
    for (const bad of [
      ['internal'],
      ['10.0.0.0/8'],
      ['localhost'],
      [42],
      [null],
      'loopback',
      null,
      {},
    ]) {
      expect(refused(bad).code).toBe('X_CONFIG_INVALID');
    }
    expect(refused(['internal']).fix).toContain('healthDetailPeers');
  });

  test('every address class and a literal of either family is accepted', () => {
    const config = defineHttpConfig({
      rateLimit: { scope: 'process' },
      healthDetailPeers: [
        'loopback',
        'private',
        'ula',
        'link-local',
        'cgnat',
        '203.0.113.9',
        '::1',
      ],
    });
    expect(config.healthDetailPeers).toHaveLength(7);
    expect(defineHttpConfig({ rateLimit: { scope: 'process' } }).healthDetailPeers).toEqual([
      'loopback',
    ]);
  });
});
