// An app-declared verification purpose runs the built-ins' one code path: single use, its own key
// space (a token for one purpose never consumes another's), and a name declared once. Beside
// `verify.test.ts`, which pins the two built-ins and is already at the line ceiling.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { AuthError } from './errors';
import { memoryAuthAdapter } from './memory-adapter';
import { randomToken } from './tokens';
import { verificationPurposeNames } from './verification-purposes';
import {
  consumeVerification,
  defineVerificationPurpose,
  issueVerification,
  type MailSender,
  passwordReset,
  type VerificationRuntime,
} from './verify';

const sent: string[] = [];
const mail: MailSender = {
  async send(template) {
    sent.push(template);
  },
};
const runtime = (): VerificationRuntime => ({
  store: memoryAuthAdapter(),
  clock: frozenClock(0),
  mail,
});

const refusal = async (run: () => Promise<unknown>): Promise<AuthError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof AuthError) return error;
    throw error;
  }
  return expect.unreachable('the call resolved instead of refusing');
};

/** Unique per run: the registry is process-wide and `bun test` shares one process. */
const uniqueName = (stem: string): string => `${stem}-${randomToken(6)}`;

describe('defineVerificationPurpose', () => {
  test('a custom purpose mails its template and is single use', async () => {
    const invite = defineVerificationPurpose({
      name: uniqueName('member-invite'),
      template: 'auth.member-invite',
      ttlMs: 60_000,
    });
    const rt = runtime();
    const issued = await invite.issue(rt, { identifier: 'Ada@X.test', locale: 'en' });
    expect(sent.at(-1)).toBe('auth.member-invite');
    const record = await invite.consume(rt, { identifier: 'ada@x.test', token: issued.token });
    expect(record.purpose).toBe(invite.name);
    const again = await refusal(() =>
      invite.consume(rt, { identifier: 'ada@x.test', token: issued.token }),
    );
    expect(again.code).toBe('X_UNAUTHENTICATED');
  });

  test("a custom purpose's token cannot consume another purpose's, either way", async () => {
    const invite = defineVerificationPurpose({
      name: uniqueName('member-invite'),
      template: 'auth.member-invite',
      ttlMs: 60_000,
    });
    const rt = runtime();
    const reset = await passwordReset.issue(rt, { identifier: 'a@x.test', locale: 'en' });
    const invited = await invite.issue(rt, { identifier: 'a@x.test', locale: 'en' });
    const crossed = await refusal(() =>
      invite.consume(rt, { identifier: 'a@x.test', token: reset.token }),
    );
    expect(crossed.code).toBe('X_UNAUTHENTICATED');
    const back = await refusal(() =>
      passwordReset.consume(rt, { identifier: 'a@x.test', token: invited.token }),
    );
    expect(back.code).toBe('X_UNAUTHENTICATED');
    // Neither wrong guess spent the right token.
    await passwordReset.consume(rt, { identifier: 'a@x.test', token: reset.token });
    await invite.consume(rt, { identifier: 'a@x.test', token: invited.token });
  });

  test('a name declared twice is refused, and so is an empty template', () => {
    const name = uniqueName('email-change');
    defineVerificationPurpose({ name, template: 'auth.email-change', ttlMs: 1_000 });
    expect(() => defineVerificationPurpose({ name, template: 'auth.other', ttlMs: 1_000 })).toThrow(
      expect.objectContaining({ code: 'X_VERIFICATION_PURPOSE_INVALID' }),
    );
    expect(() =>
      defineVerificationPurpose({ name: uniqueName('x'), template: ' ', ttlMs: 1_000 }),
    ).toThrow(expect.objectContaining({ code: 'X_VERIFICATION_PURPOSE_INVALID' }));
    expect(() =>
      defineVerificationPurpose({ name: 'password-reset', template: 'a', ttlMs: 1_000 }),
    ).toThrow(expect.objectContaining({ code: 'X_VERIFICATION_PURPOSE_INVALID' }));
  });

  test('an undeclared purpose is refused on both doors, before any write', async () => {
    const rt = runtime();
    const issued = await refusal(() =>
      issueVerification(rt, { purpose: '__proto__', identifier: 'a@x.test', locale: 'en' }),
    );
    expect(issued.code).toBe('X_VERIFICATION_PURPOSE_UNKNOWN');
    const consumed = await refusal(() =>
      consumeVerification(rt, { purpose: 'toString', identifier: 'a@x.test', token: 't' }),
    );
    expect(consumed.code).toBe('X_VERIFICATION_PURPOSE_UNKNOWN');
  });

  test('the two built-ins are instances in the same registry', () => {
    expect(verificationPurposeNames()).toEqual(
      expect.arrayContaining(['email-verify', 'password-reset']),
    );
  });
});
