// `webhookReceiver()` through the real `httpPipeline` over the memory driver: every body shape a
// pinned action refused reaches `verify`, a refusal queues nothing, an answer short-circuits, a
// failed enqueue is a 503 and never an ack, and non-UTF-8 bytes reach `handle` byte-identical.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError, REDACTED } from '@ultimat3/core';
import { installJobDriver, resetJobDriver } from './adapter';
import { memoryJobDriver } from './driver-memory';
import { inspectJob } from './inspect';
import { resetJobs } from './job';
import { resetJobsFacade } from './outbox';
import { resetTasks } from './task';
import { webhookReceiver, webhookReceiverRoutes } from './webhook-receiver';
import { receiverHarness, sign } from './webhook-receiver-fixture';

const PATH = '/hooks/vendor/acct_9';

let driver = memoryJobDriver();

beforeEach(() => {
  resetJobs();
  resetTasks();
  resetJobsFacade();
  driver = memoryJobDriver();
  installJobDriver(driver);
});

afterEach(() => {
  resetJobs();
  resetTasks();
  resetJobDriver();
});

const queued = async (name: string) => (await driver.introspect?.list({ name })) ?? [];

describe('webhookReceiver: the door', () => {
  test('XML, octet-stream, no content type and malformed JSON all reach verify and queue', async () => {
    const h = receiverHarness();
    const cases = [
      { body: '<event id="1"/>', contentType: 'application/xml' },
      { body: 'raw\x00bytes', contentType: 'application/octet-stream' },
      { body: '{"a":1}', contentType: undefined },
      { body: '{not json', contentType: 'application/json' },
    ];
    for (const [index, { body, contentType }] of cases.entries()) {
      const response = await h.post(PATH, body, {
        eventId: `evt_${index}`,
        ...(contentType === undefined ? {} : { contentType }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, eventId: `evt_${index}`, deduped: false });
    }
    expect(h.seen.verified.map((call) => new TextDecoder().decode(call.bytes))).toEqual(
      cases.map((entry) => entry.body),
    );
    expect(await queued(h.receiver.name)).toHaveLength(4);
  });

  test('a bad signature is a 401 and queues nothing', async () => {
    const h = receiverHarness();
    const response = await h.post(PATH, '{"id":"evt_1"}', { signature: sign('{"id":"evt_2"}') });
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('X_WEBHOOK_SIGNATURE_INVALID');
    expect(await queued(h.receiver.name)).toHaveLength(0);
  });

  test(':param reaches verify', async () => {
    const h = receiverHarness();
    await h.post(PATH, '{}');
    expect(h.seen.verified[0]?.params).toEqual({ account: 'acct_9' });
  });

  test('an answer short-circuits: the response is verify’s and nothing queues', async () => {
    const h = receiverHarness({
      verify: () => ({ answer: new Response('challenge-42', { status: 200 }) }),
    });
    const response = await h.post(PATH, 'confirm');
    expect(await response.text()).toBe('challenge-42');
    expect(await queued(h.receiver.name)).toHaveLength(0);
  });

  test('a live redelivery is deduped onto the same row', async () => {
    const h = receiverHarness();
    await h.post(PATH, '{}', { eventId: 'evt_same' });
    const again = await h.post(PATH, '{}', { eventId: 'evt_same' });
    expect(await again.json()).toEqual({ ok: true, eventId: 'evt_same', deduped: true });
    expect(await queued(h.receiver.name)).toHaveLength(1);
  });

  test('a failing enqueue answers 503 with retry-after, never 200', async () => {
    const h = receiverHarness();
    installJobDriver({
      ...driver,
      enqueue: () => Promise.reject(new TypeError('connection refused')),
    });
    const response = await h.post(PATH, '{}');
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('30');
    expect((await response.json()).code).toBe('X_WEBHOOK_RECEIVER_UNAVAILABLE');
  });

  test('over maxBytes is X_BODY_INVALID naming the receiver, and verify never runs', async () => {
    const h = receiverHarness({ maxBytes: 8 });
    const response = await h.post(PATH, '0123456789');
    expect((await response.json()).code).toBe('X_BODY_INVALID');
    expect(h.seen.verified).toHaveLength(0);
  });

  test('the route is public, named webhook.<name>, and GET exists only with a handshake', async () => {
    const plain = receiverHarness();
    expect(
      plain.receiver.routes().map((route) => [route.method, route.meta.name, route.meta.auth]),
    ).toEqual([['POST', `webhook.${plain.receiver.name}`, 'public']]);
    const get = (pipeline: typeof plain.pipeline) =>
      pipeline.handle(new Request(`http://localhost${PATH}?challenge=7`), { role: 'web' });
    expect((await get(plain.pipeline)).status).toBe(405);

    const shaken = receiverHarness({
      handshake: (inbound) => new Response(inbound.url.searchParams.get('challenge')),
    });
    const answered = await get(shaken.pipeline);
    expect(await answered.text()).toBe('7');
  });
});

describe('webhookReceiver: the event id verify answers', () => {
  const LONG = 'e'.repeat(8_000);

  test.each([
    ['8,000 characters', LONG],
    ['empty', ''],
    ['a control character', 'evt\n1'],
    ['a space', 'evt 1'],
  ])('%s is a 422 X_WEBHOOK_EVENT_ID_INVALID, never queued and never echoed', async (_, id) => {
    const h = receiverHarness({ verify: () => ({ eventId: id, payload: null }) });
    const response = await h.post(PATH, '{}');
    const text = await response.text();
    expect(response.status).toBe(422);
    expect(JSON.parse(text).code).toBe('X_WEBHOOK_EVENT_ID_INVALID');
    if (id.length > 0) expect(text).not.toContain(id);
    expect(await queued(h.receiver.name)).toHaveLength(0);
  });

  test('256 printable characters is the most it takes', async () => {
    const h = receiverHarness({ verify: () => ({ eventId: 'e'.repeat(256), payload: null }) });
    expect((await h.post(PATH, '{}')).status).toBe(200);
    const over = receiverHarness({ verify: () => ({ eventId: 'e'.repeat(257), payload: null }) });
    expect((await over.post(PATH, '{}')).status).toBe(422);
  });
});

describe('webhookReceiver: the job', () => {
  test('handle receives the payload verify answered, and a retry never re-verifies', async () => {
    let failOnce = true;
    const handled: unknown[] = [];
    const h = receiverHarness({
      retry: { attempts: 2, backoff: 'fixed', delay: 0, jitter: 'none' },
      handle: ({ payload, attempt }) => {
        handled.push([attempt, payload]);
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new TypeError('a downstream outage'));
        }
        return Promise.resolve();
      },
    });
    await h.post(PATH, '{"note":"café"}', { eventId: 'evt_retry' });
    const worker = h.worker(driver);
    await worker.tick();
    await worker.tick();
    expect(handled).toEqual([
      [1, { text: '{"note":"café"}' }],
      [2, { text: '{"note":"café"}' }],
    ]);
    // The vendor's freshness window may have closed by attempt 2: verify ran once, at the door.
    expect(h.seen.verified).toHaveLength(1);
  });

  test('x jobs show masks the stored payload', async () => {
    const h = receiverHarness();
    await h.post(PATH, '{"card":"4111111111111111"}', { eventId: 'evt_card' });
    const [row] = await queued(h.receiver.name);
    const shown = await inspectJob(driver, row?.id ?? '');
    expect(shown?.input).toMatchObject({ eventId: 'evt_card', payload: REDACTED });
    expect(JSON.stringify(shown)).not.toContain('4111');
  });
});

describe('webhookReceiverRoutes: the one registration', () => {
  test('every declared receiver’s routes, and nothing a plain job declares', () => {
    const a = receiverHarness();
    const b = receiverHarness({ path: '/hooks/other', handshake: () => new Response('ok') });
    expect(webhookReceiverRoutes()).toEqual([...a.receiver.routes(), ...b.receiver.routes()]);
    resetJobs();
    expect(webhookReceiverRoutes()).toEqual([]);
  });
});

describe('webhookReceiver: the declaration', () => {
  const declare = (over: Record<string, unknown>): string => {
    try {
      webhookReceiver({
        name: 'refused',
        path: '/hooks/refused',
        tenant: 'none',
        verify: () => ({ eventId: 'e', payload: null }),
        handle: () => Promise.resolve(),
        ...over,
      } as Parameters<typeof webhookReceiver>[0]);
      return 'declared';
    } catch (error) {
      resetJobs();
      return isUltimateError(error) ? `${error.code}: ${error.cause}` : 'uncoded';
    }
  };

  test.each([
    ['hooks/relative', 'path'],
    ['/api/hooks', '/api'],
    ['/_x/hooks', '/_x'],
    ['/hooks/', 'path'],
  ])('path %s is refused', (path, named) => {
    const answer = declare({ path });
    expect(answer).toStartWith('X_WEBHOOK_RECEIVER_INVALID');
    expect(answer).toContain(named);
  });

  test('a missing verify, a non-function handshake and a bad maxBytes are refused', () => {
    expect(declare({ verify: undefined })).toContain('verify is not a function');
    expect(declare({ handshake: 'yes' })).toContain('handshake');
    expect(declare({ maxBytes: 0 })).toContain('maxBytes');
    expect(declare({})).toBe('declared');
  });
});
