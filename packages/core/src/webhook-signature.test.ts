// The webhook wire format, at the tier both halves reach. What this file pins that neither
// `@ultimat3/jobs`' nor `@ultimat3/http`'s suite can: that the SENDING form and the RECEIVING form
// of the mac are the same function over the same bytes.
//
// That equality is the whole reason this module exists. It used to be two implementations — a
// signer in `jobs` and a verifier in `http`, neither able to import the other — held together by a
// hex literal asserted in two test files. Here it is one function, and `body: string` versus
// `body: Uint8Array` is the only difference between the two call sites.

import { describe, expect, test } from 'bun:test';
import {
  isCanonicalWebhookField,
  parseWebhookSignatureHeader,
  WEBHOOK_FIELD_MAX,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_TOPIC_HEADER,
  webhookHeaders,
  webhookMac,
  webhookSignature,
  webhookSigningString,
} from './webhook-signature';

const VECTOR = {
  secret: 'whsec_test_key',
  timestampSeconds: 1_700_000_000,
  eventId: 'evt_01HZ',
  topic: 'orders.paid',
  body: '{"amount":100}',
} as const;

const SIGNATURE =
  't=1700000000,v1=d0c20033393cad1ad55f01cdfe3abf419af925253e7b7c812bd172f210322e6b';

describe('the format', () => {
  test('the canonical string carries the version, the timestamp, the id, the topic and the body', () => {
    expect(webhookSigningString(VECTOR)).toBe('v1:1700000000:evt_01HZ:orders.paid:{"amount":100}');
  });

  test('the vector signs to the value both packages assert', () => {
    expect(webhookSignature(VECTOR)).toBe(SIGNATURE);
  });

  test('the version and the header names are the wire format', () => {
    expect(WEBHOOK_SIGNATURE_VERSION).toBe('v1');
    expect(WEBHOOK_ID_HEADER).toBe('x-ultimate-webhook-id');
    expect(WEBHOOK_TOPIC_HEADER).toBe('x-ultimate-webhook-topic');
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('x-ultimate-webhook-signature');
  });

  test('the headers carry the id, the topic and the signature, and never the secret', () => {
    const headers = webhookHeaders(VECTOR);
    expect(headers[WEBHOOK_ID_HEADER]).toBe(VECTOR.eventId);
    expect(headers[WEBHOOK_TOPIC_HEADER]).toBe(VECTOR.topic);
    expect(headers[WEBHOOK_SIGNATURE_HEADER]).toBe(SIGNATURE);
    expect(JSON.stringify(headers)).not.toContain(VECTOR.secret);
  });
});

describe('the sending form and the receiving form are one function', () => {
  const FIELDS = {
    secret: VECTOR.secret,
    timestampText: String(VECTOR.timestampSeconds),
    eventId: VECTOR.eventId,
    topic: VECTOR.topic,
  };

  test('a mac over TEXT equals the mac over the same BYTES', () => {
    // The signer holds the body as text; the verifier holds the bytes it read off the socket. If
    // these two ever answered differently, every delivery this framework sends would be rejected
    // by the receiver this framework ships — which is the failure the one-module move prevents.
    const text = webhookMac({ ...FIELDS, body: VECTOR.body });
    const bytes = webhookMac({ ...FIELDS, body: new TextEncoder().encode(VECTOR.body) });

    expect(text).toBe(bytes);
    expect(SIGNATURE).toContain(text);
  });

  test('a body that is not valid UTF-8 macs over what ARRIVED, not over a decode of it', () => {
    // Those bytes cannot survive a decode/encode round trip, so a verifier that decoded first
    // would compute its mac over bytes the sender never sent.
    const raw = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
    const overRaw = webhookMac({ ...FIELDS, body: raw });
    const overDecoded = webhookMac({ ...FIELDS, body: new TextDecoder().decode(raw) });

    expect(overRaw).not.toBe(overDecoded);
  });

  test('the timestamp is macd exactly as the header spells it', () => {
    // A mac is over bytes, so re-rendering the number would make `t=01700000000` and
    // `t=1700000000` one signature over two different headers.
    const base = { secret: 's', eventId: 'e', topic: 't', body: 'b' };
    expect(webhookMac({ ...base, timestampText: '01' })).not.toBe(
      webhookMac({ ...base, timestampText: '1' }),
    );
  });

  test('every signed field changes the mac', () => {
    const base = { secret: 's', timestampText: '1', eventId: 'e', topic: 't', body: 'b' };
    const variants = [
      webhookMac({ ...base, secret: 'other' }),
      webhookMac({ ...base, timestampText: '2' }),
      webhookMac({ ...base, eventId: 'e2' }),
      webhookMac({ ...base, topic: 't2' }),
      webhookMac({ ...base, body: 'b2' }),
    ];
    for (const variant of variants) expect(variant).not.toBe(webhookMac(base));
    expect(new Set(variants).size).toBe(variants.length);
  });
});

describe('parseWebhookSignatureHeader', () => {
  test('reads the two fields in either order and keeps the timestamp as written', () => {
    const forward = parseWebhookSignatureHeader('t=1700000000,v1=abc');
    expect(forward?.timestampText).toBe('1700000000');
    expect(forward?.timestampSeconds).toBe(1_700_000_000);
    expect(forward?.mac).toBe('abc');
    expect(parseWebhookSignatureHeader('v1=abc,t=17')?.mac).toBe('abc');
  });

  test('refuses everything this format does not define', () => {
    for (const header of [null, '', 'v1=abc', 't=1700000000', 'garbage', 't=1,v1=abc,junk']) {
      expect(parseWebhookSignatureHeader(header)).toBeUndefined();
    }
  });

  test('refuses a timestamp that is not digits, so a freshness window cannot be skipped', () => {
    // `Number('later')` is `NaN`, and `Math.abs(NaN) > toleranceMs` is FALSE — the one guard here
    // whose failure mode is "the check does not run" rather than "the check refuses".
    for (const header of ['t=later,v1=abc', 't=1e3,v1=abc', 't=1234567890123456,v1=abc']) {
      expect(parseWebhookSignatureHeader(header)).toBeUndefined();
    }
  });
});

describe('isCanonicalWebhookField', () => {
  test('refuses anything that could move a separator or forge a header', () => {
    const control = String.fromCharCode(13);
    for (const value of ['evt:01HZ', `a${control}b`, '', 'x'.repeat(WEBHOOK_FIELD_MAX + 1)]) {
      expect(isCanonicalWebhookField(value)).toBe(false);
    }
  });

  test('accepts the shapes a sender actually uses', () => {
    for (const value of [
      'evt_01HZ',
      'orders.paid',
      'a1b2-c3d4/v2',
      'x'.repeat(WEBHOOK_FIELD_MAX),
    ]) {
      expect(isCanonicalWebhookField(value)).toBe(true);
    }
  });
});
