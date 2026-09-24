// Two refusals the upgrade owes before a socket exists. The ORIGIN: a websocket carries the
// session cookie and no CORS applies to it, so a page on a sibling host could otherwise open a
// socket as the visitor (cross-site websocket hijacking). And the ACCEPT BUDGET, spent only by an
// upgrade that authenticated — one client with no credential must not starve every reconnect.
import { describe, expect, test } from 'bun:test';
import { frozenClock, userActor } from '@ultimat3/core';
import { SocketOriginRefusedError } from './errors';
import type { SyncAuthenticator } from './sync-auth';
import { handleUpgrade, type UpgradeDeps, type UpgradeTarget } from './sync-upgrade';
import { AcceptBudget } from './thundering-herd';

const alice = userActor({ id: 'alice', orgId: 'o1' });

const upgrades = (): { server: UpgradeTarget; count: () => number } => {
  let taken = 0;
  return {
    server: {
      upgrade: () => {
        taken += 1;
        return true;
      },
    },
    count: () => taken,
  };
};

const deps = (overrides: Partial<UpgradeDeps> = {}): UpgradeDeps => ({
  path: '/_x/sync',
  buildId: 'build-1',
  maxConnections: 100,
  accept: new AcceptBudget({ perSecond: 100, burst: 100, clock: frozenClock(0) }),
  rng: () => 0.5,
  ready: () => true,
  socketCount: () => 0,
  newSocketId: () => 'sock-1',
  onGranted: () => undefined,
  onUngranted: () => undefined,
  ...overrides,
});

const dial = (headers: Record<string, string> = {}, url = 'https://app.example.com/_x/sync') =>
  new Request(url, { headers });

describe('the upgrade refuses a foreign origin', () => {
  test('a page on the app’s own host is admitted, whatever its port or scheme', async () => {
    const { server, count } = upgrades();
    for (const origin of ['https://app.example.com', 'http://app.example.com:3000']) {
      expect(await handleUpgrade(deps(), dial({ origin }), server)).toBeUndefined();
    }
    expect(count()).toBe(2);
  });

  // A sibling subdomain is same-site, so a SameSite=Lax session cookie rides its socket.
  test('a sibling host is refused 403 X_SOCKET_ORIGIN_REFUSED, before authenticate runs', async () => {
    const { server, count } = upgrades();
    let asked = 0;
    const authenticate: SyncAuthenticator = () => {
      asked += 1;
      return Promise.resolve({ actor: alice });
    };
    const response = await handleUpgrade(
      deps({ authenticate }),
      dial({ origin: 'https://evil.example.com', 'sec-fetch-site': 'same-site' }),
      server,
    );
    expect(response?.status).toBe(403);
    const body = (await response?.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('X_SOCKET_ORIGIN_REFUSED');
    expect(asked).toBe(0);
    expect(count()).toBe(0);
  });

  test('an origin the node was told about is admitted, exactly', async () => {
    const { server } = upgrades();
    const node = deps({ allowedOrigins: ['https://www.example.com'] });
    const url = 'https://sync.example.com/_x/sync';
    expect(
      await handleUpgrade(node, dial({ origin: 'https://www.example.com' }, url), server),
    ).toBeUndefined();
    const refused = await handleUpgrade(
      node,
      dial({ origin: 'https://www.example.com.evil.test' }, url),
      server,
    );
    expect(refused?.status).toBe(403);
  });

  // RFC 6455: a browser always sends Origin on the handshake. A client that sends none is not a
  // browser, so no visitor's cookie can be riding it.
  test('a dial with no Origin is a non-browser client and is not refused for it', async () => {
    const { server } = upgrades();
    expect(await handleUpgrade(deps(), dial(), server)).toBeUndefined();
  });
});

describe('the accept budget is spent only by an upgrade that authenticated', () => {
  test('a flood with no credential spends nothing, so a signed-in reconnect still gets in', async () => {
    const { server, count } = upgrades();
    const authenticate: SyncAuthenticator = (request) =>
      Promise.resolve(request.headers.get('cookie') === 'session=ok' ? { actor: alice } : null);
    const node = deps({
      authenticate,
      accept: new AcceptBudget({ perSecond: 1, burst: 1, clock: frozenClock(0) }),
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect((await handleUpgrade(node, dial(), server))?.status).toBe(401);
    }
    expect(await handleUpgrade(node, dial({ cookie: 'session=ok' }), server)).toBeUndefined();
    expect(count()).toBe(1);
    // And the budget still binds the ones that did authenticate.
    expect((await handleUpgrade(node, dial({ cookie: 'session=ok' }), server))?.status).toBe(503);
  });
});

describe('a reconnect herd reaches authenticate bounded by the burst', () => {
  test('dials beyond the burst are shed before authenticate; a taken socket keeps its token', async () => {
    const { server, count } = upgrades();
    let inFlight = 0;
    let peak = 0;
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const authenticate: SyncAuthenticator = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight -= 1;
      return { actor: alice };
    };
    const accept = new AcceptBudget({ perSecond: 1, burst: 2, clock: frozenClock(0) });
    const node = deps({ authenticate, accept });
    const herd = Array.from({ length: 6 }, () => handleUpgrade(node, dial(), server));
    open();
    const answers = await Promise.all(herd);
    expect(peak).toBe(2);
    expect(answers.filter((answer) => answer?.status === 503)).toHaveLength(4);
    expect(count()).toBe(2);
    expect(accept.tokens).toBe(0);
  });

  test('a refused credential gives its reserved token back', async () => {
    const { server } = upgrades();
    const accept = new AcceptBudget({ perSecond: 1, burst: 1, clock: frozenClock(0) });
    const node = deps({ authenticate: async () => null, accept });
    expect((await handleUpgrade(node, dial(), server))?.status).toBe(401);
    expect(accept.tokens).toBe(1);
  });

  test('an authenticator that throws gives its reserved token back', async () => {
    const { server } = upgrades();
    const accept = new AcceptBudget({ perSecond: 1, burst: 1, clock: frozenClock(0) });
    const node = deps({
      authenticate: () => Promise.reject(new TypeError('token service down')),
      accept,
    });
    expect((await handleUpgrade(node, dial(), server))?.status).toBe(503);
    expect(accept.tokens).toBe(1);
  });
});

describe('the origin refusal', () => {
  // A fix is a command an agent can run, never a sentence.
  test('its fix is the export that admits the page origin', () => {
    expect(new SocketOriginRefusedError({ reason: 'x' }).fix).toStartWith(
      'export APP_URL="https://www.example.com"',
    );
  });
});
