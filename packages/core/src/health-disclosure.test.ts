// `/healthz` and `/readyz` answer outside every pipeline — no auth, no rate limit — so their body
// is a stranger's to read. One rule for every role's listener: the verdict is everyone's, and the
// build id, the in-flight count and the readiness check names go to a listed peer.
import { describe, expect, test } from 'bun:test';
import { DEFAULT_HEALTH_DETAIL_PEERS, healthBody, healthPeerListed } from './health-disclosure';
import type { HealthReport } from './lifecycle';

const report: HealthReport = {
  state: 'ready',
  ready: true,
  uptimeMs: 1234,
  inflight: 7,
  buildId: 'build-9',
  checks: { database: 'ok', redis: 'failing' },
  registered: 2,
};

describe('healthBody', () => {
  test('a stranger gets the verdict and nothing that describes the deployment', () => {
    const body = healthBody(report, 'sync', false);
    expect(body).toEqual({ state: 'ready', ready: true, role: 'sync' });
    const wire = JSON.stringify(body);
    for (const withheld of ['build-9', 'inflight', 'database', 'redis', 'uptimeMs', 'registered']) {
      expect(wire).not.toContain(withheld);
    }
  });

  test('a listed peer gets the whole report', () => {
    expect(healthBody(report, 'web', true)).toEqual({ ...report, role: 'web' });
  });
});

describe('healthPeerListed', () => {
  test('the default list is the box itself', () => {
    expect(DEFAULT_HEALTH_DETAIL_PEERS).toEqual(['loopback']);
    for (const local of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(healthPeerListed(DEFAULT_HEALTH_DETAIL_PEERS, local)).toBe(true);
    }
    for (const stranger of ['10.42.0.7', '172.17.0.1', '203.0.113.9']) {
      expect(healthPeerListed(DEFAULT_HEALTH_DETAIL_PEERS, stranger)).toBe(false);
    }
  });

  test('an entry is an address class or one exact address', () => {
    expect(healthPeerListed(['loopback', 'private'], '10.42.0.7')).toBe(true);
    expect(healthPeerListed(['loopback', 'private'], '203.0.113.9')).toBe(false);
    expect(healthPeerListed(['203.0.113.9'], '203.0.113.9')).toBe(true);
    expect(healthPeerListed(['203.0.113.9'], '203.0.113.10')).toBe(false);
    expect(healthPeerListed([' 2001:DB8::1 '], '2001:db8::1')).toBe(true);
  });

  test('nothing vouches for no address, a non-address, or an empty list', () => {
    expect(healthPeerListed(['loopback'], null)).toBe(false);
    expect(healthPeerListed(['loopback'], '')).toBe(false);
    expect(healthPeerListed(['not-an-address'], 'not-an-address')).toBe(false);
    expect(healthPeerListed([], '127.0.0.1')).toBe(false);
  });

  test('a list that is not one tells nobody, rather than throwing on a probe path', () => {
    expect(healthPeerListed(undefined as never, '127.0.0.1')).toBe(false);
    expect(healthPeerListed('loopback' as never, '127.0.0.1')).toBe(false);
    expect(healthPeerListed([null, 7] as never, '127.0.0.1')).toBe(false);
  });
});
