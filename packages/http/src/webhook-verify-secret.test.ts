// The receiver's secret is screened before any byte is read. An empty key is not a weak key, it is
// NO key: an HMAC under '' is a mac anyone can compute, so a receiver whose secret is an unset
// environment variable would accept every forged delivery. The sender refuses the same secret
// (`@ultimat3/jobs` `assertDeliverable`), so this is the inbound half of one rule.

import { describe, expect, test } from 'bun:test';
import {
  isUltimateError,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TOPIC_HEADER,
} from '@ultimat3/core';
import { verifyWebhookSignature } from './webhook-verify';

const SIGNED_AT_SECONDS = 1_700_000_000;
const BODY = '{"amount":100}';

/** A delivery an attacker signed with the key a misconfigured receiver holds: none. */
const forgedWith = (key: string): Request => {
  const mac = new Bun.CryptoHasher('sha256', key)
    .update(`v1:${SIGNED_AT_SECONDS}:evt_forged:orders.paid:${BODY}`)
    .digest('hex');
  return new Request('https://app.test/api/webhooks/billing', {
    method: 'POST',
    headers: {
      [WEBHOOK_ID_HEADER]: 'evt_forged',
      [WEBHOOK_TOPIC_HEADER]: 'orders.paid',
      [WEBHOOK_SIGNATURE_HEADER]: `t=${SIGNED_AT_SECONDS},v1=${mac}`,
    },
    body: BODY,
  });
};

const clock = {
  now: () => new Date(SIGNED_AT_SECONDS * 1_000),
  monotonic: () => SIGNED_AT_SECONDS * 1_000,
};

const outcome = async (secret: unknown): Promise<string> => {
  try {
    // `unknown` on purpose: an untyped caller passing `process.env.WEBHOOK_SECRET` is the case.
    await verifyWebhookSignature(forgedWith(''), { secret: secret as string, clock });
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not-an-ultimate-error';
  }
  return 'accepted';
};

describe('a receiver with no secret refuses, never verifies against an empty key', () => {
  test('an empty secret is a config error, not an accepted forgery', async () => {
    expect(await outcome('')).toBe('X_CONFIG_INVALID');
  });

  test('a missing or non-string secret is refused the same way', async () => {
    for (const secret of [undefined, null, 42, {}]) {
      expect(await outcome(secret)).toBe('X_CONFIG_INVALID');
    }
  });

  test('the refusal names the option and never renders a value', async () => {
    try {
      await verifyWebhookSignature(forgedWith(''), { secret: '', clock });
      expect.unreachable('an empty secret verified a delivery');
    } catch (error) {
      if (!isUltimateError(error)) throw error;
      expect(error.meta).toMatchObject({ option: 'webhook secret' });
      expect(error.fix).toContain('secret');
    }
  });
});
