// The reference transport passes its own port's suite, and the suite is not vacuously green: a
// transport that skips the E.164 check, or leaks the number into its id, fails a named check.

import { describe, expect, test } from 'bun:test';
import { memorySmsTransport } from '@ultimat3/notify';
import type { SmsTransport } from '@ultimat3/notify/adapter';
import { behavesLike } from './shared-examples';
import { SMS_TRANSPORT_CHECKS, smsTransportConformance } from './sms-transport-conformance';

describe('memorySmsTransport', () => {
  behavesLike(smsTransportConformance, () => memorySmsTransport());
});

const failing = async (transport: SmsTransport): Promise<string[]> => {
  const failed: string[] = [];
  for (const check of SMS_TRANSPORT_CHECKS) {
    await check.run(transport).catch(() => failed.push(check.name));
  }
  return failed;
};

describe('unit · the SMS suite can fail', () => {
  test('a transport that checks no number fails the E.164 check alone', async () => {
    const memory = memorySmsTransport();
    const lax: SmsTransport = {
      name: 'lax',
      send: (message) =>
        Promise.resolve({
          transport: 'lax',
          id: crypto.randomUUID(),
          to: message.to,
          idempotencyKey: message.idempotencyKey,
        }),
    };
    expect(await failing(memory)).toEqual([]);
    expect(await failing(lax)).toEqual([
      'a number that is not E.164 is refused with X_NOTIFY_SMS_NUMBER_INVALID',
    ]);
  });

  test('a transport that puts the number in its id fails the leak check', async () => {
    const memory = memorySmsTransport();
    const leaky: SmsTransport = {
      name: 'leaky',
      send: async (message) => ({
        ...(await memory.send(message)),
        transport: 'leaky',
        id: `sent-${message.to}`,
      }),
    };
    expect(await failing(leaky)).toEqual(['the result id carries neither the number nor the body']);
  });
});
