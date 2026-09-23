// `webhook()` is a factory over `job()`, so what this file pins is the DECLARATION and the one
// attempt: a signed POST, a ledger row per attempt whatever the outcome, the split between a
// failure worth retrying and one that never changes, and the endpoint that stops taking deliveries
// after `disableAfter` of them in a row.
//
// The `fetch` seam is injected everywhere below — the framework's test preload seals the network,
// and a delivery whose transport a test cannot drive is a delivery no test can fail.

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  backoffDelay,
  type Ctx,
  createContext,
  frozenClock,
  isUltimateError,
  statedDelayMs,
  WEBHOOK_SIGNATURE_HEADER,
} from '@ultimat3/core';
import { getJob, isJobHandle, resetJobs } from './job';
import { retrySchedule } from './retry';
import { createStepRunner } from './steps';
import { createMemoryStepStore } from './steps-memory';
import { type WebhookDefinition, type WebhookEndpoint, webhook } from './webhook';
import { type MemoryWebhookLedger, memoryWebhookLedger } from './webhook-ledger';

const SECRET = 'whsec_never_leaks';
const NOW_MS = 1_700_000_000_000;

const ctx: Ctx = createContext();

const ENDPOINT: WebhookEndpoint = {
  id: 'ep_1',
  url: 'https://hooks.partner.test/inbox?token=leaks-if-rendered',
  secret: SECRET,
};

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

interface Harness {
  readonly ledger: MemoryWebhookLedger;
  readonly sent: Sent[];
  answer: () => Promise<Response>;
  run(attempt?: number): Promise<unknown>;
  readonly handle: ReturnType<typeof webhook>;
}

let sequence = 0;

/** A public address the harness resolves every hostname to, unless a test says otherwise. */
const PUBLIC_IP = '93.184.215.14';

const harness = (
  over: {
    endpoint?: WebhookEndpoint | null;
    topic?: string;
    disableAfter?: number;
    resolve?: (hostname: string) => Promise<readonly string[]>;
    allowPrivate?: boolean;
    env?: Readonly<Record<string, string | undefined>>;
  } = {},
): Harness => {
  sequence += 1;
  const ledger = memoryWebhookLedger();
  const sent: Sent[] = [];
  const state = {
    ledger,
    sent,
    answer: (): Promise<Response> => Promise.resolve(new Response('ok', { status: 200 })),
  };

  const definition: WebhookDefinition = {
    name: `partner-hooks-${sequence}`,
    tenant: 'none',
    ledger,
    clock: frozenClock(NOW_MS),
    ...(over.disableAfter === undefined ? {} : { disableAfter: over.disableAfter }),
    resolve: over.resolve ?? (() => Promise.resolve([PUBLIC_IP])),
    ...(over.allowPrivate === undefined ? {} : { allowPrivate: over.allowPrivate }),
    ...(over.env === undefined ? {} : { env: over.env }),
    endpoint: () => (over.endpoint === undefined ? ENDPOINT : over.endpoint),
    event: ({ eventId }) =>
      eventId === 'evt_missing'
        ? null
        : { topic: over.topic ?? 'orders.paid', body: '{"amount":100}' },
    fetch: (url, init) => {
      sent.push({ url, init });
      return state.answer();
    },
  };

  const handle = webhook(definition);
  return {
    ...state,
    handle,
    run: (attempt = 1): Promise<unknown> =>
      handle.run({
        input: { endpointId: 'ep_1', eventId: 'evt_1' },
        step: createStepRunner({
          runId: `run-${sequence}`,
          jobName: definition.name,
          store: createMemoryStepStore(),
        }).step,
        ctx,
        attempt,
        jobId: `job-${sequence}`,
        runId: `run-${sequence}`,
      }),
    get answer() {
      return state.answer;
    },
    set answer(next: () => Promise<Response>) {
      state.answer = next;
    },
  } as Harness;
};

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not-an-ultimate-error';
  }
  return 'delivered';
};

beforeEach(() => {
  resetJobs();
  sequence = 0;
});

describe('the factory', () => {
  test('returns a registered job handle keyed by the declared name', () => {
    const one = harness();
    expect(isJobHandle(one.handle)).toBe(true);
    expect(getJob('partner-hooks-1')).toBe(one.handle);
  });

  test('one delivery per endpoint per event, and the key says so', () => {
    // Not the event alone: the same event fans out to every subscribed endpoint, and a key without
    // the endpoint would dedupe every one of those into the first endpoint's delivery.
    const one = harness();
    expect(one.handle.idempotencyKeyFor({ endpointId: 'ep_1', eventId: 'evt_1' })).toBe(
      'partner-hooks-1:ep_1:evt_1',
    );
    expect(one.handle.idempotencyKeyFor({ endpointId: 'ep_2', eventId: 'evt_1' })).not.toBe(
      one.handle.idempotencyKeyFor({ endpointId: 'ep_1', eventId: 'evt_1' }),
    );
  });

  test('the retry schedule is cores backoff curve and not a second one', () => {
    const one = harness();
    const policy = one.handle.retry;
    const expected = [1, 2].map((attempt) =>
      backoffDelay({
        attempt,
        base: 1_000,
        max: 3_600_000,
        curve: 'exponential',
        jitter: 'none',
      }),
    );
    expect(retrySchedule({ ...policy, attempts: 3 })).toEqual(expected);
  });
});

describe('a delivery that lands', () => {
  test('POSTs the signed body to the endpoint and records the attempt', async () => {
    const one = harness();
    await one.run();

    expect(one.sent).toHaveLength(1);
    const [call] = one.sent;
    // The approved ADDRESS, reached as the endpoint's host — pinned (`webhook-target.ts`).
    expect(call?.url).toBe(ENDPOINT.url.replace('hooks.partner.test', PUBLIC_IP));
    expect(call?.init.method).toBe('POST');
    expect(call?.init.body).toBe('{"amount":100}');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['x-ultimate-webhook-id']).toBe('evt_1');
    expect(headers['x-ultimate-webhook-topic']).toBe('orders.paid');
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toStartWith('t=1700000000,v1=');
    // Never followed: a 3xx would re-POST a body signed for one host to another.
    expect(call?.init.redirect).toBe('manual');

    const [record] = one.ledger.attempts();
    expect(record?.ok).toBe(true);
    expect(record?.status).toBe(200);
    expect(record?.endpointId).toBe('ep_1');
    expect(record?.error).toBeUndefined();
  });

  test('an endpoint row carries its own headers and can never overwrite the signature', async () => {
    // An endpoint row is app data. If a row could set `x-ultimate-webhook-signature`, then whoever
    // can write that table can make a delivery say it was signed by something it was not.
    const one = harness({
      endpoint: {
        ...ENDPOINT,
        headers: { 'x-partner-key': 'abc', [WEBHOOK_SIGNATURE_HEADER]: 't=1,v1=forged' },
      },
    });
    await one.run();

    const headers = one.sent[0]?.init.headers as Record<string, string>;
    expect(headers['x-partner-key']).toBe('abc');
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toStartWith('t=1700000000,v1=');
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).not.toBe('t=1,v1=forged');
  });

  test('nothing durable carries the secret', async () => {
    const one = harness();
    await one.run();
    expect(JSON.stringify(one.ledger.attempts())).not.toContain(SECRET);
    const headers = one.sent[0]?.init.headers as Record<string, string>;
    expect(JSON.stringify(headers)).not.toContain(SECRET);
  });
});

describe('a delivery that does not land', () => {
  test('a 5xx is retryable and the ledger keeps the failed attempt', async () => {
    const one = harness();
    one.answer = () => Promise.resolve(new Response('boom', { status: 503 }));

    expect(await codeOf(() => one.run())).toBe('X_WEBHOOK_DELIVERY_FAILED');
    const [record] = one.ledger.attempts();
    expect(record?.ok).toBe(false);
    expect(record?.status).toBe(503);
  });

  test('a 4xx a retry cannot change is its own terminal code', async () => {
    const one = harness();
    one.answer = () => Promise.resolve(new Response('nope', { status: 404 }));
    expect(await codeOf(() => one.run())).toBe('X_WEBHOOK_DELIVERY_REJECTED');
  });

  test('a 409 is a concurrent writer and not a refusal — cores table decides, not a copy', async () => {
    // The private copy read `>= 500 || 408 || 425 || 429` and omitted the 409 that
    // `packages/core/src/retryable-status.ts` has always carried, so a receiver answering "another
    // writer won this round" dead-lettered on attempt 1 instead of landing on the next one.
    const one = harness();
    one.answer = () => Promise.resolve(new Response('conflict', { status: 409 }));

    let thrown: unknown;
    try {
      await one.run();
    } catch (error) {
      thrown = error;
    }
    expect(isUltimateError(thrown) ? thrown.code : undefined).toBe('X_WEBHOOK_DELIVERY_FAILED');
    expect(isUltimateError(thrown) ? thrown.retry : undefined).toBe('retryable');
  });

  test('a redirect is refused rather than followed', async () => {
    const one = harness();
    one.answer = () =>
      Promise.resolve(
        new Response(null, { status: 307, headers: { location: 'https://evil.test' } }),
      );
    expect(await codeOf(() => one.run())).toBe('X_WEBHOOK_DELIVERY_REJECTED');
  });

  test('a throttle carries the receivers own delay, so the backoff does not guess against it', async () => {
    const one = harness();
    one.answer = () =>
      Promise.resolve(
        new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
      );

    let thrown: unknown;
    try {
      await one.run();
    } catch (error) {
      thrown = error;
    }
    expect(isUltimateError(thrown) ? thrown.code : undefined).toBe('X_WEBHOOK_DELIVERY_THROTTLED');
    expect(statedDelayMs(thrown)).toBe(120_000);
  });

  test('a 429 with no readable retry-after is an ordinary retryable failure', async () => {
    const one = harness();
    one.answer = () => Promise.resolve(new Response('slow down', { status: 429 }));
    expect(await codeOf(() => one.run())).toBe('X_WEBHOOK_DELIVERY_FAILED');
  });

  test('a transport failure records status null and never renders the throwable raw', async () => {
    const one = harness();
    // A foreign error is the code under test's INPUT, never this test's verdict.
    one.answer = () => Promise.reject(new Error('ECONNREFUSED 10.0.0.9:443'));

    expect(await codeOf(() => one.run())).toBe('X_WEBHOOK_DELIVERY_FAILED');
    const [record] = one.ledger.attempts();
    expect(record?.status).toBeNull();
    expect(record?.error).toContain('ECONNREFUSED');
  });

  test('the cause names the endpoint without its query string', async () => {
    const one = harness();
    one.answer = () => Promise.resolve(new Response('boom', { status: 503 }));
    let thrown: unknown;
    try {
      await one.run();
    } catch (error) {
      thrown = error;
    }
    if (!isUltimateError(thrown)) return expect.unreachable('expected an UltimateError');
    expect(thrown.cause).toContain('https://hooks.partner.test/inbox');
    // Several senders in the wild put a bearer token in the query, and a `cause` reaches the log
    // store as an unredactable field.
    expect(`${thrown.cause} ${thrown.fix}`).not.toContain('leaks-if-rendered');
    expect(`${thrown.cause} ${thrown.fix}`).not.toContain(SECRET);
  });
});

describe('an endpoint that keeps failing stops taking deliveries', () => {
  test('the third consecutive failure disables it instead of retrying forever', async () => {
    const one = harness({ disableAfter: 3 });
    one.answer = () => Promise.resolve(new Response('boom', { status: 500 }));

    expect(await codeOf(() => one.run(1))).toBe('X_WEBHOOK_DELIVERY_FAILED');
    expect(await codeOf(() => one.run(2))).toBe('X_WEBHOOK_DELIVERY_FAILED');
    expect(one.ledger.disabled().size).toBe(0);

    expect(await codeOf(() => one.run(3))).toBe('X_WEBHOOK_ENDPOINT_DISABLED');
    expect(one.ledger.disabled().get('ep_1')).toContain('3');
    // The attempt still happened and is still on the ledger: the endpoint went off AFTER it.
    expect(one.ledger.attempts()).toHaveLength(3);
  });

  test('one success clears the run, so an endpoint that recovers is never disabled', async () => {
    const one = harness({ disableAfter: 2 });
    one.answer = () => Promise.resolve(new Response('boom', { status: 500 }));
    await codeOf(() => one.run(1));
    one.answer = () => Promise.resolve(new Response('ok', { status: 202 }));
    await one.run(2);
    one.answer = () => Promise.resolve(new Response('boom', { status: 500 }));

    expect(await codeOf(() => one.run(3))).toBe('X_WEBHOOK_DELIVERY_FAILED');
    expect(one.ledger.disabled().size).toBe(0);
  });

  test('a disabled endpoint is never fetched at all', async () => {
    const one = harness({ endpoint: { ...ENDPOINT, disabled: true } });
    expect(await codeOf(() => one.run())).toBe('X_WEBHOOK_ENDPOINT_DISABLED');
    expect(one.sent).toHaveLength(0);
    expect(one.ledger.attempts()).toHaveLength(0);
  });
});

describe('a delivery that can never be signed is refused before the socket opens', () => {
  test('an endpoint the app cannot name', async () => {
    const one = harness({ endpoint: null });
    expect(await codeOf(() => one.run())).toBe('X_WEBHOOK_ENDPOINT_UNKNOWN');
    expect(one.sent).toHaveLength(0);
  });

  test('an event the app cannot name', async () => {
    const one = harness();
    expect(
      await codeOf(() =>
        one.handle.run({
          input: { endpointId: 'ep_1', eventId: 'evt_missing' },
          step: createStepRunner({
            runId: 'run-x',
            jobName: 'partner-hooks-1',
            store: createMemoryStepStore(),
          }).step,
          ctx,
          attempt: 1,
          jobId: 'job-x',
          runId: 'run-x',
        }),
      ),
    ).toBe('X_WEBHOOK_EVENT_UNKNOWN');
    expect(one.sent).toHaveLength(0);
  });

  test('a topic carrying the canonical separator', async () => {
    const one = harness({ topic: 'orders:paid' });
    expect(await codeOf(() => one.run())).toBe('X_WEBHOOK_EVENT_INVALID');
    expect(one.sent).toHaveLength(0);
  });

  test('an endpoint with no secret, or a url no delivery may open', async () => {
    for (const endpoint of [
      { ...ENDPOINT, secret: '' },
      { ...ENDPOINT, url: 'file:///etc/passwd' },
      { ...ENDPOINT, url: 'not a url' },
    ]) {
      const one = harness({ endpoint });
      expect(await codeOf(() => one.run())).toBe('X_WEBHOOK_ENDPOINT_INVALID');
      expect(one.sent).toHaveLength(0);
    }
  });

  // A dev receiver is `http://localhost:…`, which is loopback: it needs BOTH a local environment
  // (for `http:`) and the explicit `allowPrivate` opt-out (for the address).
  test('a plain http dev receiver is allowed, locally and with allowPrivate', async () => {
    const one = harness({
      endpoint: { ...ENDPOINT, url: 'http://localhost:4000/hooks' },
      resolve: () => Promise.resolve(['127.0.0.1']),
      allowPrivate: true,
      env: { ULTIMATE_ENV: 'development' },
    });
    expect(await codeOf(() => one.run())).toBe('delivered');
  });
});

/**
 * A tenant-supplied URL is screened before the first byte leaves. Delivery accepted any host:
 * loopback, RFC 1918, link-local — `169.254.169.254` is the cloud metadata service — so a customer
 * who could register an endpoint could make the worker POST into the cluster.
 */
describe('an endpoint that points inside the network', () => {
  const literals = [
    'http://127.0.0.1/hook',
    'https://10.0.0.1/hook',
    'https://172.16.5.4/hook',
    'https://192.168.1.1/hook',
    'http://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/hook',
    'https://0.0.0.0/hook',
    'https://[::1]/hook',
    'https://[fd00::1]/hook',
    'https://[::ffff:127.0.0.1]/hook',
  ];

  for (const url of literals) {
    test(`${url} is refused and never sent`, async () => {
      const one = harness({ endpoint: { ...ENDPOINT, url }, env: { ULTIMATE_ENV: 'development' } });
      expect(await codeOf(() => one.run())).toBe('X_WEBHOOK_ENDPOINT_INVALID');
      expect(one.sent).toHaveLength(0);
    });
  }

  test('a hostname resolving to a private address is refused — ANY one of its addresses', async () => {
    const one = harness({ resolve: () => Promise.resolve([PUBLIC_IP, '10.0.0.5']) });
    expect(await codeOf(() => one.run())).toBe('X_WEBHOOK_ENDPOINT_INVALID');
    expect(one.sent).toHaveLength(0);
  });

  test('allowPrivate is the explicit opt-out for a receiver inside the network', async () => {
    const one = harness({ resolve: () => Promise.resolve(['10.0.0.5']), allowPrivate: true });
    expect(await codeOf(() => one.run())).toBe('delivered');
  });

  test('http: outside a local environment is refused; https: is not', async () => {
    const production = { ULTIMATE_ENV: 'production' };
    const plain = harness({
      endpoint: { ...ENDPOINT, url: 'http://hooks.partner.test/in' },
      env: production,
    });
    expect(await codeOf(() => plain.run())).toBe('X_WEBHOOK_ENDPOINT_INVALID');
    expect(plain.sent).toHaveLength(0);
    expect(await codeOf(() => harness({ env: production }).run())).toBe('delivered');
    // No environment named at all is production — the process that forgot to say is not local.
    const unnamed = harness({
      endpoint: { ...ENDPOINT, url: 'http://hooks.partner.test/in' },
      env: {},
    });
    expect(await codeOf(() => unnamed.run())).toBe('X_WEBHOOK_ENDPOINT_INVALID');
  });

  // Resolved once and CONNECTED to that address: a hostname that answered a public address to the
  // screen and a private one to the socket (DNS rebinding) cannot reach past it.
  test('the connection is pinned to the address the screen approved', async () => {
    const one = harness();
    expect(await codeOf(() => one.run())).toBe('delivered');
    const sent = one.sent[0];
    expect(new URL(sent?.url ?? '').hostname).toBe(PUBLIC_IP);
    const init = sent?.init as (RequestInit & { tls?: { serverName?: string } }) | undefined;
    expect((init?.headers as Record<string, string> | undefined)?.['host']).toBe(
      'hooks.partner.test',
    );
    expect(init?.tls?.serverName).toBe('hooks.partner.test');
  });

  test('a name that does not resolve is a failed delivery the queue retries, not a refusal', async () => {
    const one = harness({ resolve: () => Promise.reject(new TypeError('ENOTFOUND')) });
    expect(await codeOf(() => one.run())).toBe('X_WEBHOOK_DELIVERY_FAILED');
    expect(one.sent).toHaveLength(0);
  });
});
