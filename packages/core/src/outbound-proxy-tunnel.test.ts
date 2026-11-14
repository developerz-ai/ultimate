// `outbound({ proxy })` over a REAL `CONNECT` tunnel and a real TLS listener: the screen runs
// before the proxy, so the tunnel is opened to the APPROVED address and never to the name; a
// private answer is refused before the proxy hears a byte; and `tls.serverName` survives the
// tunnel, so the certificate is still proven against the NAME (measured on Bun 1.4.4).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from './errors';
import { markListening } from './listeners';
import { outbound } from './outbound';
import type { ConnectProxy } from './outbound-fixture';
import { connectProxy } from './outbound-fixture';
import type { OutboundFetch } from './outbound-types';
import { selfSignedCert } from './tls-cert-fixture';

const NAME = 'api.vendor.test';
/** The public address the screen approves; the proxy routes it to the loopback listener. */
const PUBLIC = '93.184.216.34';

let cert = '';
let server: ReturnType<typeof Bun.serve> | undefined;
let proxy: ConnectProxy | undefined;
const releases: (() => void)[] = [];
const hosts: string[] = [];

beforeAll(async () => {
  const minted = await selfSignedCert(NAME);
  cert = minted.cert;
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    tls: { key: minted.key, cert },
    fetch: (request) => {
      hosts.push(request.headers.get('host') ?? '');
      return new Response('ok');
    },
  });
  proxy = connectProxy((host) => (host === PUBLIC ? '127.0.0.1' : host));
  // The sealed test `fetch` judges a call by its TARGET: the loopback proxy is what answers for
  // the approved address here, so that origin is this process's own socket.
  releases.push(markListening(`https://${PUBLIC}:${String(server.port)}`));
});

afterAll(() => {
  for (const release of releases) release();
  proxy?.stop();
  server?.stop(true);
});

/** The real `fetch`, this run's root trusted; the init (proxy included) is passed as built. */
const trusting: OutboundFetch = (url, init) =>
  fetch(url, {
    ...init,
    signal: init.signal ?? null,
    tls: { ...init.tls, ca: cert },
  } as RequestInit);

const call = (host: string, address: string) =>
  outbound(
    {
      url: `https://${host}:${String(server?.port ?? 0)}/v1`,
      vendor: 'v',
      dial: 'public',
      deadlineMs: 10_000,
      retry: { attempts: 1, base: 0, max: 0, jitter: 'none' },
      proxy: `${(proxy?.origin ?? '').replace('//', '//user:s3cret@')}`,
    },
    {
      fetch: trusting,
      resolve: () => Promise.resolve([address]),
      env: { ULTIMATE_ENV: 'production' },
    },
  ).then(
    (answer) => answer.text(),
    (error: unknown) => (isUltimateError(error) ? error.code : 'uncoded'),
  );

describe('unit · outbound · a proxied public dial over a real CONNECT tunnel', () => {
  test('tunnels to the APPROVED address, proves the NAME, and carries the proxy credential', async () => {
    expect(await call(NAME, PUBLIC)).toBe('ok');
    expect(proxy?.targets.at(-1)).toBe(`${PUBLIC}:${String(server?.port ?? 0)}`);
    expect(proxy?.authorizations.at(-1)).toBe(`Basic ${btoa('user:s3cret')}`);
    expect(hosts.at(-1)).toBe(`${NAME}:${String(server?.port ?? 0)}`);
  });

  test('a name answering a private address is refused before the proxy hears a byte', async () => {
    const before = proxy?.targets.length;
    expect(await call(NAME, '127.0.0.1')).toBe('X_OUTBOUND_HOST_BLOCKED');
    expect(proxy?.targets.length).toBe(before);
  });

  test('tls.serverName survives the tunnel: a certificate for another name is refused', async () => {
    const before = proxy?.targets.length ?? 0;
    expect(await call('other.vendor.test', PUBLIC)).toBe('X_OUTBOUND_UNREACHABLE');
    // The tunnel WAS opened: the refusal is the certificate check inside it, not a missed dial.
    expect(proxy?.targets.length).toBe(before + 1);
  });
});
