// `/_x` behind `x dev --host 0.0.0.0`: a LAN peer can send `Host: localhost` itself, so the Host
// check alone no longer proves the caller is this machine. The peer's address has to, too.

import { describe, expect, test } from 'bun:test';
import { defineHttpConfig, requestContext, UltimateRequest } from '@ultimat3/http';
import { hostRefusal } from './dev-dashboard-guard';

const DEV_URL = 'http://localhost:3000';

const requestFrom = (
  ip: string | null,
  host = 'localhost:3000',
  extra: Record<string, string> = {},
): UltimateRequest => {
  const url = new URL(`http://${host}/_x/services`);
  const headers = { host, ...extra };
  const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
  const ctx = requestContext({
    url,
    method: 'GET',
    role: 'web',
    config,
    ip,
    requestHeaders: headers,
  });
  return new UltimateRequest(new Request(url, { headers }), ctx);
};

const codeOf = async (answer: Response | undefined): Promise<string | undefined> =>
  answer === undefined
    ? undefined
    : ((await answer.json()) as { error: { code: string } }).error.code;

describe('unit · /_x answers a loopback peer only, whatever interface x dev bound', () => {
  test('a LAN peer naming a loopback Host is X_DEV_PEER_REFUSED, 403', async () => {
    for (const ip of ['192.168.1.20', '10.0.0.7', 'fd00::5', '203.0.113.9']) {
      const answer = hostRefusal(requestFrom(ip), DEV_URL);
      expect([ip, answer?.status]).toEqual([ip, 403]);
      expect(await codeOf(answer)).toBe('X_DEV_PEER_REFUSED');
    }
  });

  test('every loopback peer spelling is admitted, as is an in-process call with no socket', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', null]) {
      expect([ip, hostRefusal(requestFrom(ip), DEV_URL)]).toEqual([ip, undefined]);
    }
  });

  test('the refusal fix dials /_x through loopback on the port this server holds', async () => {
    const answer = hostRefusal(requestFrom('192.168.1.20'), 'http://localhost:4100');
    const body = (await answer?.json()) as { error: { fix: string } };
    expect(body.error.fix).toContain('http://localhost:4100/_x');
  });

  test('under x dev --tls the refusal fix dials https, the scheme the server speaks', async () => {
    const answer = hostRefusal(requestFrom('192.168.1.20'), 'https://localhost:4100');
    const body = (await answer?.json()) as { error: { fix: string } };
    expect(body.error.fix).toContain('https://localhost:4100/_x');
  });

  test('the Host check still runs first, for a loopback peer naming a rebound Host', async () => {
    expect(await codeOf(hostRefusal(requestFrom('127.0.0.1', 'rebound.evil.test'), DEV_URL))).toBe(
      'X_DEV_HOST_REFUSED',
    );
  });
});

describe('unit · /_x refuses a relayed caller, whatever address it resolved to', () => {
  // The resolved `ctx.ip` of a LAN socket forging `x-forwarded-for: 127.0.0.1` past one declared
  // hop IS 127.0.0.1 — and of a Host-rewriting tunnel on this machine, the socket's 127.0.0.1.
  test('a loopback ip carrying any relay header is X_DEV_PEER_REFUSED, naming the relay', async () => {
    for (const relay of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
      const answer = hostRefusal(
        requestFrom('127.0.0.1', 'localhost:3000', { [relay]: '127.0.0.1' }),
        DEV_URL,
      );
      expect([relay, answer?.status]).toEqual([relay, 403]);
      const body = (await answer?.json()) as { error: { code: string; cause: string } };
      expect(body.error.code).toBe('X_DEV_PEER_REFUSED');
      expect(body.error.cause).toContain(relay);
    }
  });
});
