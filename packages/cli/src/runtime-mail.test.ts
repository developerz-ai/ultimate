// `mail.retainMime` from `app.config.ts` reaches the driver the boot selects — proven by the
// refusal only the driver can raise, Resend refusing retention at all — and the ceiling is the
// boot's verdict whatever transport env selects.
import { describe, expect, test } from 'bun:test';
import { defineConfig } from '@ultimat3/core';
import { RETAIN_MIME_CEILING_BYTES } from '@ultimat3/mail';
import { mailSelectOptionsOf, selectAppMailDriver } from './runtime-mail';

const SMTP = { SMTP_URL: 'smtp://user:pass@127.0.0.1:2525', MAIL_FROM: 'App <a@b.test>' };
const RESEND = { RESEND_API_KEY: 're_test', MAIL_FROM: 'App <a@b.test>' };

const config = (retainMime: boolean | { maxBytes?: number }) =>
  defineConfig({ name: 'app', mail: { retainMime } });

const refusal = (call: () => unknown): { code?: unknown; cause?: unknown } => {
  try {
    call();
  } catch (error) {
    return error as { code?: unknown; cause?: unknown };
  }
  return expect.unreachable('the driver accepted it');
};

describe('unit · mail.retainMime reaches selectMailDriver', () => {
  test('off, or no config file, passes no retainMime at all', () => {
    expect(mailSelectOptionsOf(undefined)).toEqual({});
    expect(mailSelectOptionsOf(defineConfig({ name: 'app' }))).toEqual({});
  });

  test('on is retainMime, with the cap only when the config names one', () => {
    expect(mailSelectOptionsOf(config(true))).toEqual({ retainMime: {} });
    expect(mailSelectOptionsOf(config({ maxBytes: 4096 }))).toEqual({
      retainMime: { maxBytes: 4096 },
    });
  });

  test('Resend refuses retention it cannot honour — the option got there', () => {
    expect(selectAppMailDriver(RESEND, undefined).detail).toBe('RESEND_API_KEY');
    expect(refusal(() => selectAppMailDriver(RESEND, config(true))).code).toBe('X_CONFIG_INVALID');
  });

  test('SMTP builds with a cap under the ceiling', () => {
    expect(selectAppMailDriver(SMTP, config({ maxBytes: 4096 })).detail).toBe('SMTP_URL');
  });

  // The cap is checked by the transports that retain, so with no SMTP or SES selected a cap above
  // the ceiling booted — and refused the boot the day SMTP_URL was set. One config, one verdict:
  // the boot refuses it whatever transport env selects.
  test('a cap above the ceiling refuses the boot with no transport selected, naming the key', () => {
    const above = refusal(() =>
      selectAppMailDriver({}, config({ maxBytes: RETAIN_MIME_CEILING_BYTES + 1 })),
    );
    expect(above.code).toBe('X_CONFIG_INVALID');
    expect(String(above.cause)).toContain('mail.retainMime.maxBytes');
    expect(
      selectAppMailDriver({}, config({ maxBytes: RETAIN_MIME_CEILING_BYTES })).detail,
    ).toBeDefined();
  });
});
