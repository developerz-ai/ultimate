// The `smsTransport` slot: memory in development and test, a coded refusal elsewhere, an installed
// transport winning until its own release — and the E.164 check every transport makes.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  assertSmsNumber,
  installSmsTransport,
  isSmsNumber,
  memorySmsTransport,
  resetSmsTransport,
  smsTransport,
} from './sms-transport';

const saved = { ultimate: Bun.env['ULTIMATE_ENV'] };

afterEach(() => {
  if (saved.ultimate === undefined) delete Bun.env['ULTIMATE_ENV'];
  else Bun.env['ULTIMATE_ENV'] = saved.ultimate;
  resetSmsTransport();
});

const message = { to: '+4915112345678', body: 'hi', idempotencyKey: 'k1' };

describe('unit · the smsTransport slot', () => {
  for (const environment of ['production', 'staging'] as const) {
    test(`${environment}: the default refuses with X_NOTIFY_SMS_TRANSPORT_MISSING`, async () => {
      Bun.env['ULTIMATE_ENV'] = environment;
      const refused = await smsTransport()
        .send(message)
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(refused).toBeUltimateError('X_NOTIFY_SMS_TRANSPORT_MISSING');
      expect(String((refused as { fix: unknown }).fix)).toContain('runtime.ts');
    });
  }

  test('test: the default is the memory transport, and answers', async () => {
    Bun.env['ULTIMATE_ENV'] = 'test';
    expect(await smsTransport().send(message)).toMatchObject({ to: message.to });
  });

  test('an installed transport wins until its own release', async () => {
    Bun.env['ULTIMATE_ENV'] = 'production';
    const installed = memorySmsTransport('installed');
    const release = installSmsTransport(installed);
    expect((await smsTransport().send(message)).transport).toBe('installed');
    expect(installed.sent).toHaveLength(1);
    release();
    await expect(smsTransport().send(message)).rejects.toThrow(/X_NOTIFY_SMS_TRANSPORT_MISSING/);
  });
});

describe('unit · E.164', () => {
  test('a number is +, a country code, at most 15 digits', () => {
    expect(['+4915112345678', '+14155550123', '+999999999999999'].map(isSmsNumber)).toEqual([
      true,
      true,
      true,
    ]);
    for (const bad of ['015112345678', '+0151', '+49 151 123', '+1234567890123456', '', '+']) {
      expect(isSmsNumber(bad)).toBe(false);
    }
  });

  test('a refusal names the recipient and never the number', () => {
    let thrown: unknown;
    try {
      assertSmsNumber('0151 9876543', 'ana');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUltimateError('X_NOTIFY_SMS_NUMBER_INVALID');
    expect(JSON.stringify(thrown)).not.toContain('9876543');
    expect((thrown as { meta?: unknown }).meta).toEqual({ recipient: 'ana' });
  });
});
