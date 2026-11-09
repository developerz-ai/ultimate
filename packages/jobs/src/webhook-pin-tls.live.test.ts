// The DNS-rebinding defence of `webhook()`, over a REAL TLS socket rather than a recorded `init`:
// the delivery connects to the address the screen approved (the url's host is replaced by it) and
// proves the certificate against the endpoint's NAME (`tls.serverName`). `webhook.test.ts` pins
// the request it builds; only a listener can show Bun's `fetch` honours both halves — a runtime
// that ignored `serverName` would either refuse every pinned delivery or verify nothing at all.
//
// The certificate is minted in-process by `@ultimat3/core`'s `tls-cert-fixture.ts` (WebCrypto + a
// hand-written X.509), so no host `openssl` is needed and nothing skips: both halves always run.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, frozenClock, markListening } from '@ultimat3/core';
// A test-only fixture core does not export: one minter for every TLS test, not a copy per package.
import { selfSignedCert } from '../../core/src/tls-cert-fixture';
import { resetJobs } from './job';
import { stepRunner } from './steps';
import { memoryStepStore } from './steps-memory';
import { webhook } from './webhook';
import { memoryWebhookLedger } from './webhook-ledger';

const NAME = 'hooks.partner.test';

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
  // A server this process opened is not egress: announced, the sealed `fetch` lets it through.
  unannounce = markListening(server.url.origin);
});

afterAll(() => {
  unannounce();
  server?.stop(true);
  resetJobs();
});

let sequence = 0;

/** One attempt against the listener, the endpoint named `host`, the connection pinned to loopback. */
async function deliver(host: string): Promise<unknown> {
  sequence += 1;
  const name = `pinned-hooks-${sequence}`;
  const handle = webhook({
    name,
    tenant: 'none',
    ledger: memoryWebhookLedger(),
    clock: frozenClock(1_700_000_000_000),
    // The name resolves to loopback, so the screen needs its explicit opt-out.
    resolve: () => Promise.resolve(['127.0.0.1']),
    allowPrivate: true,
    endpoint: () => ({
      id: 'ep_1',
      url: `https://${host}:${server?.port ?? 0}/inbox`,
      secret: 'whsec_test',
    }),
    event: () => ({ topic: 'orders.paid', body: '{"amount":100}' }),
    // The real `fetch`, with only this run's throwaway root added to what the framework built.
    fetch: (url, init) =>
      fetch(url, { ...init, tls: { ...(init as { tls?: object }).tls, ca: cert } } as RequestInit),
  });
  try {
    await handle.run({
      input: { endpointId: 'ep_1', eventId: 'evt_1' },
      step: stepRunner({ runId: `run-${sequence}`, jobName: name, store: memoryStepStore() }).step,
      ctx: ctxOf(),
      attempt: 1,
      finalAttempt: false,
      progress: () => undefined,
      jobId: `job-${sequence}`,
      runId: `run-${sequence}`,
    });
    return 'delivered';
  } catch (error) {
    return (error as { code?: string }).code ?? 'thrown';
  }
}

describe('live · webhook · a pinned delivery over real TLS', () => {
  test('reaches the approved address and verifies the certificate against the NAME', async () => {
    expect(await deliver(NAME)).toBe('delivered');
    expect(hosts.at(-1)).toBe(`${NAME}:${server?.port ?? 0}`);
  });

  test('a certificate for another name is refused, though the address is the same', async () => {
    const before = hosts.length;
    expect(await deliver('other.partner.test')).toBe('X_WEBHOOK_DELIVERY_FAILED');
    expect(hosts.length).toBe(before);
  });
});
