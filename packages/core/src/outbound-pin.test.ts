// `outbound({ dial: 'public' })`'s pin over a REAL TLS socket: the connection goes to the address
// the screen approved and the certificate is proven against the NAME (`tls.serverName`). The unit
// suite pins the init it builds; only a listener shows Bun's `fetch` honours it. Modelled on
// `@ultimat3/jobs`' `webhook-pin-tls.live.test.ts`. The certificate is minted in-process
// (`tls-cert-fixture.ts`), so this needs no `openssl` and is an ordinary unit test.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from './errors';
import { markListening } from './listeners';
import { outbound } from './outbound';
import type { OutboundFetch } from './outbound-types';
import { selfSignedCert } from './tls-cert-fixture';

const NAME = 'api.vendor.test';
/** The public address the screen approves; the transport below reaches it on loopback. */
const PUBLIC = '93.184.216.34';

let cert = '';
let server: ReturnType<typeof Bun.serve> | undefined;
let unannounce = (): void => undefined;
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
  unannounce = markListening(server.url.origin);
});

afterAll(() => {
  unannounce();
  server?.stop(true);
});

/** The real `fetch`: the approved address routed to the listener, this run's root trusted. */
const loopback: OutboundFetch = (url, init) =>
  fetch(url.replace(PUBLIC, '127.0.0.1'), {
    ...init,
    signal: init.signal ?? null,
    tls: { ...init.tls, ca: cert },
  } as RequestInit);

const call = (host: string) =>
  outbound(
    {
      url: `https://${host}:${server?.port ?? 0}/v1`,
      vendor: 'v',
      dial: 'public',
      deadlineMs: 10_000,
    },
    {
      fetch: loopback,
      resolve: () => Promise.resolve([PUBLIC]),
      env: { ULTIMATE_ENV: 'production' },
    },
  ).then(
    (answer) => answer.text(),
    (error: unknown) => (isUltimateError(error) ? error.code : 'uncoded'),
  );

describe('unit · outbound · a pinned public dial over real TLS', () => {
  test('reaches the approved address and verifies the certificate against the NAME', async () => {
    expect(await call(NAME)).toBe('ok');
    expect(hosts.at(-1)).toBe(`${NAME}:${server?.port ?? 0}`);
  });

  test('a certificate for another name is refused, though the address is the same', async () => {
    const before = hosts.length;
    expect(await call('other.vendor.test')).toBe('X_OUTBOUND_UNREACHABLE');
    expect(hosts.length).toBe(before);
  });
});
