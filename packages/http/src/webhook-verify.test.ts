// The inbound half of the webhook wire format. What this file pins is the SECURITY properties, in
// the order they get written wrong: a tampered body, a moved timestamp, a stale one, a second
// secret, and an event id that would make two different deliveries hash to one string.
//
// `WEBHOOK_VECTOR` below is the CROSS-PACKAGE pin. `@ultimat3/jobs` (tier 3) may not import this
// package and this package (tier 2) may not import that one, so the two halves of the format can
// only be held together by a literal both sides assert. `packages/jobs/src/webhook-signature.test.ts`
// carries the same five values and the same hex; either side changing the canonical string turns
// its own file red.

import { describe, expect, test } from 'bun:test';
import {
  isUltimateError,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TOPIC_HEADER,
} from '@ultimat3/core';
import {
  DEFAULT_WEBHOOK_BODY_LIMIT,
  DEFAULT_WEBHOOK_TOLERANCE_MS,
  verifyWebhookSignature,
} from './webhook-verify';

/** The one literal both packages assert. Recomputing it here would prove nothing. */
const WEBHOOK_VECTOR = {
  secret: 'whsec_test_key',
  timestampSeconds: 1_700_000_000,
  eventId: 'evt_01HZ',
  topic: 'orders.paid',
  body: '{"amount":100}',
  signature: 't=1700000000,v1=d0c20033393cad1ad55f01cdfe3abf419af925253e7b7c812bd172f210322e6b',
} as const;

const SIGNED_AT_MS = WEBHOOK_VECTOR.timestampSeconds * 1_000;

const clockAt = (ms: number) => ({ now: () => new Date(ms), monotonic: () => ms });

const signed = (over: {
  readonly body?: string;
  readonly signature?: string;
  readonly eventId?: string;
  readonly topic?: string;
}): Request =>
  new Request('https://app.test/api/webhooks/billing', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [WEBHOOK_ID_HEADER]: over.eventId ?? WEBHOOK_VECTOR.eventId,
      [WEBHOOK_TOPIC_HEADER]: over.topic ?? WEBHOOK_VECTOR.topic,
      [WEBHOOK_SIGNATURE_HEADER]: over.signature ?? WEBHOOK_VECTOR.signature,
    },
    body: over.body ?? WEBHOOK_VECTOR.body,
  });

/** A correctly built signature over the vector's clock, secret and body, for other id/topic pairs. */
const signatureFor = (eventId: string, topic: string): string => {
  const mac = new Bun.CryptoHasher('sha256', WEBHOOK_VECTOR.secret)
    .update(`v1:${WEBHOOK_VECTOR.timestampSeconds}:${eventId}:${topic}:${WEBHOOK_VECTOR.body}`)
    .digest('hex');
  return `t=${WEBHOOK_VECTOR.timestampSeconds},v1=${mac}`;
};

const codeOf = async (request: Request, options?: { readonly nowMs?: number }): Promise<string> => {
  try {
    await verifyWebhookSignature(request, {
      secret: WEBHOOK_VECTOR.secret,
      clock: clockAt(options?.nowMs ?? SIGNED_AT_MS),
    });
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not-an-ultimate-error';
  }
  return 'accepted';
};

describe('verifyWebhookSignature accepts what the sender signed', () => {
  test('the vector verifies and answers the bytes that were signed', async () => {
    const verified = await verifyWebhookSignature(signed({}), {
      secret: WEBHOOK_VECTOR.secret,
      clock: clockAt(SIGNED_AT_MS),
    });

    expect(verified.eventId).toBe(WEBHOOK_VECTOR.eventId);
    expect(verified.topic).toBe(WEBHOOK_VECTOR.topic);
    // The RAW text, never a re-serialisation: `JSON.parse` then `JSON.stringify` reorders keys and
    // drops whitespace, and the sender's bytes are what the MAC covers.
    expect(verified.body).toBe(WEBHOOK_VECTOR.body);
    expect(verified.signedAtMs).toBe(SIGNED_AT_MS);
  });

  test('the header names are part of the wire format', () => {
    expect(WEBHOOK_ID_HEADER).toBe('x-ultimate-webhook-id');
    expect(WEBHOOK_TOPIC_HEADER).toBe('x-ultimate-webhook-topic');
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('x-ultimate-webhook-signature');
  });

  test('a replay inside the window still verifies, and names the id that detects it', async () => {
    // The framework cannot own the seen-set — that is a table in the app's database — so what it
    // owes a receiver is the id to dedupe on, signed so an attacker cannot move it.
    const first = await verifyWebhookSignature(signed({}), {
      secret: WEBHOOK_VECTOR.secret,
      clock: clockAt(SIGNED_AT_MS),
    });
    const second = await verifyWebhookSignature(signed({}), {
      secret: WEBHOOK_VECTOR.secret,
      clock: clockAt(SIGNED_AT_MS + 1_000),
    });

    expect(second.eventId).toBe(first.eventId);
  });
});

describe('verifyWebhookSignature refuses everything else', () => {
  test('a tampered body fails', async () => {
    expect(await codeOf(signed({ body: '{"amount":1000000}' }))).toBe(
      'X_WEBHOOK_SIGNATURE_INVALID',
    );
  });

  test('a body with the same bytes reordered fails', async () => {
    expect(await codeOf(signed({ body: '{ "amount": 100 }' }))).toBe('X_WEBHOOK_SIGNATURE_INVALID');
  });

  test('moving the timestamp without re-signing fails, because the timestamp is inside the mac', async () => {
    const moved = WEBHOOK_VECTOR.signature.replace('t=1700000000', 't=1700000300');
    expect(await codeOf(signed({ signature: moved }), { nowMs: SIGNED_AT_MS + 300_000 })).toBe(
      'X_WEBHOOK_SIGNATURE_INVALID',
    );
  });

  test('a valid signature outside the tolerance window is stale, not invalid', async () => {
    const late = SIGNED_AT_MS + DEFAULT_WEBHOOK_TOLERANCE_MS + 1;
    expect(await codeOf(signed({}), { nowMs: late })).toBe('X_WEBHOOK_SIGNATURE_STALE');
    // The far side too: a sender whose clock runs ahead is the same replay window in reverse.
    const early = SIGNED_AT_MS - DEFAULT_WEBHOOK_TOLERANCE_MS - 1;
    expect(await codeOf(signed({}), { nowMs: early })).toBe('X_WEBHOOK_SIGNATURE_STALE');
  });

  test('the edge of the window is inside it', async () => {
    expect(await codeOf(signed({}), { nowMs: SIGNED_AT_MS + DEFAULT_WEBHOOK_TOLERANCE_MS })).toBe(
      'accepted',
    );
  });

  test('a signature from another secret fails', async () => {
    let thrown: unknown;
    try {
      await verifyWebhookSignature(signed({}), {
        secret: 'whsec_other_key',
        clock: clockAt(SIGNED_AT_MS),
      });
    } catch (error) {
      thrown = error;
    }
    expect(isUltimateError(thrown) ? thrown.code : undefined).toBe('X_WEBHOOK_SIGNATURE_INVALID');
  });

  test('a separator in an id or a topic is refused, because one mac would label two deliveries', async () => {
    // The attack this guard exists for: ONE mac, over `v1:<t>:evt:01HZ:orders.paid:<body>`, is
    // equally valid for (id `evt`, topic `01HZ:orders.paid`) and for (id `evt:01HZ`, topic
    // `orders.paid`). A receiver routing on the topic can then be handed the sender's own
    // signature under a label the sender never wrote. Refusing the separator is what collapses
    // the two readings to none; without it BOTH requests below verify.
    const ambiguous = `v1:${WEBHOOK_VECTOR.timestampSeconds}:evt:01HZ:orders.paid:${WEBHOOK_VECTOR.body}`;
    const mac = new Bun.CryptoHasher('sha256', WEBHOOK_VECTOR.secret)
      .update(ambiguous)
      .digest('hex');
    const signature = `t=${WEBHOOK_VECTOR.timestampSeconds},v1=${mac}`;

    expect(await codeOf(signed({ signature, eventId: 'evt', topic: '01HZ:orders.paid' }))).toBe(
      'X_WEBHOOK_SIGNATURE_INVALID',
    );
    expect(await codeOf(signed({ signature, eventId: 'evt:01HZ', topic: 'orders.paid' }))).toBe(
      'X_WEBHOOK_SIGNATURE_INVALID',
    );
  });

  test('an empty or oversized id or topic is refused even when it IS signed', async () => {
    // Signed correctly, so the mac cannot be what refuses these — the field rule is. An empty
    // event id leaves a receiver with no dedupe key at all, and an unbounded one is a canonical
    // string a sender chooses the length of.
    const long = 'x'.repeat(201);
    expect(
      await codeOf(signed({ eventId: '', signature: signatureFor('', WEBHOOK_VECTOR.topic) })),
    ).toBe('X_WEBHOOK_SIGNATURE_INVALID');
    expect(
      await codeOf(signed({ topic: long, signature: signatureFor(WEBHOOK_VECTOR.eventId, long) })),
    ).toBe('X_WEBHOOK_SIGNATURE_INVALID');
  });

  test('a non-numeric timestamp is refused even when the mac over it is correct', async () => {
    // Not an outsider's attack — only the secret holder can build this — and it is still a hole:
    // `Number('later')` is `NaN`, and `Math.abs(NaN) > toleranceMs` is FALSE, so a sender could
    // opt itself out of the replay window entirely and hand the app a `signedAtMs` of `NaN`.
    const mac = new Bun.CryptoHasher('sha256', WEBHOOK_VECTOR.secret)
      .update(`v1:later:${WEBHOOK_VECTOR.eventId}:${WEBHOOK_VECTOR.topic}:${WEBHOOK_VECTOR.body}`)
      .digest('hex');
    expect(await codeOf(signed({ signature: `t=later,v1=${mac}` }))).toBe(
      'X_WEBHOOK_SIGNATURE_INVALID',
    );
  });

  test('a missing or malformed signature header fails', async () => {
    for (const signature of ['', 'v1=abc', 't=1700000000', 't=nope,v1=abc', 'garbage']) {
      expect(await codeOf(signed({ signature }))).toBe('X_WEBHOOK_SIGNATURE_INVALID');
    }
    const bare = new Request('https://app.test/api/webhooks/billing', {
      method: 'POST',
      body: WEBHOOK_VECTOR.body,
    });
    expect(await codeOf(bare)).toBe('X_WEBHOOK_SIGNATURE_INVALID');
  });

  test('a body past the cap is refused while it is read, not after', async () => {
    const request = new Request('https://app.test/api/webhooks/billing', {
      method: 'POST',
      headers: {
        [WEBHOOK_ID_HEADER]: WEBHOOK_VECTOR.eventId,
        [WEBHOOK_TOPIC_HEADER]: WEBHOOK_VECTOR.topic,
        [WEBHOOK_SIGNATURE_HEADER]: WEBHOOK_VECTOR.signature,
      },
      body: 'x'.repeat(2_048),
    });
    let thrown: unknown;
    try {
      await verifyWebhookSignature(request, {
        secret: WEBHOOK_VECTOR.secret,
        clock: clockAt(SIGNED_AT_MS),
        maxBytes: 1_024,
      });
    } catch (error) {
      thrown = error;
    }
    expect(isUltimateError(thrown) ? thrown.code : undefined).toBe('X_BODY_INVALID');
  });
});

describe('a refusal never carries the secret or the signature', () => {
  test('neither cause nor fix quotes a credential', async () => {
    let thrown: unknown;
    try {
      await verifyWebhookSignature(signed({ body: 'tampered' }), {
        secret: WEBHOOK_VECTOR.secret,
        clock: clockAt(SIGNED_AT_MS),
      });
    } catch (error) {
      thrown = error;
    }
    if (!isUltimateError(thrown)) return expect.unreachable('expected an UltimateError');
    const rendered = `${thrown.cause} ${thrown.fix} ${JSON.stringify(thrown.meta ?? {})}`;
    expect(rendered).not.toContain(WEBHOOK_VECTOR.secret);
    expect(rendered).not.toContain('d0c20033');
  });
});

/**
 * `toleranceMs` IS the replay window. `skewMs > NaN` is false, so a non-finite tolerance does not
 * widen the window — it removes it, and a correctly signed webhook captured a year ago verifies
 * forever. `Number(process.env.WEBHOOK_TOLERANCE_MS)` on an unset variable is how it arrives, and
 * nothing downstream can notice: the signature is valid, so every other check passes.
 */
describe('the replay window is screened before it is compared against', () => {
  const verifyWith = async (toleranceMs: number, nowMs: number): Promise<string> => {
    try {
      await verifyWebhookSignature(signed({}), {
        secret: WEBHOOK_VECTOR.secret,
        clock: clockAt(nowMs),
        toleranceMs,
      });
    } catch (error) {
      return isUltimateError(error) ? error.code : 'not-an-ultimate-error';
    }
    return 'accepted';
  };

  const A_YEAR_LATER = SIGNED_AT_MS + 365 * 24 * 60 * 60 * 1000;

  test('a tolerance that is not a number is refused, never an unbounded window', async () => {
    for (const toleranceMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(await verifyWith(toleranceMs, A_YEAR_LATER)).toBe('X_CONFIG_INVALID');
    }
  });

  test('zero is a window a deployment may choose: only a same-instant signature passes', async () => {
    expect(await verifyWith(0, SIGNED_AT_MS)).toBe('accepted');
    expect(await verifyWith(0, SIGNED_AT_MS + 1)).toBe('X_WEBHOOK_SIGNATURE_STALE');
  });

  /**
   * The body cap is the SECOND bound on this path and it was closed only at the far end:
   * `readWithinLimit` refuses a non-finite limit with core's `X_INVARIANT`, whose `fix:` names
   * core's reader rather than the `maxBytes` the caller wrote. Refused here too, which is the
   * layered form `backfill()` and `inBatches()` already use.
   */
  test('a body cap that is not a usable byte count is refused, naming maxBytes', async () => {
    const capOf = async (maxBytes: number): Promise<string> => {
      try {
        await verifyWebhookSignature(signed({}), {
          secret: WEBHOOK_VECTOR.secret,
          clock: clockAt(SIGNED_AT_MS),
          maxBytes,
        });
      } catch (error) {
        return isUltimateError(error) ? error.code : 'not-an-ultimate-error';
      }
      return 'accepted';
    };
    for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      expect(await capOf(maxBytes)).toBe('X_CONFIG_INVALID');
    }
    expect(await capOf(DEFAULT_WEBHOOK_BODY_LIMIT)).toBe('accepted');
  });

  test('the shipped default still accepts a fresh delivery and refuses a stale one', async () => {
    expect(await verifyWith(DEFAULT_WEBHOOK_TOLERANCE_MS, SIGNED_AT_MS)).toBe('accepted');
    expect(await verifyWith(DEFAULT_WEBHOOK_TOLERANCE_MS, A_YEAR_LATER)).toBe(
      'X_WEBHOOK_SIGNATURE_STALE',
    );
  });
});
