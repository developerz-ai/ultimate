// What an endpoint row's own `headers` may and may not change on a delivery. A row is app data, so
// whoever can write that table must not be able to forge the signature, the event id, the host or
// the content type — in any letter case. Split from `webhook.test.ts` at the file ceiling.

import { beforeEach, describe, expect, test } from 'bun:test';
import { WEBHOOK_SIGNATURE_HEADER } from '@ultimat3/core';
import { resetJobs } from './job';
import { ENDPOINT, harness, resetHarness } from './webhook-harness-fixture';

beforeEach(() => {
  resetJobs();
  resetHarness();
});

describe("an endpoint row's headers", () => {
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

  test('endpoint headers in any case cannot alter host, content-type or the signature', async () => {
    // Header names are case-insensitive on the wire. A spread keeps `Host` beside `host` as two
    // keys, and `fetch` JOINS them — so a row could make the delivery say `evil.test, <host>`, a
    // content type of `text/plain, application/json`, and a signature list carrying a forgery.
    const one = harness({
      endpoint: {
        ...ENDPOINT,
        headers: {
          Host: 'evil.test',
          'Content-Type': 'text/plain',
          'X-Ultimate-Webhook-Signature': 't=1,v1=forged',
          'X-Ultimate-Webhook-Id': 'evt_forged',
          'X-Partner-Key': 'abc',
        },
      },
    });
    await one.run();
    // Read exactly as the platform `fetch` reads `init.headers`.
    const wire = new Headers(one.sent[0]?.init.headers);
    expect(wire.get('host')).toBe('hooks.partner.test');
    expect(wire.get('content-type')).toBe('application/json');
    expect(wire.get(WEBHOOK_SIGNATURE_HEADER)).toMatch(/^t=1700000000,v1=[0-9a-f]+$/);
    expect(wire.get('x-ultimate-webhook-id')).toBe('evt_1');
    expect(wire.get('x-partner-key')).toBe('abc');
  });
});
