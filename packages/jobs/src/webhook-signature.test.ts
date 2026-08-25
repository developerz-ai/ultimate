// The outbound half of the wire format, pinned against the ONE literal the inbound half also
// asserts.
//
// `WEBHOOK_VECTOR` is the CROSS-PACKAGE pin. `@ultimat3/http` verifies this format and neither
// package may import the other — this one's boundary forbids `http`, and http (tier 2) may not
// reach tier 3 — so a round trip cannot be written as one test in either tree. What can be
// written is one vector, twice: `packages/http/src/webhook-verify.test.ts` carries the same five
// values and the same hex and asserts that a request built from them VERIFIES, this file asserts
// that signing them PRODUCES them. Either side changing the canonical string turns its own file
// red, which is the property a round trip would have bought.

import { describe, expect, test } from 'bun:test';
import type { WebhookSigningInput } from '@ultimat3/core';
import {
  isCanonicalWebhookField,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TOPIC_HEADER,
  webhookHeaders,
  webhookSignature,
  webhookSigningString,
} from '@ultimat3/core';

const WEBHOOK_VECTOR = {
  secret: 'whsec_test_key',
  timestampSeconds: 1_700_000_000,
  eventId: 'evt_01HZ',
  topic: 'orders.paid',
  body: '{"amount":100}',
  signature: 't=1700000000,v1=d0c20033393cad1ad55f01cdfe3abf419af925253e7b7c812bd172f210322e6b',
} as const;

describe('the wire format', () => {
  test('the vector signs to the exact value @ultimat3/http asserts it can verify', () => {
    expect(webhookSignature(WEBHOOK_VECTOR)).toBe(WEBHOOK_VECTOR.signature);
  });

  test('the canonical string carries the version, the timestamp, the id, the topic and the body', () => {
    expect(webhookSigningString(WEBHOOK_VECTOR)).toBe(
      'v1:1700000000:evt_01HZ:orders.paid:{"amount":100}',
    );
  });

  test('the header names are part of the format', () => {
    expect(WEBHOOK_ID_HEADER).toBe('x-ultimate-webhook-id');
    expect(WEBHOOK_TOPIC_HEADER).toBe('x-ultimate-webhook-topic');
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('x-ultimate-webhook-signature');
  });

  test('the headers carry the id, the topic and the signature and nothing else', () => {
    const headers = webhookHeaders(WEBHOOK_VECTOR);
    expect(headers).toEqual({
      'x-ultimate-webhook-id': 'evt_01HZ',
      'x-ultimate-webhook-topic': 'orders.paid',
      'x-ultimate-webhook-signature': WEBHOOK_VECTOR.signature,
    });
    // The secret is what proves the delivery; it is never what the delivery carries.
    expect(JSON.stringify(headers)).not.toContain(WEBHOOK_VECTOR.secret);
  });
});

describe('the mac covers everything a receiver reads', () => {
  const distinct = (over: Partial<WebhookSigningInput>): string =>
    webhookSignature({ ...WEBHOOK_VECTOR, ...over });

  test('a different timestamp, id, topic, body or secret is a different signature', () => {
    const variants = [
      distinct({ timestampSeconds: 1_700_000_001 }),
      distinct({ eventId: 'evt_01J0' }),
      distinct({ topic: 'orders.refunded' }),
      distinct({ body: '{"amount":101}' }),
      distinct({ secret: 'whsec_other_key' }),
    ];
    for (const variant of variants) expect(variant).not.toBe(WEBHOOK_VECTOR.signature);
    // All five distinct from each other too: a mac that dropped one field would collide here.
    expect(new Set(variants).size).toBe(variants.length);
  });
});

describe('isCanonicalWebhookField', () => {
  test('refuses anything that could move a separator', () => {
    expect(isCanonicalWebhookField('evt:01HZ')).toBe(false);
    expect(isCanonicalWebhookField('orders\npaid')).toBe(false);
    expect(isCanonicalWebhookField('orders\rpaid')).toBe(false);
    expect(isCanonicalWebhookField('')).toBe(false);
    expect(isCanonicalWebhookField('x'.repeat(201))).toBe(false);
  });

  test('accepts the shapes a sender actually uses', () => {
    expect(isCanonicalWebhookField('evt_01HZ')).toBe(true);
    expect(isCanonicalWebhookField('orders.paid')).toBe(true);
    expect(isCanonicalWebhookField('a1b2-c3d4/v2')).toBe(true);
    expect(isCanonicalWebhookField('x'.repeat(200))).toBe(true);
  });
});
