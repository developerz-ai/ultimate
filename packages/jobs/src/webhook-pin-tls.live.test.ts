// The DNS-rebinding defence of `webhook()`, over a REAL TLS socket rather than a recorded `init`:
// the delivery connects to the address the screen approved (the url's host is replaced by it) and
// proves the certificate against the endpoint's NAME (`tls.serverName`). `webhook.test.ts` pins
// the request it builds; only a listener can show Bun's `fetch` honours both halves — a runtime
// that ignored `serverName` would either refuse every pinned delivery or verify nothing at all.
//
// Opt-in (`.live.`): it mints a throwaway certificate with `openssl`, and skips where there is none.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory helper; the key and certificate live there for this run only.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { ctxOf, frozenClock, markListening } from '@ultimat3/core';
import { resetJobs } from './job';
import { stepRunner } from './steps';
import { memoryStepStore } from './steps-memory';
import { webhook } from './webhook';
import { memoryWebhookLedger } from './webhook-ledger';

const hasOpenssl = Bun.which('openssl') !== null;
const NAME = 'hooks.partner.test';

let dir = '';
let cert = '';
let server: ReturnType<typeof Bun.serve> | undefined;
let unannounce = (): void => undefined;
const hosts: string[] = [];

beforeAll(async () => {
  if (!hasOpenssl) return;
  dir = mkdtempSync(join(tmpdir(), 'x-webhook-tls-'));
  const minted = Bun.spawnSync(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${NAME}`,
      '-addext',
      `subjectAltName=DNS:${NAME}`,
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ],
    { timeout: 30_000 },
  );
  expect(minted.exitCode).toBe(0);
  cert = await Bun.file(join(dir, 'cert.pem')).text();
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    tls: { key: Bun.file(join(dir, 'key.pem')), cert },
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
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
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

describe.skipIf(!hasOpenssl)('live · webhook · a pinned delivery over real TLS', () => {
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
